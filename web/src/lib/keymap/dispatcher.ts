import { DEFAULT_RESOLVED_KEYBINDINGS, type ShortcutCommand } from "./defaults";
import { resolveCommand, type ShortcutContext } from "./engine";

/** Return `false` to let the next (older) scope have the event. */
export type CommandHandler = (event: KeyboardEvent) => boolean | void;
export type CommandHandlers = Partial<Record<ShortcutCommand, CommandHandler>>;

export type ScopeOptions = {
  /** Read at event time; a scope whose guard fails is skipped. */
  when?: (event: KeyboardEvent) => boolean;
  /** Extra `when` context only this scope knows (a panel being open), read at event time. */
  context?: () => ShortcutContext;
  /** Run before focused widgets that swallow keys themselves (the terminal). */
  capture?: boolean;
};

type Scope = { commands: CommandHandlers; options: ScopeOptions };

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const TERMINAL = ".xterm, [data-terminal]";

// Newest scope wins within each list.
const bubbleScopes: Scope[] = [];
const captureScopes: Scope[] = [];
const sharedContext = new Map<string, number>();

/** `navigator.userAgentData` where it exists, `navigator.platform` otherwise. Empty on the server. */
export function currentPlatform(): string {
  if (typeof navigator === "undefined") return "";
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return data?.platform || navigator.platform || "";
}

function deepActive(target: EventTarget | null): Element | null {
  let element = typeof Element !== "undefined" && target instanceof Element ? target : null;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

/** What the DOM can tell us right now, plus whatever screens have switched on. */
export function readShortcutContext(target: EventTarget | null = typeof document === "undefined" ? null : document.activeElement): ShortcutContext {
  const active = deepActive(target);
  const context: ShortcutContext = {
    isWeb: true,
    isDesktop: false,
    editableFocus: active?.closest(EDITABLE) != null,
    terminalFocus: active?.closest(TERMINAL) != null,
  };
  for (const [name, count] of sharedContext) if (count > 0) context[name] = true;
  return context;
}

/** Switches a context name on until the returned function runs. Counted, so nested owners are safe. */
export function holdShortcutContext(name: string): () => void {
  sharedContext.set(name, (sharedContext.get(name) ?? 0) + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const next = (sharedContext.get(name) ?? 1) - 1;
    if (next > 0) sharedContext.set(name, next);
    else sharedContext.delete(name);
  };
}

function runScope(scope: Scope, event: KeyboardEvent, platform: string): boolean {
  if (scope.options.when && !scope.options.when(event)) return false;
  const context = { ...readShortcutContext(event.target), ...scope.options.context?.() };
  const command = resolveCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, { platform, context });
  const handler = command ? scope.commands[command] : undefined;
  if (!handler) return false;
  // Held keys repeat; a toggle that flips twenty times a second helps nobody.
  const handled = event.repeat || handler(event) !== false;
  if (handled) event.preventDefault();
  return handled;
}

function runScopes(scopes: readonly Scope[], event: KeyboardEvent): void {
  if (event.isComposing) return;
  const platform = currentPlatform();
  for (let i = scopes.length - 1; i >= 0; i--) {
    // Something focused (an editor's own mod+b) already took it.
    if (event.defaultPrevented) return;
    if (runScope(scopes[i]!, event, platform)) return;
  }
}

const onCapture = (event: KeyboardEvent) => runScopes(captureScopes, event);
const onBubble = (event: KeyboardEvent) => runScopes(bubbleScopes, event);
let installed = false;

/** Registers handlers for some commands. Returns the unregister function. */
export function registerCommands(commands: CommandHandlers, options: ScopeOptions = {}): () => void {
  if (!installed && typeof window !== "undefined") {
    installed = true;
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("keydown", onBubble);
  }
  const list = options.capture ? captureScopes : bubbleScopes;
  const scope: Scope = { commands, options };
  list.push(scope);
  return () => {
    const index = list.lastIndexOf(scope);
    if (index !== -1) list.splice(index, 1);
  };
}
