# t3code UX reference (for rebuilding in Next.js 16 + Tailwind 4)

Source: https://github.com/pingdotgg/t3code, shallow clone at commit `dac8b11ddc25bd5da62a367fdb6c3de777ae2986`. All paths are relative to that repo's root. `path:Lx-Ly` means a line range in that file. Code blocks marked with a path header are verbatim copies pulled with `sed -n` from those line ranges, never retyped. Everything else is a summary of that code.

Who this is for: an implementation agent rebuilding t3code's UX patterns in our app (`web/`, Next.js 16 App Router + Tailwind 4 + Bun) without opening the t3code repo. Our screens are defined in `docs/spec.md` sections 3 and 4.

How to read it:
- Sections 1-11 cover what the brief asked for. Each one starts with a plain summary, followed by the verbatim code that backs it.
- Section 12, "Mapping to our screens", turns those patterns into decisions for our task composer, mission control, workforce list and sidebar.
- The full raw research notes sit next to this file in `docs/research/t3code-notes/`, about 27k lines of cited, verbatim quotes. Look there before guessing at a detail this doc leaves out.

## TL;DR: the patterns that make t3code feel like t3code

1. **The composer is a floating glass card, not a textarea at the bottom of a page.** It's a Tiptap editor that autosizes from 2 lines up to `max-h-52` (13rem), then scrolls inside. It sits in a `rounded-2xl` card with a 1px outline and a soft `shadow-composer`, overlaid on the bottom of the timeline and capped at `--chat-content-max-width: 46rem`. Inline footer controls read as one phrase ("Opus 5.5 High"): borderless text buttons for model, effort, mode, plus a 36px round send button that morphs into Stop, Steer or Queue depending on run state.
2. **Enter sends. Typing while the agent runs steers it.** Cmd/Ctrl flips that to queue, and the send icon previews the swap live while the modifier is held. IME composition and key repeat never send. `@` files, `/` commands, `$` skills and `#` PRs open one shared suggestion menu anchored above the card.
3. **The sidebar is an inbox of threads, not a folder tree.** Sections run Pinned, Active, then collapsible Working, Snoozed and Settled shelves pinned to the bottom. Projects are a filter. Each row shows the project favicon, the title, and a status slot (Approval / Input / Working 42s / Failed / Done) that swaps to hover actions (snooze, settle). The sidebar resizes (256px default, 208px min, keeps 640px for main content), collapses offcanvas with `mod+b`, and is fully keyboard navigable as an ARIA tree.
4. **Project identity is a real favicon or a deterministic monogram.** The server probes 23 well-known icon paths plus `<link rel="icon">` tags in the repo, with path-traversal guards and caching. The fallback is a 2-letter monogram on a 14% tint of one of 18 hashed hues. Projects stay recognizable at 16px.
5. **Dense, quiet, keyboard-first.** System font plus Inter, 14px prompt, `text-2xs` (11px) metadata, zinc ladder in light and true black in dark, one indigo primary, lucide icons at stroke 1.75. Over 70 default shortcuts come from a custom `mod+key` + `when`-clause engine. Hints appear in tooltips as `(⌘B)`, and holding ⌘ reveals jump numbers on sidebar rows.

## 1. License and reuse

`LICENSE` (repo root) is MIT, copyright holder "T3 Tools Inc." Standard MIT text: use, copy, modify, merge, publish, distribute, sublicense, sell, on the condition that "the above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software."

What that means for us:
- We can copy components, CSS, logic verbatim. If we copy substantial portions we must ship the MIT notice (keep a `THIRD_PARTY_NOTICES` / licenses page entry naming T3 Tools Inc.).
- The license covers code, not the brand. Do not reuse the T3 name, `T3Wordmark.tsx`, `T3AppIcon.tsx`, `apps/web/public/*` icons, or the "t3-chat" theme name as our identity.
- t3code itself already vendors MIT code from others and tracks it in `third-party-licenses.config.json` (e.g. `"name": "opencode Office viewers"`, `"license": "MIT"`, `"noticeFile": "apps/web/src/components/files/office/LICENSE.opencode"`). Same pattern we should follow.
- Some deps are NOT MIT. `@pierre/diffs` (pinned `1.6.1` in `pnpm-workspace.yaml:59`) and `@pierre/trees` (`1.0.0-beta.6` in `apps/web/package.json`) are Apache-2.0 per the npm registry `license` field. Apache-2.0 is fine to use, it just carries its own NOTICE requirements. `lucide-react` is ISC. `@base-ui/react`, `@tiptap/*`, `@legendapp/list`, `morphicons`, `pele` are MIT (npm registry `license` field).
- Vendored native code with separate licenses: `native/libghostty-vt/LICENSE`, `apps/mobile/modules/*/LICENSE`. We don't need those.

## 2. Tech stack (web + desktop UI)

Monorepo (`package.json` name `@t3tools/monorepo`), pnpm workspace catalog (`pnpm-workspace.yaml`), task runner `vp` (vite-plus).

| Concern | Choice | Source |
|---|---|---|
| Framework | React `19.3.0` (catalog) + Vite (`vp dev` / `vp build`), SPA, not Next.js | `pnpm-workspace.yaml:76-77`, `apps/web/package.json` scripts |
| Desktop | Electron `44.9.3` wrapping the same web app | `apps/desktop/package.json:25` |
| Routing | TanStack Router, file routes in `apps/web/src/routes/*` (generated `routeTree.gen.ts`), `defaultPreload: "intent"` | `apps/web/src/router.ts:1-12` |
| Component library | shadcn registry in `"style": "base-mira"` mode, i.e. shadcn-style components built on **Base UI** (`@base-ui/react ^1.4.1`), not Radix. Extra registries `@coss` (coss.com/ui) and `@spell` (spell.sh) | `apps/web/components.json`, `apps/web/package.json` |
| Styling | Tailwind 4 (`@tailwindcss/vite ^4`), CSS-first config in `apps/web/src/index.css` (`@import "tailwindcss"`, `@theme`, `@utility`, `@custom-variant`). `cn()` = `cva`'s `cx` + `tailwind-merge` extended with `text-2xs..5xs` | `apps/web/src/index.css:1-8`, `apps/web/src/lib/utils.ts` |
| Variants | `class-variance-authority ^0.7.1` | `apps/web/package.json` |
| Client state | `zustand ^5.0.11` (with `persist` middleware for drafts), plus `@effect/atom-react` + `effect 4.0.5` for server-synced state | `apps/web/src/composerDraftStore.ts:86-88`, `apps/web/src/uiStateStore.ts:3` |
| Composer editor | Tiptap 3 (`@tiptap/react ^3.31.3`, ProseMirror) | `apps/web/package.json` |
| Lists / virtualization | `@legendapp/list` `3.3.5` | `pnpm-workspace.yaml:56` |
| Markdown | `react-markdown ^10.1.0`, `remark-gfm`, `remark-math` + `katex`, Mermaid, `dompurify` | `apps/web/package.json` |
| Diffs / file trees | `@pierre/diffs`, `@pierre/trees` | `apps/web/package.json` |
| Drag and drop | `@dnd-kit/core`, `@dnd-kit/sortable` | `apps/web/package.json` |
| Icons | `lucide-react ^0.564.0` + `morphicons ^1.7.1` | `apps/web/package.json`, `components.json` `"iconLibrary": "lucide"` |
| Font | `@fontsource-variable/inter` (Inter Variable) after the system stack | `apps/web/package.json`, `index.css:170-175` |
| Auth | Clerk (`@clerk/react`, `@clerk/electron`) | `apps/web/package.json` |
| Terminal | libghostty compiled to wasm (`build:ghostty-wasm` script, `src/terminal/ghostty`) | `apps/web/package.json` |

Porting note for us (Next.js 16 App Router): everything above except TanStack Router and Vite drops straight in. Base UI, Tailwind 4, zustand, Tiptap, lucide, cva, tailwind-merge all work in client components. Mark composer/sidebar files `"use client"`.


## 3. Main chat composer

Core files: `apps/web/src/components/chat/ChatComposer.tsx` (3536 lines), `apps/web/src/components/ComposerPromptEditorTiptap.tsx`, `apps/web/src/composer-logic.ts`, `apps/web/src/composerDraftStore.ts`, `apps/web/src/components/chat/ComposerPrimaryActions.tsx`, `ComposerFooterControls.tsx`, `ProviderModelPicker.tsx`, `TraitsPicker.tsx`, `ComposerCommandMenu.tsx`, `ComposerAttachmentStrip.tsx`, `apps/web/src/components/composerFooterLayout.ts`.

### 3.1 Behavior summary

**Editor.** Tiptap (`@tiptap/react` + StarterKit) with custom inline atom nodes for mentions, skills, citations and context references. It's a contenteditable with `role="textbox"` and `aria-multiline`. It autosizes from 2 lines (`min-h-[calc(2lh+--spacing(2))]`) up to `max-h-52` (13rem), then scrolls inside with `overflow-y-auto` (`ComposerPromptEditorTiptap.tsx:L1075-L1099`). Rich text (bold, italic, inline code, highlighted code blocks, headings, quotes, lists, task lists) is on by default (`composerRichTextEnabled` default `true`). The stored prompt stays markdown, and markers like `**` show as non-editable widgets while the caret sits on styled text (`apps/web/src/index.css:L2401-L2403`). Prompt font is 14px by default, forced to at least 16px on touch so iOS doesn't zoom. The editor remounts when the draft key or text mode changes.

**Send / stop.** One round button (36px, 32px at `sm`), with state priority in `ComposerPrimaryActions`:
1. Pending agent question: a pill reading "Next question" / "Submit answer(s)" / "Submitting...".
2. Plan follow-up: a "Refine" pill (if there's text), or a split "Implement" pill with a chevron menu holding "Implement in a new thread".
3. Running with nothing typed: a red Stop button (12px rounded-square icon), tooltip "Interrupt".
4. Otherwise the round send button. The icon is a custom up-arrow when idle, a spinner while busy, Play to resume, and Check when editing a queued message. While running it's a morphing icon, `CornerUpRight` (steer) or `ListPlus` (queue).

It's disabled while busy, when the environment is unavailable, or when there's nothing to send. Disabled style is `disabled:bg-foreground/12 disabled:text-muted-foreground`. The aria-label doubles as a status ("Environment disconnected", "Preparing worktree", "Submitting message").

**Enter during a run.** The default `followUpBehavior` is `"steer"`: sending mid-run injects the message into the running turn. Holding Cmd/Ctrl (click or `mod+enter`) flips it to queue, and the button previews the queue icon while the modifier is held (`useShortcutModifierState`). If the turn can't take steering (compaction), it always queues. If an approval is pending, sending declines it and redirects the agent.

**Keys.**
- `sendShortcut` setting: `"enter"` (default) | `"mod-enter-multiline"` | `"mod-enter"`. With `"enter"`, Enter sends and Shift+Enter (or Alt+Enter) inserts a paragraph.
- IME composition (`isComposing || keyCode === 229`) and key repeat never send.
- With the mobile software keyboard open, plain Enter inserts a newline.
- `mod+enter` on a new draft does a background send (sends, then opens a fresh draft). `mod+alt+enter` on an existing thread does "send and start new thread".
- Escape only closes the open suggestion menu. There is no Escape-to-interrupt.
- `alt+arrowup` edits the last queued message (`thread.editQueuedMessage`, `composerFocus`).
- `mod+shift+enter` sends the first queued message now.
- `mod+s` stashes the prompt.
- Shift+Tab toggles Plan/Build.

**Model / harness picker.** A borderless text control in the footer (`h-7`, `rounded-(--control-radius)`): provider icon (`size-4`) plus model name, truncated. Hover brightens the text instead of drawing a box. Tooltip shows the model plus the `mod+shift+m` shortcut. The popover (`max-w-90`, `max-h-86.5`) has:
- a narrow left provider rail (`w-11`) with a Favorites star tab on top
- a "Search models..." combobox and a virtualized list
- rows with a hover star (filled `text-warning` when favorited), a check on the selected model, "New" and "Unavailable" badges, and ⌘1..9 jump labels

Searching mixes providers and hides the rail. `mod+shift+arrowup/down` switches provider tabs. `/model` typed in the composer also opens the picker. On a new draft, shift-select picks several models; the trigger then shows stacked icons and "A, B, N more".

**Effort ("traits") picker.** It sits right after the model name, so they read as one phrase: "Opus 5.5 High". It shows a muted word or a bar glyph, plus a bolt for Fast. The menu has radio groups per provider descriptor plus a Permissions section. `mod+shift+e` opens it. Typing "ultrathink" frames the composer in a rainbow border (`.ultrathink-frame`, `index.css:L2308-L2349`).

**Mode toggles, left to right in the footer:** model picker, effort, then a mode block holding the permissions chip and the Plan/Build toggle. Plan/Build uses `PencilRulerIcon` / `BotIcon`, with labels sr-only below `sm`. It's hidden unless the `planModeEnabled` setting is on, which defaults off. Permissions has 4 runtime modes, opened with `mod+shift+a`. Blocks that don't fit first go icon-only, then collapse right-to-left into an overflow menu. Workspace (current checkout vs new worktree), machine and branch are not in the card. They live in a context strip under it (`BranchToolbar`, `ComposerSurface.ContextStrip`).

**Attachments.**
- Entry points: a paperclip "Attach files" button (hidden `<input type="file" multiple>`), paste, and drag-drop anywhere in the chat pane (overlay "Drop files to attach"). Sidebar row drops are forwarded too.
- Limits: 100 attachments per message, images compressed to fit 10 MB, prompt max 120,000 chars. Pasted text of 32 KB or more auto-folds into `pasted-text.txt` (`mod+shift+v` pastes it inline instead).
- Image types: GIF, HEIC, HEIF, JPEG, PNG, WebP.
- Preview strip: 64px tiles (`h-16 w-16 rounded-lg border border-border/80`) with a black-glass X, upload progress, and retry on failure. Non-media files list as rows (icon, name, size, X).

**Triggers.** Detection runs on the token before the caret (`composer-logic.ts:L251-L293`):
- `/` at token start: slash commands (unless it looks like a path)
- `#`: pull requests
- any currency symbol such as `$`: provider skills (unless it looks like money)
- `@`: workspace files and folders, other threads, and machines

One menu, portaled and anchored above the card (full width minus a 1.375rem inset on each side, overlapping the card top by 1rem+1px), `max-h-72`, items `rounded-lg`. Nothing is highlighted on open. Enter or Tab picks the highlight (or the first item), arrows wrap, Escape closes, and mousedown is prevented so focus stays in the editor.

Slash menu contents:
- built-ins `/model`, `/plan`, `/default`
- provider commands (e.g. `/compact`)
- provider skills as `/skill:<name>`

A file pick inserts `[basename](path) `, which renders as a chip.

**Drafts.** A zustand `persist` store in localStorage under `t3code:composer-drafts:v1` (schema version 9). Writes are debounced 300ms and flushed on `beforeunload`. Drafts are keyed per thread (or per `DraftId` for unsent new threads).
- Persisted: prompt, images as data URLs, file metadata (files come back as "needs reattach"), contexts, per-provider model selection, runtime mode, interaction mode.
- Empty drafts are dropped.
- Threads with unsent drafts get a warning tint and a pen icon in the sidebar.

**Placeholder copy** (`apps/web/src/composerPlaceholder.ts:L1`): `"Ask anything. @ files, $ skills, / commands"`. Context-dependent variants are quoted below: approval pending, question pending, plan follow-up, no project, no provider. The mobile collapsed row reads `"Ask anything..."`. The empty-draft hero headline above the composer reads "What should we build in {project}?".

**Layout layers, outermost first** (`composer.md` section 10):
1. A ChatView overlay centered at `max-w-(--chat-content-max-width)` (46rem).
2. `ComposerSurface.Shell`: a glass `::before` (card color at 80% opacity, blur 12px, saturate 1.14), `rounded-2xl`.
3. `ComposerSurface.Host`: `rounded-2xl shadow-composer` with a 1px `::after` outline. In dark mode there's no shadow, just an inset highlight.
4. A `<form>` holding the banner dock (attached banners overlap the card top) and the card.
5. Main: `rounded-2xl p-px`.
6. Surface: `rounded-2xl`, drag-over `bg-accent/45 ring-1 ring-inset ring-primary/70`.
7. Body: `relative px-4 pb-2 pt-3.5 sm:pt-4`.
8. Footer: `flex min-w-0 flex-nowrap items-center overflow-visible px-2 pb-2`.

**Responsive.** Below 620px of form width (780px with wide actions), the footer goes compact. On `max-sm`, the unfocused composer collapses to one row: a truncated prompt button, up to 3 image thumbs, and a 32px round send button. Tapping expands it and focuses the editor. Controls get 44px touch targets on coarse pointers.

### 3.2 Verbatim evidence

#### 1. Editor tech, autosize, min/max height, scroll

Tiptap (`@tiptap/react` + `StarterKit` + custom inline atom nodes for mentions, skills, citations, context references). The editor is a contenteditable with `role="textbox"` and `aria-multiline`. It autosizes by content: `min-h` is 2 lines (`calc(2lh+--spacing(2))`), `max-h-52` (13rem), and it scrolls internally with `overflow-y-auto`. Rich text (bold, italic, code, code blocks with highlighting, headings, quotes, lists, task lists) is on by default via `composerRichTextEnabled` (default `true`); plain mode drops bold/strike. The editor remounts when the draft key or text mode changes.

`apps/web/src/components/ComposerPromptEditorTiptap.tsx:L13-L16`
```tsx
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { newlineInCode, splitBlockKeepMarks } from "@tiptap/pm/commands";
```

`apps/web/src/components/ComposerPromptEditorTiptap.tsx:L1075-L1099`
```tsx
  const editorAttributes = {
    class: cn(
      "composer-tiptap -m-1 block max-h-52 min-h-[calc(2lh+--spacing(2))] overflow-y-auto p-1 whitespace-pre-wrap wrap-break-word bg-transparent leading-relaxed text-foreground focus:outline-none",
      className,
    ),
    "data-testid": "composer-editor",
    "data-composer-rich-text": richText ? "true" : "false",
    role: "textbox",
    "aria-multiline": "true",
    ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
    ...(disabled ? { "aria-readonly": "true" } : {}),
    ...(!disabled && suggestionListId
      ? {
          "aria-autocomplete": "list",
          "aria-haspopup": "listbox",
          ...(activeSuggestionId
            ? {
                "aria-controls": suggestionListId,
                "aria-activedescendant": activeSuggestionId,
              }
            : {}),
        }
      : {}),
    "aria-placeholder": placeholder,
  };
```

Editor wrapper (font + size tokens, 16px on touch phones to avoid iOS zoom) and the placeholder overlay:

`apps/web/src/components/ComposerPromptEditorTiptap.tsx:L1767-L1772`
```tsx
          <div
            className={cn(
              "relative flow-root font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)",
              containerClassName,
            )}
          >
```

`apps/web/src/components/ComposerPromptEditorTiptap.tsx:L1816-L1825`
```tsx
            {isEmpty && contextRecords.size === 0 && placeholder ? (
              <div
                className={cn(
                  "pointer-events-none absolute inset-0 leading-relaxed text-placeholder",
                  placeholderClassName,
                )}
              >
                {placeholder}
              </div>
            ) : null}
```

`apps/web/src/index.css:L133-L134`
```css
  /* The prompt on phones: iOS zooms into any input under 16px on focus. */
  --font-size-prompt-touch: max(var(--font-size-prompt, 1rem), 16px);
```

Extension set (rich vs plain):

`apps/web/src/components/ComposerPromptEditorTiptap.tsx:L815-L842`
```tsx
function createComposerExtensions(richText: boolean) {
  return [
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      link: false,
      orderedList: false,
      underline: false,
      dropcursor: false,
      gapcursor: false,
      trailingNode: false,
      code: false,
      listKeymap: false,
      undoRedo: { newGroupDelay: COMPOSER_UNDO_GROUP_DELAY },
      italic: false,
      ...(richText ? {} : { bold: false, strike: false }),
    }),
    ComposerUndoGroupingExtension,
    ComposerTextDirectionExtension,
    ComposerMentionExtension,
    ComposerSkillExtension,
    ComposerCitationExtension,
    ComposerContextReferenceExtension,
    ComposerMarkersExtension,
```

Remount key (draft switch or text-mode change):

`apps/web/src/components/ComposerPromptEditorTiptap.tsx:L784-L796`
```tsx
  return (
    <ComposerPromptEditorTiptapInner
      key={`${props.draftKey ?? ""}:${props.literalText ? "literal" : props.richTextEnabled ? "rich" : "plain"}`}
      {...props}
      restoreFocusRef={restoreFocusRef}
      initialExpandedCursor={
        selection?.value === props.value && selection.cursor === props.cursor
          ? selection.expandedCursor
          : expandCollapsedComposerCursor(props.value, props.cursor, props.literalText)
      }
      onChange={onChange}
    />
  );
```

Auto-close of surround characters when text is selected (typing `(` with a selection wraps it):

`apps/web/src/components/ComposerPromptEditorTiptap.tsx:L215-L227`
```tsx
const SURROUND_CLOSE: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  "'": "'",
  '"': '"',
  "“": "”",
  "`": "`",
  "<": ">",
  "«": "»",
  "*": "*",
  _: "_",
};
```

Settings defaults that affect the editor:

`packages/contracts/src/settings.ts:L465-L475`
```ts
  planModeEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  contextWindowMeterEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  composerRichTextEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sendShortcut: Schema.Literals(["enter", "mod-enter-multiline", "mod-enter"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("enter")),
  ),
  followUpBehavior: Schema.Literals(["queue", "steer"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("steer")),
  ),
  proactivePanelsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  showSkillsInSlashMenu: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
```

Multiline detection (used to keep the mobile composer expanded when the prompt wraps):

`apps/web/src/components/chat/useComposerMultilinePrompt.ts:L4-L20`
```ts
function measureComposerMultilinePrompt(body: HTMLElement): boolean | null {
  const editor = body.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  if (!editor || editor.clientWidth === 0) return null;

  const bodyStyle = getComputedStyle(body);
  const expandedWidth =
    body.clientWidth -
    Number.parseFloat(bodyStyle.paddingLeft) -
    Number.parseFloat(bodyStyle.paddingRight);
  const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight);
  const range = document.createRange();
  range.selectNodeContents(editor);
  const bounds = range.getBoundingClientRect();

  // Measure against expanded width to prevent inline actions oscillating collapse.
  return bounds.height > lineHeight + 1 || bounds.width > expandedWidth + 1;
}
```

---


#### 2. Send / stop button: icons, states, disabled/loading, Enter during a run

One round button (36px, 32px at `sm`) that changes by state. Priority order in `ComposerPrimaryActions`:

1. Pending agent question: a pill "Next question" / "Submit answer(s)" / "Submitting..." (plus optional Stop and "Previous").
2. Plan follow-up: pill "Refine" (if text) or split pill "Implement" + chevron menu "Implement in a new thread".
3. Running and nothing typed: red Stop button (12px rounded square icon), tooltip "Interrupt".
4. Otherwise the round send button. Icon: custom up-arrow SVG (idle), spinner (`isSendBusy`), Play (resume), Check (editing queued message), and while running a morphing icon: `CornerUpRight` (steer) or `ListPlus` (queue).

Disabled when busy, send-disabled reason present, environment unavailable, or no sendable content (empty). Disabled style: `disabled:bg-foreground/12 disabled:text-muted-foreground`. Aria label doubles as status ("Environment disconnected", "Preparing worktree", "Submitting message", etc.).

Enter while a run is in progress: the dispatch mode is `steer` by default (`followUpBehavior` default `"steer"`). Holding Cmd/Ctrl (click or `mod+enter`) flips to the alternate (`queue`). If the turn cannot take steering (compaction), it always queues. If an approval is pending, the composer forces `steer` (a send declines the approval and redirects). The button live-previews the queue icon while Cmd/Ctrl is held (`useShortcutModifierState`).

`packages/client-runtime/src/state/composerDispatch.ts:L1-L26`
```ts
export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;

export function resolveComposerDispatchMode(input: {
  readonly running: boolean;
  readonly alternateModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
  /** False while the active turn cannot take steering input, such as during compaction. */
  readonly canSteer?: boolean;
}): ComposerDispatchMode {
  if (!input.running) return "auto";
  if (input.canSteer === false) return "queue";
  const defaultAction = input.activeTurnDefault ?? "steer";
  if (input.alternateModifier) return defaultAction === "queue" ? "steer" : "queue";
  return defaultAction;
}

export function alternateComposerDispatchAction(
  activeTurnDefault?: ActiveTurnComposerAction,
): ActiveTurnComposerAction {
  return resolveComposerDispatchMode({
    running: true,
    alternateModifier: true,
    ...(activeTurnDefault === undefined ? {} : { activeTurnDefault }),
  }) as ActiveTurnComposerAction;
}
```

`apps/web/src/components/chat/ChatComposer.tsx:L1151-L1158`
```tsx
  const isComposerApprovalState = activePendingApproval !== null;
  // A send declines the approvals shown here to redirect the agent, so it steers the waiting
  // turn instead of queueing behind it. Approvals the typing guard holds stay unseen and pending.
  const followUpBehavior = pendingApprovals.some(
    (approval) => !heldRequestIds.has(approval.requestId),
  )
    ? "steer"
    : settings.followUpBehavior;
```

Button click handler (Cmd/Ctrl-click = alternate):

`apps/web/src/components/chat/ChatComposer.tsx:L2105-L2116`
```tsx
  const handleSubmitMessage = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    submitComposer(
      event,
      resolveComposerDispatchMode({
        running: phase === "running",
        alternateModifier: event.metaKey || event.ctrlKey,
        activeTurnDefault: followUpBehavior,
        canSteer: !isCompacting,
      }),
    );
  };
```

Submit guards (toasts while an image is still compressing or context is still resolving):

`apps/web/src/components/chat/ChatComposer.tsx:L2043-L2103`
```tsx
  const submitComposer = (
    event?: { preventDefault: () => void },
    dispatchMode?: ComposerDispatchMode,
    submissionIntent?: ComposerSubmissionIntent,
  ) => {
    if (
      noProviderAvailable ||
      isSendDisabled ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    ) {
      event?.preventDefault();
      return;
    }
    // A send while a pasted image is still compressing would strand that image:
    // the turn snapshot wouldn't include it, and it would surface in the *next*
    // draft instead.
    if (activeThreadId && countPreparingComposerImages(attachmentTargetKey) > 0) {
      event?.preventDefault();
      toastManager.add({
        type: "info",
        title: "Still compressing a pasted image.",
        description: "Send again once its thumbnail appears.",
      });
      return;
    }
    if (pendingDraftWork.has(attachmentTargetKey)) {
      event?.preventDefault();
      toastManager.add({
        type: "info",
        title: "Still bringing attached context into this message.",
        description: "Send again once its chip resolves.",
      });
      return;
    }
    const submission = submitComposerDraft({
      prompt: promptRef.current,
      submissionTarget: activePendingProgress ? "pending-user-input" : "provider-turn",
      event,
      onSend: (sendEvent) => {
        providerInputRejectedRef.current = false;
        onSend(
          sendEvent,
          dispatchMode ??
            resolveComposerDispatchMode({
              running: phase === "running",
              alternateModifier: false,
              activeTurnDefault: followUpBehavior,
              canSteer: !isCompacting,
            }),
          submissionIntent,
        );
        return !providerInputRejectedRef.current;
      },
    });
    setComposerSubmissionError(submission.validationMessage);
    if (!submission.didDispatch) return;
    onTypingGuardSend();
    if (shouldBlurMobileComposerOnSubmit()) {
      blurMobileComposerAfterSend();
    }
  };
```

Send-disabled reasons computed in the composer, plus those passed from ChatView:

`apps/web/src/components/chat/ChatComposer.tsx:L917-L924`
```tsx
  const sendDisabledReason =
    externalSendDisabledReason ??
    (multipleModelSelections?.length === 0 ? "Select at least one model." : null) ??
    (activePendingProgress
      ? attachmentBlockReason
      : (attachmentBlockReason ??
        (multipleModelSelections === null ? providerSendBlockReason : null)));
  const isSendDisabled = sendDisabledReason !== null;
```

`apps/web/src/components/ChatView.tsx:L3503-L3517`
```tsx
                              sendDisabledReason={
                                !canOperateThread
                                  ? "This connection cannot change threads."
                                  : isEnvironmentChanging
                                    ? "Preparing machine"
                                    : isRevertingCheckpoint
                                      ? "Rewinding conversation"
                                      : feedbackUploading
                                        ? "Sending feedback"
                                        : threadDetailLoading
                                          ? "Messages loading"
                                          : worktreeSetupBlocksSend
                                            ? "Preparing worktree"
                                            : projectCloneSendBlockReason
                              }
```

Full primary-actions component (all states, icons, classNames):

`apps/web/src/components/chat/ComposerPrimaryActions.tsx:L57-L80`
```tsx
const formatPendingPrimaryActionLabel = (input: {
  compact: boolean;
  isLastQuestion: boolean;
  isResponding: boolean;
  questionIndex: number;
}) => {
  if (input.isResponding) {
    return "Submitting...";
  }
  if (input.compact) {
    return input.isLastQuestion ? "Submit" : "Next";
  }
  if (!input.isLastQuestion) {
    return "Next question";
  }
  return input.questionIndex > 0 ? "Submit answers" : "Submit answer";
};

const messageActionPillClassName =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-message-action font-medium text-base text-message-action-foreground shadow-xs shadow-message-action/24 outline-none hover:bg-message-action-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none sm:text-sm";

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};
```

`apps/web/src/components/chat/ComposerPrimaryActions.tsx:L110-L152`
```tsx
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const shortcutModifiers = useShortcutModifierState();
  const isQueuing =
    !isEditingQueuedMessage &&
    resolveComposerDispatchMode({
      running: isRunning,
      activeTurnDefault: followUpBehavior,
      canSteer,
      alternateModifier: shortcutModifiers.metaKey || shortcutModifiers.ctrlKey,
    }) === "queue";
  const alternateAction = alternateComposerDispatchAction(followUpBehavior);
  const isSendDisabled = !canOperateThread || sendDisabledReason !== null;
  const stageBackdropVariant = useSidebarStageBackdropVariant(environmentIdentificationMode);

  const renderStopGenerationButton = (insidePendingAction: boolean) => (
    <Tooltip key="interrupt">
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex shrink-0 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-control-highlight transition-colors duration-150 hover:bg-destructive active:inset-shadow-control-pressed active:shadow-none [&_svg]:pointer-events-none",
              insidePendingAction ? "size-8 sm:size-7" : "size-8 sm:h-8 sm:w-8",
            )}
            {...pointerFocusProps}
            disabled={!canOperateThread}
            onClick={() => {
              if (canOperateThread) onInterrupt();
            }}
            aria-label="Stop generation"
          />
        }
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </TooltipTrigger>
      <TooltipPopup>Interrupt</TooltipPopup>
    </Tooltip>
  );
```

`apps/web/src/components/chat/ComposerPrimaryActions.tsx:L204-L355`
```tsx
  if (showPlanFollowUpPrompt && (promptHasText || !canResume)) {
    if (promptHasText) {
      return (
        <button
          type="submit"
          className={cn(messageActionPillClassName, "h-9 sm:h-8", compact ? "px-3" : "px-4")}
          {...pointerFocusProps}
          disabled={isSendBusy || isSendDisabled || isEnvironmentUnavailable}
        >
          {isSendBusy ? "Sending..." : "Refine"}
        </button>
      );
    }

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <button
          type="submit"
          className={cn(messageActionPillClassName, "h-9 rounded-r-none px-4 sm:h-8")}
          {...pointerFocusProps}
          disabled={isSendBusy || isSendDisabled || isEnvironmentUnavailable}
        >
          {isSendBusy ? "Sending..." : "Implement"}
        </button>
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                className={cn(
                  messageActionPillClassName,
                  "h-9 rounded-l-none border-l border-message-action-foreground/20 px-2 sm:h-8",
                )}
                aria-label="Implementation actions"
                onMouseDown={
                  preserveComposerFocusOnPointerDown ? (event) => event.preventDefault() : undefined
                }
                disabled={isSendBusy || isSendDisabled || isEnvironmentUnavailable}
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top" {...composerFloatingLayerProps}>
            <MenuItem
              disabled={isSendBusy || isSendDisabled || isEnvironmentUnavailable}
              onClick={() => {
                if (canOperateThread) onImplementPlanInNewThread();
              }}
            >
              Implement in a new thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  if (canInterrupt && !hasSendableContent && !isEditingQueuedMessage) {
    return renderStopGenerationButton(false);
  }

  const showResume = canResume && !hasSendableContent && !isEditingQueuedMessage;

  const compactTokens =
    compactBeforeSendTokens !== null && !showResume && !isEditingQueuedMessage
      ? formatContextWindowTokens(compactBeforeSendTokens)
      : null;
  const compactsBeforeSend = compactTokens !== null && !keepFullHistory;

  const submitLabel = showResume
    ? "Resume thread"
    : isEditingQueuedMessage
      ? "Update queued message"
      : compactsBeforeSend
        ? "Compact and send"
        : isQueuing
          ? "Queue message"
          : isRunning
            ? "Steer message"
            : "Submit message";
  const submitStatus = isEnvironmentUnavailable
    ? "Environment disconnected"
    : (sendDisabledReason ??
      (isPreparingWorktree
        ? "Preparing worktree"
        : isSendBusy
          ? isEditingQueuedMessage
            ? "Updating queued message"
            : "Submitting message"
          : null));
  const submitTooltip =
    submitStatus ??
    (compactsBeforeSend
      ? `Summarize ${compactTokens} tokens of history, then send`
      : isRunning && !isEditingQueuedMessage && canSteer
        ? `Click to ${followUpBehavior}, ${isMacPlatform(navigator.platform) ? "⌘" : "Ctrl"}-click${alternateShortcutLabel ? ` or ${alternateShortcutLabel}` : ""} to ${alternateAction}`
        : submitLabel);

  const sendButton = (
    <button
      type={showResume ? "button" : "submit"}
      className={cn(
        "relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-control-highlight hover:scale-105 active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 [&_svg]:pointer-events-none",
        stageBackdropVariant
          ? "bg-transparent text-white enabled:shadow-black/24 enabled:hover:brightness-110 disabled:opacity-64"
          : "bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover disabled:bg-foreground/12 disabled:text-muted-foreground",
      )}
      {...pointerFocusProps}
      onClick={showResume ? onResume : onSubmitMessage}
      disabled={
        isSendBusy ||
        isSendDisabled ||
        isEnvironmentUnavailable ||
        (!hasSendableContent && !showResume)
      }
      aria-label={submitStatus ?? submitLabel}
    >
      {stageBackdropVariant ? (
        <span className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
          <StageBackdropButtonArt variant={stageBackdropVariant} />
        </span>
      ) : null}
      {isSendBusy ? (
        <Spinner size="sm" aria-hidden="true" />
      ) : showResume ? (
        <PlayIcon className="size-4 fill-current" aria-hidden="true" />
      ) : isEditingQueuedMessage ? (
        <CheckIcon className="size-4" aria-hidden="true" />
      ) : isRunning ? (
        <MorphIcon className="size-4" icon={isQueuing ? ListPlus : CornerUpRight} />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );

  const submit = (
    <Tooltip key="submit">
      <TooltipTrigger render={<span className="inline-flex" />}>{sendButton}</TooltipTrigger>
      <TooltipPopup>{submitTooltip}</TooltipPopup>
    </Tooltip>
  );
  if (compactTokens === null) return submit;
```

Compact-before-send toggle chip shown left of the send button when a resume would compact history:

`apps/web/src/components/chat/ComposerPrimaryActions.tsx:L357-L388`
```tsx
  return (
    <div data-chat-composer-compact-send="true" className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-(--control-radius) px-2 font-medium text-base text-foreground/80 tabular-nums outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 sm:text-sm aria-pressed:bg-accent/60 aria-pressed:text-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:text-muted-foreground"
              {...pointerFocusProps}
              aria-pressed={!keepFullHistory}
              aria-label={`Compact ${compactTokens} tokens of history before sending`}
              disabled={!canOperateThread}
              onClick={onToggleKeepFullHistory}
            />
          }
        >
          <Minimize2Icon aria-hidden="true" />
          {keepFullHistory ? "Keep" : "Compact"}
          <span className="text-muted-foreground">{compactTokens}</span>
        </TooltipTrigger>
        <TooltipPopup>
          <div>
            {keepFullHistory
              ? `Next send keeps all ${compactTokens} tokens.`
              : `Next send compacts ${compactTokens} tokens first.`}
          </div>
          <div>{keepFullHistory ? "Click to compact first" : "Click to keep full history"}</div>
        </TooltipPopup>
      </Tooltip>
      {submit}
    </div>
  );
```

Footer slot: optional context-window meter, then the primary actions:

`apps/web/src/components/chat/ComposerFooterControls.tsx:L284-L297`
```tsx
  return (
    <>
      {props.activeContextWindow ? (
        <ContextWindowMeter
          usage={props.activeContextWindow}
          modelDisplayName={props.activeThreadModelDisplayName}
          onCompact={props.onCompactContext}
          compactDisabled={props.compactDisabled}
          compactDisabledReason={props.compactDisabledReason}
        />
      ) : props.reserveContextWindowMeter ? (
        <ContextWindowMeterPlaceholder />
      ) : null}
      <ComposerPrimaryActions
```

Queued messages render above the composer as dashed bubbles (`QueuedRunsControl`), with "Send now", Edit (pencil, edits in the composer), Remove (X). Shows at most 3 rows before "Show all N queued".

`apps/web/src/components/chat/QueuedRunsControl.tsx:L53`
```tsx
const QUEUE_VISIBLE_ROWS = 3;
```

`apps/web/src/components/chat/QueuedRunsControl.tsx:L228-L238`
```tsx
  return (
    <section
      aria-label={`${items.length} queued message${items.length === 1 ? "" : "s"}`}
      data-thread-queue="true"
      // Anchors the sr-only live region; unanchored, it escapes the timeline scroller and makes the chat column scroll.
      className="relative mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2 pb-4"
    >
      <span className="sr-only" aria-live="polite">
        {items.length} queued
      </span>
      <ol className="flex flex-col items-end gap-3" id={queueListId}>
```

`apps/web/src/components/chat/QueuedRunsControl.tsx:L264-L305`
```tsx
                {canSend && !isEditing ? (
                  <>
                    <Tooltip>
                      <TooltipTrigger render={<span className="flex shrink-0" />}>
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          disabled={item.runId === null || busyRunId !== null}
                          onClick={() => {
                            if (item.runId !== null) {
                              void sendQueuedMessage(item.runId);
                            }
                          }}
                        >
                          <ArrowUpIcon />
                          Send now
                        </Button>
                      </TooltipTrigger>
                      <TooltipPopup>
                        {`${workflow?.canSendNow ? "Start a turn with this message" : workflow?.promoteSkipsCompaction ? "Skip compaction and send this message" : "Send into the current turn"}${item.serverIndex === 0 && props.steerShortcutLabel ? ` (${props.steerShortcutLabel})` : ""}`}
                      </TooltipPopup>
                    </Tooltip>
                  </>
                ) : null}
                {item.pending ? (
                  <span className="flex items-center gap-1 px-1">
                    <Clock3Icon aria-hidden className="size-3" />
                    Saving
                  </span>
                ) : null}
                {isEditing ? (
                  <>
                    <span className="px-1 text-foreground">Editing in the composer</span>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label="Cancel editing queued message"
                      onClick={props.onCancelEdit}
                    >
                      Cancel
                    </Button>
                  </>
```

Queued bubble style (dashed, unfilled):

`apps/web/src/components/chat/QueuedRunsControl.tsx:L438-L450`
```tsx
      {/* Dashed and unfilled: a turn that has not been sent yet. */}
      <div
        className={cn(
          "flex min-w-0 max-w-[80%] flex-col rounded-2xl border border-dashed text-sm",
          props.isEditing
            ? "border-primary/60 text-foreground"
            : attribution === "guest"
              ? "border-guest/50 text-muted-foreground"
              : "border-muted-foreground/40 text-muted-foreground",
          fold === null && "px-3 py-2",
          fold !== null && expanded && "w-full",
        )}
      >
```

---


#### 3. Keys: Enter / Shift+Enter / Cmd+Enter, IME, Escape, ArrowUp history

- `sendShortcut` default `"enter"`: Enter sends, Shift+Enter (or Alt+Enter) inserts a new paragraph. `"mod-enter"` requires Cmd/Ctrl+Enter; `"mod-enter-multiline"` requires the modifier only once the prompt contains a newline.
- With the on-screen keyboard open (mobile), plain Enter never sends (inserts a newline); Cmd/Ctrl+Enter still sends.
- IME: `event.isComposing || keyCode === 229` never sends; key repeat (`event.repeat`) never sends.
- Cmd/Ctrl+Enter: while running = alternate (queue vs steer). On a draft (new) thread = "background" send (send, then open a fresh new-thread draft). Cmd+Alt+Enter on an existing thread = "send and new thread".
- Escape inside the editor only closes the @ / slash / $ / # menu. No Escape-to-interrupt binding exists in the default keymap.
- ArrowUp/ArrowDown recall previous user prompts from this thread when the composer is empty (or already browsing history), the caret is on the visual first/last line, and there are no attachments/contexts. Alt+ArrowUp edits the last queued message.
- Shift+Tab toggles plan mode (only if plan mode is enabled). Enter/Tab inside lists continue/indent the list.

`apps/web/src/composer-logic.ts:L49-L93`
```ts
export function composerRequiresModifier(
  sendShortcut: ClientSettings["sendShortcut"] | undefined,
  prompt: string,
) {
  return (
    sendShortcut === "mod-enter" ||
    (sendShortcut === "mod-enter-multiline" && /[\r\n]/.test(prompt))
  );
}

export function composerSubmissionIntentForKey(input: {
  event: ShortcutEventLike & { isComposing?: boolean; keyCode?: number; repeat?: boolean };
  keybindings: ResolvedKeybindingsConfig;
  platform?: string;
  isSoftwareKeyboardOpen: boolean;
  isDraftThread: boolean;
  isRunning?: boolean;
  sendShortcut?: ClientSettings["sendShortcut"];
  prompt?: string;
}): ComposerSubmissionIntent | null {
  const { event } = input;
  if (event.isComposing || event.keyCode === 229 || event.repeat) return null;
  if (input.isSoftwareKeyboardOpen && event.key === "Enter" && !event.metaKey && !event.ctrlKey)
    return null;
  const command = resolveShortcutCommand(event, input.keybindings, {
    ...(input.platform === undefined ? {} : { platform: input.platform }),
    context: {
      composerFocus: true,
      draftThreadRoute: input.isDraftThread,
      turnRunning: input.isRunning === true,
      composerRequiresModifier: composerRequiresModifier(input.sendShortcut, input.prompt ?? ""),
    },
  });
  if (command === "composer.sendAlternate" && input.isRunning) return "alternate";
  if (command === "composer.sendBackground" && input.isDraftThread) return "background";
  if (command === "composer.sendAndNewThread" && !input.isDraftThread) return "background";
  if (command !== null || event.key !== "Enter" || event.shiftKey || event.altKey) return null;
  if (
    composerRequiresModifier(input.sendShortcut, input.prompt ?? "") &&
    !event.metaKey &&
    !event.ctrlKey
  )
    return null;
  return "foreground";
}
```

Default keybindings for the composer:

`packages/shared/src/keybindings.ts:L181-L214`
```ts
  { key: "mod+s", command: "composer.stash", when: "!terminalFocus" },
  { key: "mod+shift+enter", command: "thread.steerQueuedMessage", when: "!terminalFocus" },
  { key: "alt+arrowup", command: "thread.editQueuedMessage", when: "composerFocus" },
  { key: "mod+enter", command: "composer.sendAlternate", when: "composerFocus && turnRunning" },
  {
    key: "mod+enter",
    command: "composer.sendBackground",
    when: "composerFocus && draftThreadRoute",
  },
  {
    key: "mod+alt+enter",
    command: "composer.sendBackground",
    when: "composerFocus && draftThreadRoute",
  },
  {
    key: "mod+alt+enter",
    command: "composer.sendAndNewThread",
    when: "composerFocus && !draftThreadRoute",
  },
  { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+n", command: "chat.newLocal", when: "!terminalFocus" },
  { key: "mod+alt+n", command: "chat.newWithoutProject", when: "!terminalFocus" },
  { key: "mod+f", command: "chat.find", when: "!terminalFocus && !previewFocus" },
  { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
  { key: "mod+shift+h", command: "composer.host", when: "!terminalFocus" },
  { key: "mod+shift+e", command: "composer.effort", when: "!terminalFocus" },
  { key: "mod+shift+a", command: "composer.mode", when: "!terminalFocus" },
  { key: "mod+shift+x", command: "composer.workspace", when: "!terminalFocus" },
  { key: "mod+shift+g", command: "composer.branch", when: "!terminalFocus" },
  { key: "mod+shift+l", command: "composer.previousWorktree", when: "!terminalFocus" },
  { key: "mod+shift+k", command: "pullRequest.copyNumber", when: "!terminalFocus" },
  { key: "mod+shift+arrowup", command: "modelPicker.previousProvider", when: "modelPickerOpen" },
  { key: "mod+shift+arrowdown", command: "modelPicker.nextProvider", when: "modelPickerOpen" },
```

What background intent does after a successful send on an existing thread:

`apps/web/src/components/chat/useComposerSend.ts:L1365-L1370`
```ts
        } else if (
          submissionIntent === "background" &&
          currentRouteThreadKeyRef.current === routeThreadKey
        ) {
          handleNewThreadInActiveProject();
        }
```

The full editor key handler (menu nav, Escape, history, send, plan toggle, list continuation):

`apps/web/src/components/chat/composerCommandKey.ts:L134-L255`
```ts
  const navigatePromptHistory = (
    direction: "backward" | "forward",
    event: KeyboardEvent,
  ): boolean => {
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) {
      return false;
    }
    if (pendingUserInputs.length > 0) return false;
    if (
      composerImagesRef.current.length > 0 ||
      composerFilesRef.current.length > 0 ||
      composerTerminalContextsRef.current.length > 0 ||
      composerPreviewAnnotations.length > 0 ||
      composerReviewComments.length > 0
    ) {
      return false;
    }
    const recalled = promptHistoryPositionRef.current;
    const position = recalled?.targetKey === promptHistoryTargetKey ? recalled.position : null;
    if (position === null && promptRef.current.length > 0) {
      return false;
    }
    const editor = composerEditorRef.current;
    if (!editor?.isCaretOnVisualEdge(direction === "backward" ? "start" : "end")) {
      return false;
    }
    const step = stepComposerPromptHistory({
      direction,
      // Built on the keypress, not per render: the timeline changes on every streamed delta.
      entries: buildComposerPromptHistoryEntries(promptHistoryMessages),
      position,
      currentPrompt: promptRef.current,
    });
    if (!step) return false;
    promptHistoryPositionRef.current = step.position
      ? { targetKey: promptHistoryTargetKey, position: step.position }
      : null;
    replacePromptFromHistory(step.prompt);
    return true;
  };

  const onComposerCommandKey = (key: string, event: KeyboardEvent, isTaskItem = false) => {
    const submissionIntent = composerSubmissionIntentForKey({
      event,
      keybindings,
      isSoftwareKeyboardOpen,
      isDraftThread: routeKind === "draft",
      isRunning: phase === "running",
      sendShortcut,
      prompt: promptRef.current,
    });
    if (key === "Tab" && event.shiftKey && submissionIntent === null) {
      if (!planModeUiEnabled) return false;
      toggleInteractionMode();
      return true;
    }
    const { trigger } = resolveActiveComposerTrigger();
    const menuIsActive =
      !isLiteralPendingAnswer && (composerMenuOpenRef.current || trigger !== null);
    if (key === "Escape") {
      if (!menuIsActive || event.isComposing || event.keyCode === 229) return false;
      dismissComposerTrigger(trigger);
      composerMenuOpenRef.current = false;
      return true;
    }
    if (menuIsActive && (submissionIntent === null || submissionIntent === "foreground")) {
      const currentItems = composerMenuItemsRef.current;
      const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
      if (key === "ArrowDown" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if ((key === "Enter" || key === "Tab") && selectedItem) {
        onSelectComposerItem(selectedItem);
        return true;
      }
    }
    if ((key === "ArrowUp" || key === "ArrowDown") && submissionIntent === null) {
      return navigatePromptHistory(key === "ArrowUp" ? "backward" : "forward", event);
    }
    if (submissionIntent) {
      submitComposer(
        undefined,
        resolveComposerDispatchMode({
          running: phase === "running",
          alternateModifier: submissionIntent === "alternate",
          activeTurnDefault: followUpBehavior,
          canSteer: !isCompacting,
        }),
        submissionIntent,
      );
      return true;
    }
    if (key === "Enter" && isTaskItem) return false;
    if (
      !isLiteralPendingAnswer &&
      !event.isComposing &&
      (key === "Enter" || (key === "Tab" && !event.shiftKey))
    ) {
      const selection = composerEditorRef.current?.readSelectionRange();
      const snapshot = readComposerSnapshot();
      if (selection && selection.start === selection.end && snapshot.value === promptRef.current) {
        const edit =
          key === "Enter"
            ? listContinuationForEnter(snapshot.value, selection.start)
            : listIndentForTab(snapshot.value, selection.start, selection.end);
        if (
          edit &&
          applyPromptReplacement(edit.start, edit.end, edit.replacement, {
            expandedCursorAfterReplace: edit.cursorAfter,
          })
        ) {
          return true;
        }
      }
    }
    return false;
  };
```

Editor-level Enter handling in Tiptap (IME guard, code blocks, fallback new paragraph):

`apps/web/src/components/ComposerPromptEditorTiptap.tsx:L1233-L1240`
```tsx
          if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) {
            event.stopPropagation();
            return true;
          }
          if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
            event.preventDefault();
            return true;
          }
```

`apps/web/src/components/ComposerPromptEditorTiptap.tsx:L1277-L1311`
```tsx
          const handler = readCallbacks().onCommandKeyDown;
          if (event.key === "Enter") {
            const instance = (view.dom as TiptapEditorHTMLElement).editor;
            const isTaskItem = richText && (instance?.isActive("taskItem") ?? false);
            const isListItem = richText && (instance?.isActive("listItem") ?? false);
            const handled = handler?.("Enter", event, isTaskItem || isListItem) ?? false;
            if (handled) {
              event.preventDefault();
              event.stopPropagation();
              return true;
            }
            event.preventDefault();
            if ((isTaskItem || isListItem) && instance && splitOrLiftListItem(instance)) {
              return true;
            }
            if (
              richText &&
              instance &&
              hasAncestor(view.state.selection.$from, "blockquote") &&
              view.state.selection.$from.parent.content.size === 0 &&
              instance.commands.lift("blockquote")
            ) {
              return true;
            }
            return splitBlockKeepMarks(view.state, (tr) => {
              view.dispatch(tr.scrollIntoView());
            });
          }
          if (!handler) return false;
          const handled = handler(event.key, event);
          if (handled) {
            event.preventDefault();
            event.stopPropagation();
          }
          return handled;
```

PageUp/PageDown in the editor scroll the timeline (when the editor itself cannot scroll further):

`apps/web/src/components/ComposerPromptEditorTiptap.tsx:L1784-L1808`
```tsx
                if (event.key !== "PageUp" && event.key !== "PageDown") return;
                const target = event.currentTarget.querySelector(
                  '[data-testid="composer-editor"]',
                ) as HTMLElement | null;
                if (!target) return;
                const pageScrollKey = getTimelinePageScrollKey({
                  altKey: event.altKey,
                  clientHeight: target.clientHeight,
                  ctrlKey: event.ctrlKey,
                  defaultPrevented: event.defaultPrevented,
                  isComposing: event.nativeEvent.isComposing,
                  key: event.key,
                  keyCode: event.keyCode,
                  metaKey: event.metaKey,
                  scrollHeight: target.scrollHeight,
                  scrollTop: target.scrollTop,
                  shiftKey: event.shiftKey,
                });
                if (!pageScrollKey) {
                  onPageScrollRelease?.();
                  return;
                }
                if (!onPageScrollKeyDown) return;
                event.preventDefault();
                onPageScrollKeyDown(pageScrollKey);
```

Pending-question digit shortcuts (1-9 pick an option when focus is not in a text field):

`apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx:L153-L175`
```tsx
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      selectOptionFromShortcut(activeQuestion.id, option.value ?? option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
```

---


#### 9. Placeholder copy, banner copy, empty-thread hero headline

Default placeholder:

`apps/web/src/composerPlaceholder.ts:L1`
```ts
export const DEFAULT_COMPOSER_PLACEHOLDER = "Ask anything. @ files, $ skills, / commands";
```

Context-dependent placeholders:

`apps/web/src/components/chat/ChatComposer.tsx:L3363-L3379`
```tsx
                    placeholder={
                      isComposerApprovalState
                        ? activePendingApproval?.supportsFeedback
                          ? "Send feedback to decline this request"
                          : "Send a message to decline and redirect the agent"
                        : activePendingProgress
                          ? isChoiceOnlyPendingQuestion
                            ? "Choose an option above"
                            : "Type your own answer, or leave this blank to use the selected option"
                          : showPlanFollowUpPrompt && activeProposedPlan
                            ? "Add feedback to refine the plan, or leave this blank to implement it"
                            : projectSelectionRequired
                              ? "Choose a project above to start a thread"
                              : showProviderUnavailable
                                ? "Enable a provider in Settings to send a message"
                                : DEFAULT_COMPOSER_PLACEHOLDER
                    }
```

Mobile collapsed single-line prompt placeholder ("Ask anything..."):

`apps/web/src/components/chat/ChatComposer.tsx:L3212-L3213`
```tsx
                  {prompt.trim() ||
                    (showProviderUnavailable ? "Enable a provider in Settings" : "Ask anything...")}
```

Editor aria-label: `activeThread ? `Message ${activeThread.title}` : "Message"` (`apps/web/src/components/chat/ChatComposer.tsx:L3334`).

Banners: the composer receives `bannerItems` (each `{ id, variant, group, icon, title, description, actions, dismissLabel, onDismiss }`), and renders each as an attached glass card stacked above the composer (environment-group first, then attention). Sources assembled in ChatView: feedback, model fallback, limit recovery, usage limits, project clone, system banners, branch mismatch. Plus the plan-ready strip and the pending-question card in the top drawer.

`apps/web/src/components/chat/ComposerBannerStack.tsx:L15-L26`
```tsx
export interface ComposerBannerStackItem {
  readonly id: string;
  readonly variant: ComposerBannerVariant;
  readonly group?: ComposerBannerGroup;
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly dismissLabel?: string;
  readonly onDismiss?: () => void;
}
```

`apps/web/src/components/chat/ComposerBannerStack.tsx:L128-L179`
```tsx
function NoticeCard({ item }: { readonly item: ComposerBannerStackItem }) {
  return (
    <ComposerBanner.Root
      role={item.variant === "error" || item.variant === "warning" ? "alert" : undefined}
      variant={item.variant}
      density="comfortable"
      data-chat-composer-collapsed-controls="true"
    >
      <ComposerBanner.Row layout="wrap-actions">
        <ComposerBanner.Icon className="h-(--composer-banner-icon-column) self-start">
          {item.icon}
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="whitespace-nowrap">
          <NoticeText
            detailsLabel={
              typeof item.title === "string"
                ? `Show full title: ${item.title}`
                : "Show title details"
            }
            className="min-w-0 truncate font-medium leading-7 sm:leading-6"
          >
            {item.title}
          </NoticeText>
          {item.description ? (
            <NoticeText
              detailsLabel={
                typeof item.title === "string"
                  ? `Show details: ${item.title}`
                  : "Show notice details"
              }
              className="w-0 min-w-0 grow truncate text-muted-foreground @max-[400px]:sr-only"
            >
              {item.description}
            </NoticeText>
          ) : null}
        </ComposerBanner.Content>
        {item.actions || item.onDismiss ? (
          <ComposerBanner.Actions>
            {item.actions}
            {item.onDismiss ? (
              <ComposerBanner.Dismiss
                aria-label={item.dismissLabel ?? "Dismiss warning"}
                onClick={item.onDismiss}
              />
            ) : null}
          </ComposerBanner.Actions>
        ) : null}
      </ComposerBanner.Row>
      {item.children ? <ComposerBanner.Children>{item.children}</ComposerBanner.Children> : null}
    </ComposerBanner.Root>
  );
}
```

Example banner copy (model fallback):

`apps/web/src/components/chat/ComposerUsageLimits.tsx:L89-L102`
```tsx
  return {
    id: "fallback-model",
    variant: "info",
    icon: <GaugeIcon />,
    title: `Using ${fallbackModelName}`,
    description: `${defaultProviderName} is out of usage${resetsAt ? ` · resets ${formatUpcomingTimestamp(resetsAt, timestampFormat)}` : ""}`,
    actions: (
      <Button size="xs" variant="ghost" onClick={onUseDefault}>
        Use {defaultModelName}
      </Button>
    ),
    dismissLabel: "Dismiss fallback model notice",
    onDismiss,
  };
```

Branch mismatch banner copy (`apps/web/src/components/chat/ThreadActivityBanners.tsx`, around L198-L223): icon `GitBranchIcon`, text "Branch changed from" + branch code, tooltip "This thread last ran on {branch}. Sending will continue on ...", action "Restore branch" / "Restoring...", dismiss label "Dismiss branch change notice".

Plan-ready strip:

`apps/web/src/components/chat/ComposerPlanFollowUpBanner.tsx:L9-L19`
```tsx
  return (
    <ComposerBanner.Row>
      <ComposerBanner.Icon />
      <ComposerBanner.Content>
        <span className="shrink-0 font-medium text-muted-foreground">Plan ready</span>
        {planTitle ? (
          <span className="min-w-0 flex-1 truncate text-foreground/85">{planTitle}</span>
        ) : null}
      </ComposerBanner.Content>
    </ComposerBanner.Row>
  );
```

Pending question card (collapsible header + markdown question + options with radio/checkbox and number keys):

`apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx:L189-L236`
```tsx
      <CollapsibleTrigger
        render={<ComposerBanner.Row render={<button type="button" />} />}
        title={
          isCollapsed ? "Show the question and its options" : "Hide the question and its options"
        }
        data-pending-user-input-toggle={isCollapsed ? "collapsed" : "expanded"}
        className="px-4 pt-1.5"
      >
        <ComposerBanner.Content>
          <span className="shrink-0 text-muted-foreground">{activeQuestion.header}</span>
          {isCollapsed ? (
            <>
              <ComposerBanner.Separator />
              <span className="min-w-0 flex-1 truncate text-secondary-label">
                {activeQuestion.question}
              </span>
            </>
          ) : null}
        </ComposerBanner.Content>
        <ComposerBanner.Actions className="gap-0">
          {prompt.questions.length > 1 ? (
            <ComposerBanner.Count>
              {questionIndex + 1}/{prompt.questions.length}
            </ComposerBanner.Count>
          ) : null}
          <ComposerBanner.ToggleIcon expanded={!isCollapsed} />
          {prompt.dismissible ? (
            <ComposerBanner.Dismiss
              render={<span role="button" tabIndex={0} />}
              aria-label="Dismiss question without answering"
              title="Dismiss question without answering"
              disabled={isResponding}
              data-pending-user-input-dismiss
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDismiss(prompt.requestId);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                onDismiss(prompt.requestId);
              }}
            />
          ) : null}
        </ComposerBanner.Actions>
      </CollapsibleTrigger>
```

`apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx:L255-L283`
```tsx
                const className = cn(
                  "group flex w-full items-start gap-2.5 rounded-md bg-transparent py-1.5 ps-2 text-left sm:ps-1.5 outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25",
                  isSelected ? "text-foreground" : "text-foreground/70 hover:bg-muted/30",
                  (disabled || isResponding) && "opacity-50 cursor-not-allowed",
                  !disabled && !isResponding && "cursor-pointer",
                );
                // The h-5 slots match the label's line box, so the indicator and shortcut stay on its first line.
                const content = (
                  <>
                    <span className="pointer-events-none flex h-5 shrink-0 items-center">
                      {activeQuestion.multiSelect ? (
                        <CheckboxMark checked={isSelected} />
                      ) : (
                        <OptionRadio checked={isSelected} />
                      )}
                    </span>
                    <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                      <span className="text-sm font-medium">{option.label}</span>
                      {option.description && option.description !== option.label ? (
                        <span className="text-secondary-label text-2xs">{option.description}</span>
                      ) : null}
                    </div>
                    {index < 9 ? (
                      <span className="flex h-5 w-7 shrink-0 items-center justify-center sm:w-6">
                        <Kbd>{index + 1}</Kbd>
                      </span>
                    ) : null}
                  </>
                );
```

Empty-thread hero headline: rendered by ChatView above the composer when the thread is a fresh draft (`isDraftHeroState`); the composer overlay is vertically centered in that state. Copy: "What should we build in {project}?" (project is an inline combobox trigger; stacks to "What should we build?" + project below when it does not fit), "What should we work on?" (no-project scratch draft), "{project picker} to start", "Add a project to start", plus a muted "or start without a project" inline button.

`apps/web/src/components/ChatView.tsx:L3393-L3429` (trimmed)
```tsx
            <div
              {...composerArea}
              // ... ref, inert
              data-chat-composer-overlay="true"
              className={
                isDraftHeroState
                  ? "pointer-events-none absolute inset-0 z-20 flex items-center"
                  : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
              }
            >
              <div ref={draftHeroTransitionGroupRef} className="chat-composer-lane w-full">
                <div
                  data-chat-composer-stack="true"
                  className="group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-content-max-width)"
                >
                  {isDraftHeroState ? (
                    <div className="absolute inset-x-0 bottom-full">
                      <div
                        className="pb-4 group-has-data-[composer-shoulder-tab]/composer-stack:pb-0"
                        style={
                          forceExpandedMobileComposer
                            ? { viewTransitionName: MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME }
                            : undefined
                        }
                      >
                        <DraftHeroHeadline
                          draftId={draftId}
                          activeProjectRef={activeProjectRef}
                          activeProjectTitle={activeProject?.title ?? null}
                        />
                      </div>
                    </div>
                  ) : null}
```

`apps/web/src/components/chat/DraftHeroHeadline.tsx:L383-L406`
```tsx
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      {hasResolvedProject && !isScratchDraft ? (
        <DraftHeroProjectHeading projectName={activeProjectDisplayName ?? "Choose a project"}>
          {projectSelector}
        </DraftHeroProjectHeading>
      ) : (
        <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
          {isScratchDraft ? (
            <>What should we work on?</>
          ) : canChooseProject ? (
            <>{projectSelector} to start</>
          ) : (
            <>Add a project to start</>
          )}
        </h1>
      )}
      {scratchWorkspaceRoot === null ? null : (
        <p className="mt-2 flex h-6 w-full items-center justify-center text-sm">
          {isScratchDraft ? projectSelector : orStartWithoutProject}
        </p>
      )}
    </div>
  );
```

`apps/web/src/components/chat/DraftHeroHeadline.tsx:L346-L369`
```tsx
  const noProjectShortcut = shortcutLabelForCommand(keybindings, "chat.newWithoutProject");
  const orStartWithoutProject =
    scratchWorkspaceRoot !== null && !isScratchDraft && (hasResolvedProject || canChooseProject) ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              tone="muted"
              className="pointer-events-auto"
              onClick={() =>
                void startScratch().then((started) => {
                  if (started) {
                    document.querySelector<HTMLElement>("[data-draft-project-trigger]")?.focus();
                  }
                })
              }
            />
          }
        >
          or start without a project
        </TooltipTrigger>
        {noProjectShortcut ? <TooltipPopup side="bottom">{noProjectShortcut}</TooltipPopup> : null}
      </Tooltip>
    ) : null;
```

`apps/web/src/components/chat/DraftHeroProjectHeading.tsx:L32-L60`
```tsx
  return (
    <div ref={containerRef} className="group/draft-hero relative w-full" data-inline={fitsInline}>
      <span
        aria-hidden="true"
        className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden"
      >
        <span
          ref={inlineRef}
          className="flex w-max items-baseline gap-2 whitespace-nowrap font-normal text-3xl tracking-tight"
        >
          <span>What should we build in</span>
          <span>
            <span className="font-medium">{projectName}</span>?
          </span>
        </span>
      </span>
      <h1 className="flex w-full flex-col items-center justify-center gap-2 text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl lg:group-data-[inline=true]/draft-hero:flex-row">
        <span className="max-w-full lg:group-data-[inline=true]/draft-hero:shrink-0">
          What should we build
          <span className="lg:group-data-[inline=true]/draft-hero:hidden">?</span>
          <span className="hidden lg:group-data-[inline=true]/draft-hero:inline"> in</span>
        </span>
        <span className="flex min-w-0 max-w-full items-baseline justify-center text-base tracking-normal lg:group-data-[inline=true]/draft-hero:text-3xl lg:group-data-[inline=true]/draft-hero:tracking-tight">
          <span className="min-w-0">{children}</span>
          <span className="hidden shrink-0 lg:group-data-[inline=true]/draft-hero:inline">?</span>
        </span>
      </h1>
    </div>
  );
```

Project picker search placeholder inside the hero: `"Search projects..."` (`apps/web/src/components/chat/DraftHeroHeadline.tsx:L302`), add item label `"Add project"` (L161), fallback labels `"No project"` / `"Choose a project"` (L291), `"Add a project"` (L342).

---


#### 10. Layout and styling: exact classNames

Layering, outermost first:

1. ChatView overlay + stack: `max-w-(--chat-content-max-width)` (46rem), centered.
2. `ComposerSurface.Shell`: glass background as a `::before` (card color at 80% opacity, 12px blur, 1.14 saturate; dark: 16px blur, 1.08 saturate), `rounded-2xl`, sets CSS vars (`--chat-composer-drawer-inset: 1.375rem`, glass surface, outline `rgb(0 0 0/8%)` light).
3. `ComposerSurface.Host`: `rounded-2xl shadow-composer` (`0 1px 2px rgb(0 0 0 / 5%)`), 1px outline as `::after` border, dark mode no shadow and a 2xs inset highlight.
4. `<form>` with `ComposerBanner.Dock` (attached banners overlap the card top by 1rem+1px) and the card.
5. `ComposerSurface.Main`: `rounded-2xl p-px`.
6. Surface div: `rounded-2xl`, drag-over gives `bg-accent/45 ring-1 ring-inset ring-primary/70`.
7. Body: `relative px-4 pb-2 pt-3.5 sm:pt-4`.
8. Footer: `flex min-w-0 flex-nowrap items-center overflow-visible px-2 pb-2`.

Design tokens:

`apps/web/src/index.css:L103`
```css
  --control-radius: 0.5rem;
```

`apps/web/src/index.css:L119-L121`
```css
  --glass-blur: 12px;
  --glass-opacity: 80%;
  --glass-saturation: 1.14;
```

`apps/web/src/index.css:L131`
```css
  --chat-content-max-width: 46rem;
```

`apps/web/src/index.css:L149-L150`
```css
    --glass-blur: 16px;
    --glass-saturation: 1.08;
```

`apps/web/src/index.css:L196-L199`
```css
  /* The composer's elevation: a soft drop pulled in under the surface, shared
     by the composer, its context strip and attached banners. */
  --shadow-composer: 0 1px 2px rgb(0 0 0 / 5%);
  --shadow-composer-dark: 0 14px 32px -18px rgb(0 0 0 / 75%);
```

Send button color tokens: `--message-action: var(--primary)`, `--message-action-foreground: var(--primary-foreground)`, `--message-action-hover: color-mix(in srgb, var(--primary) 90%, var(--background))` (`apps/web/src/index.css:L1142-L1144`); placeholder color `--placeholder: var(--muted-foreground)` (`apps/web/src/index.css:L1136`).

Surface components:

`apps/web/src/components/chat/ComposerSurface.tsx:L5-L69`
```tsx
function Shell({
  contextRow = false,
  className,
  ...props
}: ComponentProps<"div"> & { contextRow?: boolean }) {
  return (
    <div
      data-slot="composer-shell"
      data-context-row={contextRow || undefined}
      className={cn(
        "@container/composer-surface group/composer-surface relative isolate mx-auto w-full max-w-(--chat-content-max-width)",
        "[--chat-composer-drawer-inset:1.375rem] [--chat-composer-glass-surface:var(--card)] [--chat-composer-outline:rgb(0_0_0/8%)]",
        "dark:[--chat-composer-glass-surface:var(--surface-raised)] dark:[--chat-composer-highlight:rgb(255_255_255/3%)] dark:[--chat-composer-outline:color-mix(in_srgb,var(--color-white)_5%,transparent)]",
        "[html[data-theme-id]_&]:[--chat-composer-glass-surface:var(--app-theme-surface-raised)] [html[data-theme-id]_&]:[--chat-composer-outline:var(--app-theme-toolbar-border)]",
        "dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-highlight:color-mix(in_srgb,var(--app-theme-input)_12%,transparent)] dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-outline:color-mix(in_srgb,var(--app-theme-input)_30%,var(--background))]",
        "dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-highlight:color-mix(in_srgb,#432d48_12%,transparent)] dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-outline:#241e28]",
        "before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-2xl before:bg-(--chat-composer-glass-surface)/(--glass-opacity) before:backdrop-blur-(--glass-blur) before:backdrop-saturate-(--glass-saturation)",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:before:bg-(--chat-composer-glass-surface)",
        "has-data-[composer-banner-surface=attached]:before:hidden",
        // With a context row below, the card paints its own glass (see Host) so the row stays bare.
        "data-context-row:before:hidden",
        className,
      )}
      {...props}
    />
  );
}

const outlineClasses =
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-(--chat-composer-outline) dark:after:inset-shadow-2xs dark:after:inset-shadow-(color:--chat-composer-highlight)";

function Host({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-host"
      className={cn(
        "relative z-10 w-full rounded-2xl shadow-composer after:z-1 dark:shadow-none",
        "group-data-context-row/composer-surface:before:pointer-events-none group-data-context-row/composer-surface:before:absolute group-data-context-row/composer-surface:before:inset-0 group-data-context-row/composer-surface:before:-z-1 group-data-context-row/composer-surface:before:rounded-2xl group-data-context-row/composer-surface:before:bg-(--chat-composer-glass-surface)/(--glass-opacity) group-data-context-row/composer-surface:before:backdrop-blur-(--glass-blur) group-data-context-row/composer-surface:before:backdrop-saturate-(--glass-saturation)",
        outlineClasses,
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none group-has-data-[composer-banner-surface=attached]/composer-surface:after:hidden",
        className,
      )}
      {...props}
    />
  );
}

function Main({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-chat-composer-main-surface="true"
      className={cn(
        "group relative z-10 rounded-2xl p-px",
        outlineClasses,
        "after:z-20 after:hidden group-has-data-[composer-banner-surface=attached]/composer-surface:after:block",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-surface)/(--glass-opacity) group-has-data-[composer-banner-surface=attached]/composer-surface:backdrop-blur-(--glass-blur) group-has-data-[composer-banner-surface=attached]/composer-surface:backdrop-saturate-(--glass-saturation)",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-composer dark:group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-surface)",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:**:data-[chat-composer-mobile-collapsed=true]:min-h-[calc(1rem+1px)]",
        className,
      )}
      {...props}
    />
  );
}
```

Footer control base style (`ComposerControl`: model picker, effort, mode chips). Transparent border, `rounded-(--control-radius)` (0.5rem), h-7, hover `bg-accent`, focus `ring-2 ring-inset ring-ring ring-offset-1`, press scale 0.97, 44px min touch target on coarse pointers:

`apps/web/src/components/chat/ComposerControl.tsx:L10-L20`
```tsx
function composerControlClassName(size: ComposerControlSize, className?: string) {
  return cn(
    "relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-(--control-radius) border border-transparent text-base outline-none hover:bg-accent data-pressed:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 data-disabled:pointer-events-none data-disabled:opacity-64 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&:active:not([aria-haspopup])]:scale-[0.97] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:-mx-0.5 [&_svg[data-composer-control-icon]]:mx-0",
    "[&_:is([data-composer-control-label],[data-chat-provider-model-picker-label])]:[text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:[&_:is([data-composer-control-label],[data-chat-provider-model-picker-label])]:py-1.5",
    size === "xs"
      ? "h-7 gap-1 px-1.75 font-normal text-foreground/70 text-sm hover:text-foreground dark:text-muted-foreground sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5 [&_svg[data-composer-control-chevron]]:ms-0 [&_svg[data-composer-control-chevron]]:-me-1"
      : "h-7 gap-1.5 px-2 font-medium text-foreground/80 [&_svg:not([class*='text-'])]:text-muted-foreground hover:text-foreground sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
    "aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-pressed:hover:bg-accent/80",
    className,
  );
}
```

Attached banner surfaces (the glass "drawer" look used by banners, the command menu, stash, pending questions):

`apps/web/src/components/chat/ComposerBanner.tsx:L36-L90`
```tsx
function Surface({
  variant = "default",
  className,
  ...props
}: ComponentProps<"div"> & {
  variant?: ComposerBannerVariant;
}) {
  return (
    <div
      data-composer-banner-surface="attached"
      data-variant={variant}
      className={cn(
        surfaceColors,
        "relative isolate border-0 bg-transparent shadow-none [--chat-composer-attached-tint:transparent]",
        variantColors[variant],
        // Bleed the mask 1px past the seam to cover Chromium's fractional-pixel backdrop loss.
        "[--chat-composer-attachment-overlap:calc(1rem+1px)] before:rounded-t-2xl before:mask-t-from-transparent before:mask-t-from-4 before:mask-t-to-black before:mask-t-to-4",
        "before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:border before:border-(--chat-composer-attached-outline)",
        "before:bg-(--chat-composer-attached-surface)/(--glass-opacity) before:bg-linear-to-b before:from-(--chat-composer-attached-tint) before:to-(--chat-composer-attached-tint) before:backdrop-blur-(--glass-blur) before:backdrop-saturate-(--glass-saturation)",
        "before:shadow-composer dark:before:shadow-composer-dark",
        "dark:supports-[(backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px))]:before:bg-composer-seam-above",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:before:bg-(--chat-composer-attached-surface)",
        className,
      )}
      {...props}
    />
  );
}

function Attachment({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-banner-attachment"
      className={cn(
        "mx-auto -mb-[calc(1rem+1px)] w-[calc(100%-2*var(--chat-composer-drawer-inset))]",
        "[&+[data-slot=composer-banner-attachment]_[data-composer-banner-surface=attached]]:before:rounded-none [&+[data-slot=composer-banner-attachment]_[data-composer-banner-surface=attached]]:before:border-t-0",
        "[&+*_[data-chat-composer-form]>[data-slot=composer-banner-attachment]:first-child_[data-composer-banner-surface=attached]]:before:rounded-none [&+*_[data-chat-composer-form]>[data-slot=composer-banner-attachment]:first-child_[data-composer-banner-surface=attached]]:before:border-t-0",
        className,
      )}
      {...props}
    />
  );
}

function Dock({ className, ...props }: ComponentProps<"div">) {
  return (
    <Attachment
      className={cn(
        "flex items-end gap-1 not-has-data-[composer-banner-surface=attached]:hidden",
        className,
      )}
      {...props}
    />
  );
}
```

Error/warning tints:

`apps/web/src/components/chat/ComposerBanner.tsx:L26-L34`
```tsx
const variantColors: Record<ComposerBannerVariant, string> = {
  default: neutralOutline,
  error:
    "[--chat-composer-attached-outline:color-mix(in_srgb,var(--error)_32%,transparent)] [--chat-composer-attached-tint:color-mix(in_srgb,var(--error)_8%,transparent)]",
  info: neutralOutline,
  success: neutralOutline,
  warning:
    "[--chat-composer-attached-outline:color-mix(in_srgb,var(--warning)_28%,transparent)] [--chat-composer-attached-tint:color-mix(in_srgb,var(--warning)_8%,transparent)]",
};
```

`apps/web/src/components/chat/ComposerBanner.tsx:L105-L138`
```tsx
function Root({
  className,
  density = "default",
  variant = "default",
  width = "fill",
  ...props
}: ComponentProps<"div"> & {
  density?: "default" | "comfortable" | "spacious";
  variant?: ComposerBannerVariant;
  width?: "fill" | "content";
}) {
  return (
    <Surface
      className={cn(
        "min-w-0 px-1 py-(--composer-banner-padding-block) after:block after:h-(--chat-composer-attachment-overlap) text-xs/4 [--composer-banner-icon-column:--spacing(7)] [--composer-banner-padding-block:--spacing(1)] sm:[--composer-banner-icon-column:--spacing(6)]",
        density === "comfortable" && "[--composer-banner-padding-block:--spacing(1.25)]",
        density === "spacious" && "px-3 [--composer-banner-padding-block:--spacing(3)]",
        width === "content" ? "w-fit max-w-full flex-none" : "@container",
        // A corner button nests inside the banner's radius only when the padding
        // is tight; spacious padding already leaves the default radius concentric.
        density !== "spacious" && [
          "[&>[data-composer-banner-row]:first-child>[data-slot=composer-banner-actions]>[data-slot=button]:last-child]:rounded-se-xl",
          "[&>[data-composer-banner-row]:first-child>[data-slot=composer-banner-actions]>:last-child>[data-slot=button]:last-of-type]:rounded-se-xl",
          "[&>:first-child>[data-composer-banner-row]:first-child>[data-slot=composer-banner-actions]>[data-slot=button]:last-child]:rounded-se-xl",
        ],
        className,
      )}
      data-slot="composer-banner"
      data-composer-banner-width={width}
      variant={variant}
      {...props}
    />
  );
}
```

Button base (shadcn "base-mira" style; used for attach, remove, ghost buttons):

`apps/web/src/components/ui/button.tsx:L8-L9`
```tsx
const buttonVariants = cva(
  "[--control-icon-color:currentColor] [&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border font-medium text-base outline-none transition-[box-shadow,scale] [&:not([aria-haspopup]):not(:disabled):not([aria-disabled=true])]:will-change-[scale] [&:active:not([aria-haspopup])]:scale-[0.97] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-not-allowed aria-disabled:opacity-64 sm:text-sm [&_svg:not([class*='text-'])]:text-[var(--control-icon-color)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
```

Bottom safe-area spacer under the composer:

`apps/web/src/components/ChatView.tsx:L3686-L3689`
```tsx
                    <div
                      aria-hidden
                      className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                    />
```

---


#### 11. Responsive / mobile behavior of the composer footer

- Below 620px of form width (780px when the footer has wide actions such as the plan "Implement" split button or a pending-question action), the footer goes compact; primary actions only go compact in the wide-actions case (labels shorten, e.g. "Next" / "Submit").
- Controls blocks (traits, mode) measure themselves: first each block goes icon-only (labels hidden, compact icon revealed), then blocks hide from the right into an overflow menu. 1px slack prevents flapping.
- Mobile (`max-sm`): when not focused, single-line, not forced expanded, and no pending question, the composer collapses to a single row: a truncated prompt button ("Ask anything..."), up to 3 image thumbnails, and a 32px round send/resume button. A second "resting" controls row (xs size, muted) sits at the bottom inside the card. Tapping expands and focuses. After send with the software keyboard open, the composer blurs.
- On phones with a pending question, the primary actions float inside the editor bottom-right and the regular footer hides below `sm`.
- On touch phones the prompt font is at least 16px (iOS zoom guard). Controls have 44px touch targets on coarse pointers.

`apps/web/src/components/composerFooterLayout.ts:L1-L2`
```ts
const COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX = 620;
const COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX = 780;
```

`apps/web/src/components/composerFooterLayout.ts:L16-L42`
```ts
export function shouldUseCompactComposerFooter(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  const breakpoint = options?.hasWideActions
    ? COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX
    : COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX;
  return width !== null && width < breakpoint;
}

export function shouldAnimateComposerRestingTransition(input: {
  hasCompletedInitialLayout: boolean;
  stateChanged: boolean;
  hasInterruptedAnimation: boolean;
}): boolean {
  return input.hasCompletedInitialLayout && (input.stateChanged || input.hasInterruptedAnimation);
}

export function shouldUseCompactComposerPrimaryActions(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  if (!options?.hasWideActions) {
    return false;
  }
  return width !== null && width < COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX;
}
```

`apps/web/src/components/composerFooterLayout.ts:L86-L125`
```ts
const RESTING_CONTROLS_SLACK_PX = 1;

export function resolveRestingComposerControlsLayout(
  input: RestingComposerControlsMeasurement & {
    hostWidth: number;
    previous?: { hiddenCount: number; iconOnlyCount?: number; visible: boolean };
  },
): { hiddenCount: number; iconOnlyCount?: number; visible: boolean } {
  const { blockWidths, hostWidth, previous } = input;
  const iconSteps = input.iconOnlyBlockWidths ? blockWidths.length : 0;
  const previousStep = previous
    ? previous.hiddenCount > 0
      ? iconSteps + Math.min(previous.hiddenCount, blockWidths.length)
      : Math.min(previous.iconOnlyCount ?? 0, iconSteps)
    : 0;
  let step = 0;
  const widthAtStep = (candidate: number, fixedWidth = input.naturalFixedWidth) =>
    restingComposerControlsWidth(
      input,
      Math.max(0, candidate - iconSteps),
      fixedWidth,
      Math.min(candidate, iconSteps),
    );
  // Use 1px slack for natural-width jitter on promotion; demote immediately to avoid clipping or layout
  // flapping.
  while (
    step < iconSteps + blockWidths.length &&
    widthAtStep(step) > hostWidth - (step < previousStep ? RESTING_CONTROLS_SLACK_PX : 0)
  ) {
    step += 1;
  }
  const hiddenCount = Math.max(0, step - iconSteps);
  const iconOnlyCount = Math.min(step, iconSteps);
  const minimumWidth = widthAtStep(step, input.minimumFixedWidth);
  const visible =
    previous && !previous.visible
      ? minimumWidth <= hostWidth - RESTING_CONTROLS_SLACK_PX
      : minimumWidth <= hostWidth;
  return { hiddenCount, ...(input.iconOnlyBlockWidths ? { iconOnlyCount } : {}), visible };
}
```

Width observer that drives compact actions:

`apps/web/src/components/chat/ChatComposer.tsx:L1493-L1509`
```tsx
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measurePrimaryActionsCompact = () => {
      const composerFormWidth = composerForm.clientWidth;
      const options = { hasWideActions: composerFooterHasWideActions };
      return (
        shouldUseCompactComposerFooter(composerFormWidth, options) &&
        shouldUseCompactComposerPrimaryActions(composerFormWidth, options)
      );
    };

    setIsComposerPrimaryActionsCompact(measurePrimaryActionsCompact());
    return observeResize(composerForm, () => {
      setIsComposerPrimaryActionsCompact(measurePrimaryActionsCompact());
    });
  }, [composerFooterHasWideActions]);
```

`apps/web/src/components/chat/ChatComposer.tsx:L1173`
```tsx
  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
```

Mobile collapse rule:

`apps/web/src/components/chat/ChatComposer.tsx:L1010-L1027`
```tsx
  const isMobileViewport = useMediaQuery("max-sm");
  const isSoftwareKeyboardOpen = useSoftwareKeyboardOpen();
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [composerSubmissionError, setComposerSubmissionError] = useState<string | null>(null);
  const [providerInputSubmissionError, setProviderInputSubmissionError] = useState<string | null>(
    null,
  );
  const [composerMenuAnchor, setComposerMenuAnchor] = useState<HTMLDivElement | null>(null);
  const [hasWrappedPrompt, observeWrappedPrompt] = useComposerMultilinePrompt();
  const hasMultilinePrompt = prompt.includes("\n") || hasWrappedPrompt;
  // A pending question stays expanded: its card moves into the banner dock,
  // so collapsing would leave the surface empty and squashed beneath it.
  const isComposerCollapsedMobile =
    isMobileViewport &&
    !forceExpandedOnMobile &&
    !isComposerFocused &&
    !hasMultilinePrompt &&
    pendingUserInputs.length === 0;
```

`apps/web/src/components/chat/ChatComposer.tsx:L1230-L1236`
```tsx
  const collapsedComposerPrimaryActionLabel = showResumeAction
    ? "Resume thread"
    : props.resumeCompactionTokens !== null && !props.keepFullHistory
      ? "Open composer to compact and send"
      : "Send message";
  const showMobilePendingAnswerActions =
    isMobileViewport && !isComposerCollapsedMobile && pendingPrimaryAction !== null;
```

---


#### Essential composer JSX

The core render tree of `ChatComposer`, verbatim from `apps/web/src/components/chat/ChatComposer.tsx:L3088-L3535`, trimmed with `// ...` where focus/drag bookkeeping, the stash drawer and pending-question internals were cut. The send button JSX it delegates to is in section 2 (`ComposerPrimaryActions.tsx:L303-L347`).

`apps/web/src/components/chat/ChatComposer.tsx:L3088-L3535` (trimmed)
```tsx
  return (
    <form
      ref={composerFormRef}
      onSubmit={submitComposerStable}
      onFocusCapture={(event) => {
        // ...
        setIsComposerFocused(true);
      }}
      onBlurCapture={(event) => {
        // ...
        scheduleComposerCollapseCheck();
      }}
      // ... onDragEnterCapture / onDragOverCapture / onDragLeaveCapture / onDropCapture
      className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width)"
      data-chat-composer-form="true"
      {...threadContextDropTargetProps()}
    >
      <ComposerBanner.Dock>
        <ComposerBanner.Column>
          <ComposerBannerStack items={shelfItems} />
          {showComposerTopDrawer ? (
            <ComposerBanner.Attachment>
              <ComposerBanner.Root data-chat-composer-top-drawer="true" variant="info">
                {pendingUserInputs.length > 0 ? (
                  <ComposerPendingUserInputPanel
                    pendingUserInputs={pendingUserInputs}
                    // ...
                  />
                ) : !isComposerCollapsedMobile && showPlanFollowUpPrompt && activeProposedPlan ? (
                  <ComposerPlanFollowUpBanner
                    key={activeProposedPlan.id}
                    planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                  />
                ) : null}
              </ComposerBanner.Root>
            </ComposerBanner.Attachment>
          ) : null}
        </ComposerBanner.Column>
        <ComposerStashBadge
          count={stashQueue.length}
          menuOpen={isStashMenuOpen}
          pulseKey={stashPulseKey}
          onToggleMenu={toggleStashMenuStable}
        />
      </ComposerBanner.Dock>
      <div className="relative">
        <ComposerSurface.Main
          ref={composerMainSurfaceRef}
          data-inline-resting-controls="true"
          className={composerProviderState.composerFrameClassName}
        >
          <div
            ref={composerSurfaceRef}
            data-chat-composer-surface="true"
            data-chat-composer-mobile-collapsed={isComposerCollapsedMobile ? "true" : "false"}
            className={cn(
              "rounded-2xl transition-[background-color] duration-200",
              "in-data-[thread-context-over]:bg-accent/45 in-data-[thread-context-over]:ring-1 in-data-[thread-context-over]:ring-inset in-data-[thread-context-over]:ring-primary/70",
              isDragOverComposer ? "bg-accent/45 ring-1 ring-inset ring-primary/70" : null,
              projectSelectionRequired ? "opacity-75" : null,
              composerProviderState.composerSurfaceClassName,
            )}
          >
            {showCollapsedMobilePromptRow ? (
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <button
                  type="button"
                  data-chat-composer-transition-prompt="true"
                  className={cn(
                    "min-w-0 flex-1 truncate bg-transparent p-0 text-left text-sm focus:outline-none",
                    prompt.trim() ? "text-foreground" : "text-placeholder",
                  )}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={expandMobileComposerStable}
                  aria-label="Expand composer"
                >
                  {prompt.trim() ||
                    (showProviderUnavailable ? "Enable a provider in Settings" : "Ask anything...")}
                </button>
                {collapsedComposerImagePreviews}
                <button
                  type="button"
                  data-chat-composer-transition-actions="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-message-action text-message-action-foreground hover:bg-message-action-hover disabled:opacity-64"
                  disabled={collapsedComposerPrimaryActionDisabled}
                  aria-label={collapsedComposerPrimaryActionLabel}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (showResumeAction) onResume();
                    else if (props.resumeCompactionTokens !== null && !props.keepFullHistory)
                      expandMobileComposer();
                    else submitComposer();
                  }}
                >
                  {showResumeAction ? (
                    <PlayIcon className="size-4 fill-current" aria-hidden="true" />
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path
                        d="M8 3L8 13M8 3L4 7M8 3L12 7"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
              </div>
            ) : null}

            <div
              ref={(node) => {
                setComposerMenuAnchor(node);
                const stopObserving = observeWrappedPrompt(node);
                return () => {
                  setComposerMenuAnchor(null);
                  stopObserving?.();
                };
              }}
              data-chat-composer-body="true"
              className={cn(
                "relative px-4 pb-2",
                "pt-3.5 sm:pt-4",
                isComposerCollapsedMobile && "hidden",
              )}
            >
              {isStashMenuOpen && !composerMenuOpen && (
                <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                  <ComposerStashMenu
                    // ...
                  />
                </ComposerCommandMenuLayer>
              )}

              <div role="status" aria-atomic="true" className="sr-only">
                {composerSuggestionsVisible && composerMenuItems.length === 0
                  ? isComposerMenuLoading
                    ? composerTriggerKind === "pull-request"
                      ? "Finding pull request..."
                      : "Searching workspace files..."
                    : composerMenuEmptyState
                  : ""}
              </div>
              {composerSuggestionsVisible && (
                <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                  <ComposerCommandMenu
                    listId={composerSuggestionListId}
                    items={composerMenuItems}
                    resolvedTheme={resolvedTheme}
                    isLoading={isComposerMenuLoading}
                    triggerKind={composerTriggerKind}
                    emptyStateText={composerMenuEmptyState}
                    activeItemId={activeComposerMenuItem?.id ?? null}
                    onHighlightedItemChange={onComposerMenuItemHighlightedStable}
                    onSelect={onSelectComposerItemStable}
                  />
                </ComposerCommandMenuLayer>
              )}

              {!isComposerCollapsedMobile &&
                pendingUserInputs.length === 0 &&
                editingQueuedAttachments !== null &&
                editingQueuedAttachments.length > 0 && (
                  <ComposerQueuedAttachmentRow
                    attachments={editingQueuedAttachments}
                    onRemove={onRemoveEditingQueuedAttachment}
                  />
                )}

              {composerAttachmentMediaRow}

              {composerAttachmentFileList}

              <div className="relative">
                {previewFile ? (
                  <ComposerFilePreviewDialog
                    file={previewFile}
                    onRemove={removeComposerFileFromDraft}
                    onPreviewFileIdChange={setPreviewFileId}
                  />
                ) : null}
                <ComposerContextActionsContext value={composerContextActions}>
                  <ComposerPromptEditor
                    draftKey={composerDraftTargetKey}
                    // Switching threads lands focus here, so the label names the thread.
                    ariaLabel={activeThread ? `Message ${activeThread.title}` : "Message"}
                    suggestionListId={composerSuggestionListId}
                    // ... activeSuggestionId, editorRef, context records, skills
                    richTextEnabled={settings.composerRichTextEnabled}
                    literalText={isLiteralPendingAnswer}
                    value={activePendingProgress ? activePendingProgress.customAnswer : prompt}
                    cursor={composerCursor}
                    className={cn(showMobilePendingAnswerActions && "max-sm:pb-12")}
                    onChange={onPromptChangeStable}
                    onCommandKeyDown={onComposerCommandKeyStable}
                    // ... page scroll + citation handlers
                    onPaste={onComposerPasteStable}
                    placeholder={
                      isComposerApprovalState
                        ? activePendingApproval?.supportsFeedback
                          ? "Send feedback to decline this request"
                          : "Send a message to decline and redirect the agent"
                        : activePendingProgress
                          ? isChoiceOnlyPendingQuestion
                            ? "Choose an option above"
                            : "Type your own answer, or leave this blank to use the selected option"
                          : showPlanFollowUpPrompt && activeProposedPlan
                            ? "Add feedback to refine the plan, or leave this blank to implement it"
                            : projectSelectionRequired
                              ? "Choose a project above to start a thread"
                              : showProviderUnavailable
                                ? "Enable a provider in Settings to send a message"
                                : DEFAULT_COMPOSER_PLACEHOLDER
                    }
                    disabled={
                      projectSelectionRequired ||
                      isChoiceOnlyPendingQuestion ||
                      activePendingIsResponding
                    }
                  />
                </ComposerContextActionsContext>
                {showMobilePendingAnswerActions ? (
                  <div
                    data-chat-composer-mobile-pending-actions="true"
                    className="absolute bottom-0 right-0 flex items-center justify-end gap-1"
                  >
                    <ComposerPrimaryActions
                      compact
                      // ...
                    />
                  </div>
                ) : null}
              </div>
            </div>

            <ComposerPromptLengthValidation
              message={providerInputSubmissionError ?? composerSubmissionError}
            />

            {isComposerCollapsedMobile ? null : (
              <div
                data-chat-composer-footer="true"
                className={cn(
                  "flex min-w-0 flex-nowrap items-center overflow-visible px-2 pb-2",
                  pendingUserInputs.length > 0 && "pt-2",
                  showMobilePendingAnswerActions && "hidden sm:flex",
                )}
              >
                {composerAttachButton ? <div className="me-2">{composerAttachButton}</div> : null}
                <div
                  data-chat-composer-actions="right"
                  data-chat-composer-transition-actions="true"
                  data-chat-composer-primary-actions-compact={
                    isComposerPrimaryActionsCompact ? "true" : "false"
                  }
                  className="flex min-w-0 flex-1 flex-nowrap items-center justify-end gap-2"
                >
                  <div
                    ref={attachExpandedComposerControls}
                    data-chat-composer-controls="footer"
                    data-chat-composer-footer-controls="true"
                    className="relative flex min-w-0 flex-1 items-center justify-end gap-0.5"
                  >
                    {composerControls}
                  </div>
                  <ComposerFooterPrimaryActions
                    compact={isComposerPrimaryActionsCompact}
                    canOperateThread={canOperateThread}
                    activeContextWindow={
                      settings.contextWindowMeterEnabled ? activeContextWindow : null
                    }
                    reserveContextWindowMeter={reserveContextWindowMeter}
                    activeThreadModelDisplayName={activeThreadModelDisplayName}
                    pendingAction={pendingPrimaryAction}
                    isRunning={phase === "running"}
                    canInterrupt={canInterrupt}
                    followUpBehavior={followUpBehavior}
                    canSteer={!isCompacting}
                    // ... alternateShortcutLabel
                    showPlanFollowUpPrompt={
                      pendingUserInputs.length === 0 && showPlanFollowUpPrompt
                    }
                    promptHasText={prompt.trim().length > 0}
                    isSendBusy={isSendBusy}
                    sendDisabledReason={sendDisabledReason}
                    isEnvironmentUnavailable={
                      environmentUnavailable !== null ||
                      noProviderAvailable ||
                      projectSelectionRequired
                    }
                    isPreparingWorktree={isPreparingWorktree}
                    hasSendableContent={composerSendState.hasSendableContent}
                    canResume={showResumeAction}
                    preserveComposerFocusOnPointerDown={isMobileViewport}
                    isEditingQueuedMessage={isEditingQueuedMessage}
                    onSubmitMessage={handleSubmitMessageStable}
                    onResume={onResume}
                    onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                    onInterrupt={handleInterruptPrimaryActionStable}
                    onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryActionStable}
                    // ... compaction props
                  />
                </div>
              </div>
            )}
            {showInlineRestingControls ? (
              <div className="h-8">
                <div
                  ref={setInlineRestingControlsHost}
                  className="absolute bottom-2 inset-x-4 min-w-0"
                >
                  <div
                    ref={attachRestingComposerControls}
                    data-chat-composer-resting-controls="true"
                    aria-hidden={restingControlsVisible ? undefined : true}
                    inert={restingControlsVisible ? undefined : true}
                    className={cn(
                      "relative flex w-max min-w-0 max-w-full items-center gap-1 text-muted-foreground/70 [&_button]:text-xs!",
                      !restingControlsVisible && "invisible",
                    )}
                  >
                    {composerControls}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </ComposerSurface.Main>
      </div>
    </form>
  );
```

How ChatView wraps it (Shell > Host > composer, then the context strip):

`apps/web/src/components/ChatView.tsx:L3439-L3444`
```tsx
                    <ComposerSurface.Shell contextRow={showComposerContextStrip}>
                      <ComposerSurface.Host
                        inert={queuedRunEdit.isSaving}
                        aria-busy={queuedRunEdit.isSaving}
                      >
                        <div className="relative z-10">
```

`apps/web/src/components/ChatView.tsx:L3618-L3626`
```tsx
                      </ComposerSurface.Host>
                      <div className="min-h-0">
                        <div
                          data-terminal-open={terminalUiState.terminalOpen ? "true" : undefined}
                          className="relative z-0"
                        >
                          {showComposerContextStrip && (
                            <div className="pointer-events-auto">
                              <BranchToolbar
```

## 4. Sidebar

Core files: `apps/web/src/components/Sidebar.tsx` (3510 lines), `apps/web/src/components/sidebar/SidebarThreadRow.tsx` (1773 lines), `SidebarThreadHeader.tsx`, `SidebarChrome.tsx`, `apps/web/src/components/ui/sidebar.tsx`, `apps/web/src/components/AppSidebarLayout.tsx`, `apps/web/src/components/threadSidebarWidth.ts`, `Sidebar.logic.ts`, `Sidebar.drag.ts`.

### 4.1 Behavior summary

**Structure: an inbox, not a tree.** The default sidebar is a flat, cross-project list of threads split into sections:
- **Pinned** (manual drag order, fractional order keys)
- **Active** (newest "return" time first)
- collapsible shelves pushed to the bottom with `mt-auto`: **Working** (agent running), **Snoozed** (soonest wake first), **Settled** (paged, 10 then +25 per "Show N more")

Archived threads are hidden. Subagent threads have no row of their own. Projects are a **scope filter** (a header combobox with "All projects" plus each project and its favicon; shift-click multi-selects), not tree nodes. An optional "boring sidebar" setting (`boringSidebarEnabled`, default false) switches to the classic project folder -> threads tree. Shelf expansion persists in localStorage keys `t3code:sidebar:{settled,snoozed,working}-expanded`, all default false.

**Header, top to bottom:**
1. A brand row at `h-[var(--workspace-topbar-height)]` (52px), which is the Electron drag region. It holds the wordmark at `h-[1cap]` plus a muted "Code", hidden below `md`.
2. A fixed (non-scrolling) row: a "Search" field taking the remaining width, then `size-7` icon buttons. Project filter (`ListFilterIcon`, or the selected project's favicon). Add project (`FolderPlusIcon`). New thread (`SquarePenIcon`, tooltip "New thread (⌘N)").

New thread with 2+ projects opens the command palette to pick a project. Shift+click, or `mod+shift+n`, starts one in the current project.

**Footer:** a horizontal icon row with Settings (gear), Pull requests, Usage (bar chart), and the app update button pushed right (`ml-auto`, round `size-8`). On settings pages it becomes a "Back" button. Above it sit the undo notice and provider update pills. No user/account block.

**Thread row variants** (`SidebarThreadRow.tsx`):
- `card` (Pinned/Active/Working, about 78px, 3 lines):
  - line 1: favicon + project name + status slot
  - line 2: title
  - line 3: meta (branch, PR badge, terminal icon, remote-machine icon, provider icon stack)
- `slim` (shelves, 36px single line): grayscale favicon, title, relative time
- `folder` (boring mode)

Row surface states:
- active route: `bg-sidebar-row-active` (plus a thin ring in light mode)
- selected: `bg-sidebar-row-selected`
- unsent draft: `bg-warning/4 hover:bg-warning/8`
- "receded" (already-seen working/quiet rows): `text-sidebar-muted-foreground/75`, plus `opacity-70` until hover for working rows
- default: `hover:bg-sidebar-row-hover`

**Status slot**, by precedence:
1. Approval (`ShieldQuestionIcon`, warning)
2. Input (`MessageCircleQuestionIcon`, indigo)
3. Request
4. Waiting (`CircleDotDashedIcon`)
5. Working (`CircleDashedIcon`, `text-info-foreground`, live elapsed timer `42s` / `3m` / `1h 5m`)
6. Failed (`CircleAlertIcon`, `text-error-foreground`; usage-limit shows "Limited" in warning)
7. "Done" (`CircleCheckIcon`, `text-success-foreground`) when the latest run completed after the user's last visit

That last one is the unread signal. There's no separate dot and no spinner.

**Relative time:** `now`, `Nm`, `Nh`, `Nd`, re-rendered on a shared minute tick where only the label subscribes.

**Hover actions.** On hover or focus-visible, the status/time slot fades out and row actions fade in:
- card rows: Discard draft X, Snooze (clock menu), Settle (check)
- settled rows: Un-settle (`Undo2Icon`)
- snoozed rows: Wake (`AlarmClockOffIcon`)
- pinned rows: the pin icon morphs to `PinOffIcon`

Press an action and drag across other rows to "sweep" it over each. **No hover archive or delete.** Those live in the context menu.

**Context menu** (data-driven `ContextMenuItem[]`, native on Electron, DOM fallback on web), in order:
- New thread on <branch>
- Pin, Settle, Snooze (presets + Custom…)
- separator
- Rename thread, Regenerate title, Mark unread, Share with guest, Filter by <project>, Auto-settle behavior
- separator
- Copy (Path, Branch, Thread, Thread ID), Project settings
- separator
- Archive thread (disabled while running), Delete (destructive)

**Rename** is inline: double-click, F2, or the context menu. An empty title toasts "Thread title cannot be empty". **Undo:** settle, snooze, unpin, archive and discard all show an inline notice such as "Settled 2 threads, ⌘Z to undo". It lasts 5s, groups consecutive same-type actions, and `mod+z` triggers it.

**Hover card:** 150ms delay, glass, to the right of the row. It shows title, project, environment, branch (with a mismatch warning), provider + model, handoff origin, running terminals, last error, and PRs.

**Resizing** (`threadSidebarWidth.ts`, `AppSidebarLayout.tsx`):
- default 256px (`16 * 16`)
- min 208px or the measured wordmark width, whichever is larger
- max = viewport minus 640px (`THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16`); drags that would squeeze main content below 640px are rejected
- persisted in localStorage `chat_thread_sidebar_width`; double-clicking the rail resets it
- the rail is a 16px invisible button straddling the edge, with a 2px line on hover and tooltip "Drag to resize sidebar"

**Collapse:** `mod+b` or the floating top-left trigger (`PanelLeft` ↔ `PanelLeftClose`, outside the sidebar, offset 90px on macOS Electron to clear the traffic lights). The sidebar collapses offcanvas (slides to `left: -width`, the gap shrinks to 0, and it goes `inert`). State is persisted in the `sidebar_state` cookie. No icon-rail mode is used.

**Mobile** (`max-width: 767px`): renders in a left `Sheet` at `calc(100vw - var(--spacing(3)))`, safe-area padded, with no resize. Navigating, starting a thread or opening settings closes it. Icon buttons get 3rem invisible hit areas on coarse pointers.

**Keyboard:** an ARIA tree (`role="tree"` / `treeitem`) with a roving tabindex.
- Up/Down move, Home/End jump, Right/Left expand/collapse.
- Enter/Space opens, F2 renames, ContextMenu or Shift+F10 opens the menu.
- Global: `mod+shift+[` / `]` go to previous/next thread. `mod+1..9` jumps (desktop only, with hint badges after holding ⌘ for 200ms).

**Drag and drop:** dnd-kit, starting after 6px, locked to the vertical axis. Dropping between sections pins, unpins, settles or wakes, and the row shows a verb badge ("Pin", "Settle"). Optimistic order is held until the server confirms. Dropping OS files on a row opens that thread and attaches them.

**Motion:** a hand-rolled FLIP animator, 150ms ease-out, rows travel at most 40px, respects reduced motion.

**Empty states:**
- "No projects yet" plus an outline "Add project" button
- "No threads yet" / "No threads in <Project> yet"
- search: "Searching thread messages…" / "No threads found"

### 4.2 Verbatim evidence

#### 1.5 Resizing: widths, clamps, persistence key, double-click reset

Default width 256px (16*16), minimum 208px (13*16) or the measured brand/wordmark width if larger, maximum = viewport width minus 640px (main content min width 40*16). Persisted in localStorage key `chat_thread_sidebar_width`. A drag that would shrink the main pane below 640px is rejected (`shouldAcceptWidth`). Double-clicking the rail clears the stored width and resets to default.

`apps/web/src/components/threadSidebarWidth.ts:L1-L34`
```ts
export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_DEFAULT_WIDTH = 16 * 16;
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
export const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function resolveThreadSidebarMinimumWidth(brandWidth: number): number {
  return Math.max(THREAD_SIDEBAR_MIN_WIDTH, Math.ceil(brandWidth));
}

export function resolveThreadSidebarMaximumWidth(
  viewportWidth: number,
  minimumWidth = THREAD_SIDEBAR_MIN_WIDTH,
): number {
  return Math.max(minimumWidth, Math.floor(viewportWidth) - THREAD_MAIN_CONTENT_MIN_WIDTH);
}

export function clampThreadSidebarWidth(
  width: number,
  minimumWidth: number,
  maximumWidth: number,
): number {
  return Math.min(maximumWidth, Math.max(minimumWidth, width));
}

export function resolveInitialThreadSidebarWidth(
  storedWidth: number | null,
  viewportWidth: number,
): number {
  const preferredWidth =
    storedWidth === null
      ? THREAD_SIDEBAR_DEFAULT_WIDTH
      : Math.max(THREAD_SIDEBAR_MIN_WIDTH, storedWidth);
  return Math.min(preferredWidth, resolveThreadSidebarMaximumWidth(viewportWidth));
}
```

`apps/web/src/components/AppSidebarLayout.tsx:L115-L125`
```tsx
function readInitialThreadSidebarWidth(): number {
  try {
    return resolveInitialThreadSidebarWidth(
      getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite),
      window.innerWidth,
    );
  } catch (error) {
    console.error("Could not read persisted thread sidebar width.", error);
    return resolveInitialThreadSidebarWidth(null, window.innerWidth);
  }
}
```

`apps/web/src/components/AppSidebarLayout.tsx:L403-L480`
```tsx
export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const sidebarArea = workspaceAreaProps("sidebar", 0, "Threads");
  const [sidebarRouteReveal] = useState<SidebarRouteReveal>(() => ({
    observedKey: null,
    pendingKey: null,
  }));
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const pathname = useLocation({ select: (location) => location.pathname });
  const panelAnimationsSuppressed = usePanelNavigationSuppression(pathname);
  const routePanelAnimationsActive = panelAnimationsActive && !panelAnimationsSuppressed;
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  const [sidebarWidth, setSidebarWidth] = useState(readInitialThreadSidebarWidth);
  // A clamped drag may not change width, so viewport changes need a separate subscription.
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth);
  const [brandWidth, setBrandWidth] = useState(0);
  const sidebarMinimumWidth = resolveThreadSidebarMinimumWidth(brandWidth);
  const sidebarMaximumWidth = resolveThreadSidebarMaximumWidth(viewportWidth, sidebarMinimumWidth);
  const resetSidebarWidth = () => {
    try {
      removeLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY);
    } catch (error) {
      console.error("Could not clear persisted thread sidebar width.", error);
    }
    setSidebarWidth(resolveInitialThreadSidebarWidth(null, viewportWidth));
  };
  const isWindowFullscreen = useSyncExternalStore(
    subscribeToWindowFullscreen,
    readWindowFullscreen,
  );
  const windowControlsInsetStyle = (
    isMacosDesktop && !isWindowFullscreen
      ? { "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET }
      : {}
  ) as CSSProperties;
  const sidebarProviderStyle = {
    "--sidebar-width": `${clampThreadSidebarWidth(sidebarWidth, sidebarMinimumWidth, sidebarMaximumWidth)}px`,
    "--panel-animation-duration": `${panelAnimationDurationMs}ms`,
    ...windowControlsInsetStyle,
  } as CSSProperties;

  return (
    <PanelAnimationSuppressionProvider value={panelAnimationsSuppressed}>
      <SidebarProvider
        className="h-dvh! min-h-0!"
        data-panel-animations={routePanelAnimationsActive ? "true" : "false"}
        defaultOpen
        style={sidebarProviderStyle}
      >
        <SidebarBrandWidthProbe onWidthChange={setBrandWidth} />
        <Sidebar
          side="left"
          collapsible="offcanvas"
          data-app-sidebar=""
          {...sidebarArea}
          role="navigation"
          aria-label="Threads"
          resizable={{
            maxWidth: sidebarMaximumWidth,
            minWidth: sidebarMinimumWidth,
            shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
              nextWidth <= currentWidth ||
              wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
            storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
            onResize: setSidebarWidth,
          }}
          style={windowControlsInsetStyle}
        >
          <ThreadSidebar routeReveal={sidebarRouteReveal} />
          <SidebarRail onDoubleClick={resetSidebarWidth} />
        </Sidebar>
        {children}
        <BackgroundThreadAnnouncer />
        <SidebarControl />
      </SidebarProvider>
    </PanelAnimationSuppressionProvider>
  );
}
```


#### 1.17 Thread row: variants, states, classNames

Four variants: `card` (Pinned/Active/Working sections; ~78px tall, 3 lines: favicon + project name + status slot / title / meta line with branch, PR badge, terminal icon, remote-machine icon, provider icon stack), `slim` (Snoozed/Settled shelves; one 36px line: grayscale favicon, title, relative time or wake time), `folder` and `folder-multiline` (boring mode rows inside a project folder, indented `ps-9`). Rows are `role="treeitem"` divs inside `<li>`, `tabIndex={-1}` (roving focus is managed by the tree helper).

Surface states (`rowSurfaceClassName`): active route row `bg-sidebar-row-active` (+ thin ring in light mode); selected or being swept `bg-sidebar-row-selected`; unsent draft `bg-warning/4 hover:bg-warning/8`; "receded" (working/quiet already-seen threads) `text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover`, and working+receded rows also `opacity-70` until hover; default `bg-transparent hover:bg-sidebar-row-hover`. While dragging: opaque `bg-sidebar` with active gradient and `shadow-lg`. File drag-over: `ring-1 ring-inset ring-primary/70`.

`apps/web/src/components/sidebar/SidebarThreadRow.tsx:L534-L538`
```tsx
type SidebarThreadRowProps = {
  thread: SidebarThreadSummary;
  // "folder" is a one-line row inside a boring sidebar project folder;
  // "folder-multiline" adds the card's branch and PR line under it.
  variant: "card" | "slim" | "folder" | "folder-multiline";
```

`apps/web/src/components/sidebar/SidebarThreadRow.tsx:L944-L965`
```tsx
  const rowSurfaceClassName = cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    variantAction === "unsettle" &&
      !props.isActive &&
      "[&:not(:hover):not(:focus-within)_*]:text-secondary-label",
    props.isActive
      ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
      : isSelected || props.sweepAction !== null
        ? "bg-sidebar-row-selected text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
        : hasUnsentDraft
          ? cn(draftSurfaceClassName, "text-sidebar-foreground")
          : shouldRecede
            ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
    shouldRecede &&
      status === "working" &&
      "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
    isFileDragOver && "ring-1 ring-inset ring-primary/70",
    isFileDragOver && !props.isActive && !isSelected && "bg-sidebar-row-hover",
    props.sortable?.isDragging &&
      "bg-sidebar bg-linear-to-b from-sidebar-row-active to-sidebar-row-active text-sidebar-foreground opacity-100 shadow-lg",
  );
```

`apps/web/src/components/sidebar/SidebarThreadRow.tsx:L1005-L1043`
```tsx
  const title = isRenaming ? (
    <ThreadRenameInput
      title={renamingTitle}
      onTitleChange={onRenameTitleChange}
      onCommit={() => onCommitRename(threadRef, renamingTitle, thread.title)}
      onCancel={onCancelRename}
    />
  ) : (
    <span
      aria-hidden
      className={cn(
        "min-w-0 flex-1 text-start text-sm transition-opacity motion-reduce:transition-none",
        shouldRecede ? "font-normal" : "font-medium",
        variant !== "slim"
          ? cn(
              "truncate",
              shouldRecede
                ? "text-foreground/75 group-hover/sidebar-row:text-foreground group-focus-visible/sidebar-row:text-foreground"
                : status === "failed" && !isUnread && !isWoke
                  ? "text-foreground/95"
                  : "text-foreground",
            )
          : cn(
              "truncate group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground",
              shouldRecede
                ? "text-secondary-label"
                : props.isActive || isWoke || status === "input" || status === "request"
                  ? "text-foreground"
                  : isUnread
                    ? "text-muted-foreground"
                    : "text-secondary-label/70",
            ),
        isRegeneratingTitle && "opacity-55",
      )}
      dir={textDirection(thread.title)}
    >
      {thread.title}
    </span>
  );
```

`apps/web/src/components/Sidebar.logic.ts:L814-L834`
```ts
export function shouldRecedeSidebarThread(input: {
  status: SidebarThreadStatus;
  isUnread: boolean;
  isWoke: boolean;
  isActive: boolean;
  isSelected: boolean;
}): boolean {
  if (
    input.isActive ||
    input.isSelected ||
    input.status === "input" ||
    input.status === "request"
  ) {
    return false;
  }
  if (input.status === "working" || input.status === "waiting") return true;
  if (input.status === "ready" || input.status === "approval") {
    return !input.isUnread && !input.isWoke;
  }
  return false;
}
```


#### 1.19 Status indicators (row top-status), unread, working timer

Row status is derived from thread state with this precedence: approval (`ShieldQuestionIcon`, warning color, "Approval") > input (`MessageCircleQuestionIcon`, indigo, "Input") > guest request (`UserRoundIcon`, "Request") > waiting on another thread ("Waiting", `CircleDotDashedIcon`) > working (`CircleDashedIcon`, `text-info-foreground`, label "Working" or "Goal", plus a live per-second elapsed timer like `42s`, `3m`, `1h 5m`) > idle runtime = waiting > failed (`CircleAlertIcon`, `text-error-foreground`; usage-limit = "Limited" in warning color) > ready. If ready: "Woke" (snooze ended, unseen) or "Done" (`CircleCheckIcon`, `text-success-foreground`) when the latest run completed after the user's last visit (that is the "unread" signal; there is no separate dot). No spinner element; the working icon is a dashed circle. Receded rows dim instead of showing status.

A separate pill model (`resolveThreadStatusPill`) with colored dots and `pulse` for Working/Connecting is used elsewhere (ThreadStatusIndicators, boring folder dots); colors quoted below.

`apps/web/src/components/Sidebar.logic.ts:L846-L873`
```ts
export function resolveSidebarThreadStatus(thread: SidebarThreadStatusInput): SidebarThreadStatus {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  // A guest is waiting on the owner; the agent's own requests come first.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return "request";
  }
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
    return "waiting";
  }
  if (
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}
```

`apps/web/src/components/sidebar/SidebarThreadRow.tsx:L518-L532`
```tsx
const TOP_STATUS_ICONS = {
  working: CircleDashedIcon,
  waiting: CircleDotDashedIcon,
  input: MessageCircleQuestionIcon,
  request: UserRoundIcon,
  approval: ShieldQuestionIcon,
  failed: CircleAlertIcon,
  done: CircleCheckIcon,
  woke: AlarmClockIcon,
} as const;

function TopStatusIcon(props: { icon: keyof typeof TOP_STATUS_ICONS; className: string }) {
  const Icon = TOP_STATUS_ICONS[props.icon];
  return <Icon aria-hidden className={cn("shrink-0", props.className)} />;
}
```

`apps/web/src/components/sidebar/SidebarThreadRow.tsx:L708-L779`
```tsx
  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarThreadStatus(thread);
  const lastVisitedDate = lastVisitedAt === undefined ? null : parseTimestampDate(lastVisitedAt);
  const wokeAtDate = props.wokeAt === null ? null : parseTimestampDate(props.wokeAt);
  const isWoke =
    wokeAtDate !== null &&
    (lastVisitedDate === null || lastVisitedDate < wokeAtDate) &&
    thread.settledOverride !== "settled";
  const shouldRecede = shouldRecedeSidebarThread({
    status,
    isUnread,
    isWoke,
    isActive: props.isActive,
    isSelected,
  });
  const topStatus =
    status === "working"
      ? {
          label: thread.goal?.status === "active" ? "Goal" : "Working",
          icon: "working" as const,
          className: "text-info-foreground",
        }
      : status === "waiting"
        ? {
            label: "Waiting",
            icon: "waiting" as const,
            className: "text-muted-foreground",
          }
        : status === "approval"
          ? {
              label: "Approval",
              icon: "approval" as const,
              className: "text-warning-foreground",
            }
          : status === "input"
            ? {
                label: "Input",
                icon: "input" as const,
                className: "text-indigo-600 dark:text-indigo-300",
              }
            : status === "request"
              ? {
                  label: "Request",
                  icon: "request" as const,
                  className: "text-guest-foreground",
                }
              : status === "limited"
                ? {
                    label: "Limited",
                    icon: "failed" as const,
                    className: "text-warning-foreground",
                  }
                : status === "failed"
                  ? {
                      label: "Failed",
                      icon: "failed" as const,
                      className: "text-error-foreground",
                    }
                  : isWoke
                    ? {
                        label: "Woke",
                        icon: "woke" as const,
                        className: "text-warning-foreground",
                      }
                    : isUnread
                      ? {
                          label: "Done",
                          icon: "done" as const,
                          className: "text-success-foreground",
                        }
                      : null;
  const isWokeStatus = topStatus?.icon === "woke";
```

`apps/web/src/components/Sidebar.logic.ts:L688-L707`
```ts
export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestRun?.completedAt) return false;
  const completedAt = Date.parse(thread.latestRun.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

/** Unopened threads' failures still count as unseen, unlike completions. */
function hasUnseenFailure(thread: ThreadStatusInput): boolean {
  if (thread.latestRun?.status !== "failed") return false;
  if (!thread.lastVisitedAt) return true;
  const completedAt = Date.parse(thread.latestRun.completedAt ?? "");
  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(completedAt) || Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}
```

`apps/web/src/components/Sidebar.logic.ts:L1073-L1175`
```ts
export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
}): ThreadStatusPill | null {
  const { thread } = input;

  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return {
      label: "Guest Request",
      colorClass: "text-guest-foreground",
      dotClass: "bg-guest",
      pulse: false,
    };
  }

  if (
    (thread.runtime?.status === "running" && thread.blockedOnThreadWait !== true) ||
    thread.runtime?.status === "waiting"
  ) {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (
    thread.runtime?.status === "preparing" ||
    thread.runtime?.status === "starting" ||
    thread.runtime?.status === "queued"
  ) {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (
    (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) ||
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
  ) {
    return {
      label: "Waiting",
      colorClass: "text-sidebar-muted-foreground",
      dotClass: "bg-sidebar-muted-foreground",
      pulse: false,
    };
  }

  if (hasUnseenFailure(thread)) {
    return {
      label: "Failed",
      colorClass: "text-red-600 dark:text-red-300/90",
      dotClass: "bg-red-500 dark:bg-red-300/90",
      pulse: false,
    };
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestRunSettled(thread.latestRun, thread.runtime) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}
```

`apps/web/src/components/Sidebar.logic.ts:L879-L899`
```ts
export function resolveSidebarFolderDot(
  threads: ReadonlyArray<ThreadStatusInput & SidebarThreadStatusInput>,
): "attention" | "failed" | "unread" | "working" | null {
  const statuses = new Set(threads.map(resolveSidebarThreadStatus));
  if (
    statuses.has("input") ||
    statuses.has("approval") ||
    statuses.has("request") ||
    statuses.has("limited")
  ) {
    return "attention";
  }
  if (statuses.has("failed")) return "failed";
  // Rows show Done only for ready threads, so the dot follows the same rule.
  const hasUnread = threads.some(
    (thread) => resolveSidebarThreadStatus(thread) === "ready" && hasUnseenCompletion(thread),
  );
  if (hasUnread) return "unread";
  if (statuses.has("working")) return "working";
  return null;
}
```

`apps/web/src/components/ThreadStatusIndicators.tsx:L606-L657`
```tsx
function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="img"
              aria-label={status.label}
              className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
            />
          }
        >
          <span
            className={`size-[9px] rounded-full ${status.dotClass} ${
              status.pulse ? "motion-safe:animate-status-pulse" : ""
            }`}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{status.label}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={status.label}
            className={`inline-flex items-center gap-1 text-3xs ${status.colorClass}`}
          />
        }
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
            status.pulse ? "motion-safe:animate-status-pulse" : ""
          }`}
        />
        <span className="hidden md:inline">{status.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  );
}
```

`apps/web/src/index.css:L332-L345`
```css
  @keyframes status-pulse {
    0%,
    40% {
      opacity: 1;
      animation-timing-function: steps(6);
    }
    50%,
    90% {
      opacity: 0.5;
      animation-timing-function: steps(6);
    }
    100% {
      opacity: 1;
    }
```

Terminal process indicator: teal `TerminalIcon` with a stepped 2s opacity pulse, click opens the terminal.

`apps/web/src/components/ThreadStatusIndicators.tsx:L500-L570`
```tsx
export function terminalStatusFromRunningIds(
  runningTerminalIds: ReadonlyArray<string>,
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

function synchronizeTerminalPulse(event: AnimationEvent<SVGSVGElement>) {
  if (event.animationName !== "status-pulse") return;

  for (const animation of event.currentTarget.getAnimations()) {
    if ("animationName" in animation && animation.animationName === "status-pulse") {
      animation.startTime = 0;
    }
  }
}

export function ThreadTerminalStatusButton({
  threadRef,
  terminalIds,
  onThreadActivate,
}: {
  threadRef: ScopedThreadRef;
  terminalIds: readonly string[];
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
}) {
  const terminalId = terminalIds[0];
  if (terminalId === undefined) return null;
  const status = terminalStatusFromRunningIds(terminalIds);
  const label =
    terminalIds.length === 1
      ? "1 terminal process running. Open terminal"
      : `${terminalIds.length} terminal processes running. Open terminal`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            data-testid={`sidebar-terminal-status-${threadRef.threadId}`}
            className={cn(
              "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              status?.colorClass,
            )}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              revealThreadTerminal(threadRef, terminalId);
              onThreadActivate(threadRef);
            }}
          />
        }
      >
        <TerminalIcon
          className="size-3.5 motion-safe:animate-status-pulse"
          onAnimationStart={synchronizeTerminalPulse}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
```


#### 1.32 Essential sidebar JSX

Verbatim core render tree, assembled from the cited ranges in order (container -> layout -> header -> list -> project folder -> thread row -> footer). Each segment is introduced by a `// === path:Lstart-Lend ===` comment; `// ...` marks omitted lines. Shelf headers (Working/Snoozed/Settled) are quoted in section 1.23; the slim/folder row variant is quoted in section 1.33.

```tsx
// === apps/web/src/components/ui/sidebar.tsx:L341-L352 ===
  return (
    <SidebarInstanceContext value={instanceContextValue}>
      <div
        className="group peer hidden text-sidebar-foreground md:block"
        data-collapsible={state === "collapsed" ? collapsible : ""}
        data-collapsible-mode={collapsible}
        inert={offcanvasCollapsed}
        data-side={side}
        data-slot="sidebar"
        data-state={state}
        data-variant={variant}
      >
// ...
// === apps/web/src/components/ui/sidebar.tsx:L365-L391 ===
        <div
          className={cn(
            "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) md:flex",
            "[[data-panel-animations=true]_&]:transition-[left,right,width] [[data-panel-animations=true]_&]:[transition-duration:var(--panel-animation-duration)] [[data-panel-animations=true]_&]:ease-out",
            side === "left"
              ? "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]"
              : "right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]",
            variant === "floating" || variant === "inset"
              ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]"
              : "group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l",
            className,
          )}
          data-slot="sidebar-container"
          {...props}
        >
          <div
            className="flex h-full w-full flex-col bg-sidebar surface-grain group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow-sm/5"
            data-sidebar="sidebar"
            data-slot="sidebar-inner"
          >
            {children}
          </div>
        </div>
      </div>
    </SidebarInstanceContext>
  );
}

// === apps/web/src/components/AppSidebarLayout.tsx:L446-L477 ===
      <SidebarProvider
        className="h-dvh! min-h-0!"
        data-panel-animations={routePanelAnimationsActive ? "true" : "false"}
        defaultOpen
        style={sidebarProviderStyle}
      >
        <SidebarBrandWidthProbe onWidthChange={setBrandWidth} />
        <Sidebar
          side="left"
          collapsible="offcanvas"
          data-app-sidebar=""
          {...sidebarArea}
          role="navigation"
          aria-label="Threads"
          resizable={{
            maxWidth: sidebarMaximumWidth,
            minWidth: sidebarMinimumWidth,
            shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
              nextWidth <= currentWidth ||
              wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
            storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
            onResize: setSidebarWidth,
          }}
          style={windowControlsInsetStyle}
        >
          <ThreadSidebar routeReveal={sidebarRouteReveal} />
          <SidebarRail onDoubleClick={resetSidebarWidth} />
        </Sidebar>
        {children}
        <BackgroundThreadAnnouncer />
        <SidebarControl />
      </SidebarProvider>

// === apps/web/src/components/Sidebar.tsx:L2866-L2876 ===
  return (
    <>
      <ThreadContextDragGhost />
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <SidebarThreadHeader
              searchFieldRef={headerSearchRef}
              hasProjects={projectGroups.length > 0}
// ...
// === apps/web/src/components/Sidebar.tsx:L3043-L3064 ===
              onNewProject={openAddProjectCommandPalette}
              onNewThread={handleNewThreadClick}
              newThreadDisabled={projects.length === 0}
              newThreadShortcutLabel={newThreadShortcutLabel}
              newThreadInProjectShortcutLabel={newThreadInProjectShortcutLabel}
              showNewThreadInProjectHint={!boringSidebarEnabled && projectGroups.length > 1}
              searchInputRef={threadSearchInputRef}
              searchQuery={threadSearchQuery}
              onSearchQueryChange={(value) => {
                setThreadSearchQuery(value);
                setSearchHighlightKey(null);
              }}
              onSearchKeyDown={handleThreadSearchKeyDown}
              isSearching={isSearchingThreads}
              searchResultCount={threadSearchResults.length}
              activeSearchResultIndex={activeSearchResultIndex}
              onClearSearch={clearThreadSearch}
            />
          </SidebarGroup>
        }
      >
        <SidebarGroup className="flex-1" role="presentation">
// ...
// === apps/web/src/components/Sidebar.tsx:L3141-L3159 ===
              <DndContext
                sensors={dndSensors}
                autoScroll={!isContextDrag}
                collisionDetection={dndCollisionDetection}
                modifiers={dndModifiers}
                onDragStart={handleThreadDragStart}
                onDragOver={handleThreadDragOver}
                onDragEnd={handleThreadDragEnd}
              >
                <SortableContext items={sortableIds} strategy={sidebarSortingStrategy}>
                  <ul
                    {...SIDEBAR_TREE_PROPS}
                    ref={attachTreeRef}
                    className={cn(
                      "relative flex flex-col gap-px",
                      sidebarListItems.length > 0 && "flex-1",
                      actionSweep !== null && "**:pointer-events-none",
                    )}
                  >
// ...
// === apps/web/src/components/Sidebar.tsx:L3179-L3192 ===
                        return (
                          <SortableThreadRow
                            key={threadKey}
                            sortableId={threadKey}
                            contextDrag={isContextDrag}
                            sortableDisabled={
                              projectFolders !== null ||
                              renamingThreadKey === threadKey ||
                              !draggableThreadKeys.has(threadKey) ||
                              optimisticDrop !== null
                            }
                            thread={thread}
                            variant={rowVariant}
                            navigationParent={
// ...
// === apps/web/src/components/Sidebar.tsx:L3440-L3441 ===
                      return items;
                    })()}
// ...
// === apps/web/src/components/Sidebar.tsx:L3467-L3471 ===
                  </ul>
                </SortableContext>
              </DndContext>
            </TooltipProvider>
          ) : null}
// ...
// === apps/web/src/components/Sidebar.tsx:L3503-L3510 ===
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter
        showUndoNotice={isSearchingThreads || sidebarListItemsFresh.length === 0}
      />
    </>
  );
}

// === apps/web/src/components/sidebar/SidebarChrome.tsx:L50-L76 ===
  return (
    <div
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
        <SidebarTrigger
          variant={backdropVariant ? "media-navigation" : "ghost"}
          className="relative top-auto translate-y-0"
          aria-label="Toggle main sidebar"
        />
      </div>
      <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
        <SidebarBrand onBackdrop={backdropVariant !== null} />
        {pillLabel ? (
          <div className="ml-1 flex h-7 items-center">
            <Badge data-environment-identification="pill" size="sm" variant="secondary">
              {pillLabel}
            </Badge>
          </div>
        ) : null}
      </div>
    </div>
  );

// === apps/web/src/components/sidebar/SidebarThreadHeader.tsx:L61-L66 ===
  return (
    <div className="flex items-center gap-1">
      <div
        ref={searchFieldRef}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-within:bg-sidebar-row-hover focus-within:text-sidebar-foreground focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring/70"
      >
// ...
// === apps/web/src/components/sidebar/SidebarThreadHeader.tsx:L104-L135 ===
      <div className="flex shrink-0 items-center">
        {hasProjects ? (
          <>
            {projectScope}
            <SidebarHeaderIconButton label="Add project" onClick={onNewProject}>
              <FolderPlusIcon />
            </SidebarHeaderIconButton>
          </>
        ) : null}
        <SidebarHeaderIconButton
          label="New thread"
          tooltip={
            showNewThreadInProjectHint ? (
              <span className="flex flex-col gap-0.5">
                <span>{newThreadLabel}</span>
                <span className="text-muted-foreground">
                  New thread in current project: Shift+click
                  {newThreadInProjectShortcutLabel ? ` (${newThreadInProjectShortcutLabel})` : ""}
                </span>
              </span>
            ) : (
              newThreadLabel
            )
          }
          disabled={newThreadDisabled}
          onClick={onNewThread}
        >
          <SquarePenIcon />
        </SidebarHeaderIconButton>
      </div>
    </div>
  );

// === apps/web/src/components/sidebar/SidebarProjectFolderHeader.tsx:L61-L100 ===
  return (
    <li
      data-testid="sidebar-project-folder"
      className="group/project-folder relative mt-2 list-none first:mt-0"
    >
      <button
        type="button"
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={rowId}
        aria-expanded={!collapsed}
        onClick={() => props.onToggle(group)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(group, { x: event.clientX, y: event.clientY });
        }}
        className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ProjectFavicon project={group} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
          {group.displayName}
        </span>
        {dot ? (
          <span className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[dot])}>
            <span className="sr-only">{FOLDER_DOT_LABEL[dot]}</span>
          </span>
        ) : null}
        {collapsed && hiddenThreads.length > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground group-hover/project-folder:invisible pointer-coarse:invisible">
            {hiddenThreads.length}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      </button>
// ...

// === apps/web/src/components/sidebar/SidebarThreadRow.tsx:L1383-L1430 ===
  return (
    <li
      data-thread-item={threadKey}
      {...sortableRootProps}
      {...(fileDropHandlers ?? {})}
      className={cn(
        "list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_78px]",
        metaLineEmpty && "[contain-intrinsic-size:auto_58px]",
        sortable?.isDragging && "relative z-20",
      )}
    >
      <Tooltip disabled={snoozeMenuOpen || sortable?.isDragging}>
        <TooltipTrigger
          render={
            <div
              ref={rowRef}
              role="treeitem"
              tabIndex={-1}
              data-sidebar-row={threadKey}
              data-sidebar-parent={props.navigationParent}
              aria-label={accessibility.label}
              aria-current={accessibility.current}
              data-testid="sidebar-row-card"
              aria-busy={isRegeneratingTitle || undefined}
              className={rowSurfaceClassName}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onKeyDown={handleKeyDown}
              onContextMenu={handleContextMenu}
            />
          }
        >
          {accessibleTitle}
          <div
            className={cn(
              "relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)",
              metaLineEmpty && "h-auto",
            )}
          >
            <div className="flex h-5 min-w-0 items-center gap-1.5">
              {draftIndicator}
              {props.project ? (
                <ProjectFavicon project={props.project} className="size-4 shrink-0" />
              ) : null}
              {/* Left of the status slot, the pin would slide when hover swaps the
                label for the wider row controls. */}
              {pinIndicator}
              {props.projectDisplayName ? (
// ...
// === apps/web/src/components/sidebar/SidebarThreadRow.tsx:L1565-L1581 ===
            <div className="mt-1 flex min-w-0 items-center gap-1.5">
              {title}
              {isRegeneratingTitle ? (
                <span role="status" className="sr-only">
                  Regenerating title
                </span>
              ) : null}
              {titleLineProviderStack}
            </div>
            {metaLine}
          </div>
          {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
        </TooltipTrigger>
        {detailsTooltip}
      </Tooltip>
    </li>
  );

// === apps/web/src/components/sidebar/SidebarChrome.tsx:L231-L244 ===
export const SidebarChromeFooter = memo(function SidebarChromeFooter({
  showUndoNotice = false,
}: {
  showUndoNotice?: boolean;
}) {
  return (
    <SidebarFooter>
      {showUndoNotice ? <SidebarThreadUndoNotice /> : null}
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
```


#### 1.33 Exact className strings (quick reference)

Sidebar container (desktop fixed panel + inner surface), see also 1.2:

`apps/web/src/components/ui/sidebar.tsx:L365-L386`
```tsx
        <div
          className={cn(
            "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) md:flex",
            "[[data-panel-animations=true]_&]:transition-[left,right,width] [[data-panel-animations=true]_&]:[transition-duration:var(--panel-animation-duration)] [[data-panel-animations=true]_&]:ease-out",
            side === "left"
              ? "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]"
              : "right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]",
            variant === "floating" || variant === "inset"
              ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]"
              : "group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l",
            className,
          )}
          data-slot="sidebar-container"
          {...props}
        >
          <div
            className="flex h-full w-full flex-col bg-sidebar surface-grain group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow-sm/5"
            data-sidebar="sidebar"
            data-slot="sidebar-inner"
          >
            {children}
          </div>
```

Project folder header row (boring mode) button className, and the folder's hover new-thread button:

`apps/web/src/components/sidebar/SidebarProjectFolderHeader.tsx:L77-L77`
```tsx
        className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
```

`apps/web/src/components/sidebar/SidebarProjectFolderHeader.tsx:L102-L111`
```tsx
      <span className="absolute inset-y-0 right-6 flex items-center opacity-0 focus-within:opacity-100 group-hover/project-folder:opacity-100 pointer-coarse:opacity-100">
        <Button
          data-sidebar-action-for={rowId}
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`New thread in ${group.displayName}`}
          onClick={() => props.onNewThread(group)}
        >
          <SquarePenIcon aria-hidden />
        </Button>
```

Shelf/section header row (Working/Snoozed/Settled) className:

`apps/web/src/components/ui/collapsible-section-header.tsx:L29-L33`
```tsx
      className={cn(
        "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        variant === "panel" ? "ps-2 pe-2.5" : "px-2",
        tones[tone].label,
      )}
```

Thread row surface: default / hover / active / selected / draft / receded / dragging (all variants share this):

`apps/web/src/components/sidebar/SidebarThreadRow.tsx:L944-L965`
```tsx
  const rowSurfaceClassName = cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    variantAction === "unsettle" &&
      !props.isActive &&
      "[&:not(:hover):not(:focus-within)_*]:text-secondary-label",
    props.isActive
      ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
      : isSelected || props.sweepAction !== null
        ? "bg-sidebar-row-selected text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
        : hasUnsentDraft
          ? cn(draftSurfaceClassName, "text-sidebar-foreground")
          : shouldRecede
            ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
    shouldRecede &&
      status === "working" &&
      "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
    isFileDragOver && "ring-1 ring-inset ring-primary/70",
    isFileDragOver && !props.isActive && !isSelected && "bg-sidebar-row-hover",
    props.sortable?.isDragging &&
      "bg-sidebar bg-linear-to-b from-sidebar-row-active to-sidebar-row-active text-sidebar-foreground opacity-100 shadow-lg",
  );
```

Card row inner layout (li + content box), and slim/folder row layout:

`apps/web/src/components/sidebar/SidebarThreadRow.tsx:L1388-L1392`
```tsx
      className={cn(
        "list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_78px]",
        metaLineEmpty && "[contain-intrinsic-size:auto_58px]",
        sortable?.isDragging && "relative z-20",
      )}
```

`apps/web/src/components/sidebar/SidebarThreadRow.tsx:L1416-L1422`
```tsx
          <div
            className={cn(
              "relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)",
              metaLineEmpty && "h-auto",
            )}
          >
            <div className="flex h-5 min-w-0 items-center gap-1.5">
```

`apps/web/src/components/sidebar/SidebarThreadRow.tsx:L1192-L1254`
```tsx
  if (variant !== "card") {
    const multiline = variant === "folder-multiline";
    const inFolder = variant === "folder" || multiline;
    return (
      <li
        data-thread-item={threadKey}
        {...sortableRootProps}
        {...(fileDropHandlers ?? {})}
        className={cn(
          "list-none [content-visibility:auto] [contain-intrinsic-size:auto_36px]",
          metaLine !== null && multiline && "[contain-intrinsic-size:auto_54px]",
          sortable?.isDragging && "relative z-20",
        )}
      >
        <Tooltip disabled={sortable?.isDragging}>
          <TooltipTrigger
            render={
              <div
                ref={rowRef}
                role="treeitem"
                tabIndex={-1}
                data-sidebar-row={threadKey}
                data-sidebar-parent={props.navigationParent}
                aria-label={accessibility.label}
                aria-current={accessibility.current}
                data-testid={inFolder ? "sidebar-row-folder" : "sidebar-row-slim"}
                aria-busy={isRegeneratingTitle || undefined}
                className={cn(
                  rowSurfaceClassName,
                  multiline
                    ? "flex flex-col justify-center px-2.5 py-1.5"
                    : "flex h-9 items-center gap-2.5 px-2.5",
                  // Lines titles up with the folder name, past its chevron and icon.
                  inFolder && "ps-9",
                )}
                onClick={handleClick}
                onDoubleClick={handleDoubleClick}
                onKeyDown={handleKeyDown}
                onContextMenu={handleContextMenu}
              />
            }
          >
            {/* `contents` keeps one-line rows a single flex row. */}
            <div className={multiline ? "flex h-6 min-w-0 items-center gap-2.5" : "contents"}>
              {accessibleTitle}
              {inFolder ? null : (
                <span
                  className={cn(
                    "flex shrink-0 items-center transition-opacity",
                    (!props.isActive || variantAction === "unsettle") &&
                      "opacity-40 grayscale group-focus-within/sidebar-row:opacity-100 group-focus-within/sidebar-row:grayscale-0 group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
                  )}
                >
                  {props.project ? (
                    <ProjectFavicon project={props.project} className="size-4" />
                  ) : null}
                </span>
              )}
              {draftIndicator}
              {title}
              {multiline ? titleLineProviderStack : null}
              {pinIndicator}
              {multiline ? null : terminalStatusIcon}
```

New-thread button: rendered via `SidebarHeaderIconButton` (a `SidebarMenuButton size="icon"` with `relative size-7 shrink-0`), so its effective classes are the `sidebarMenuButtonVariants` base + `icon` size + default variant (quoted in 1.4: `size-8 justify-center rounded-[var(--control-radius)] p-0`, `font-medium text-sidebar-muted-foreground/80`, `hover:bg-sidebar-row-hover`), overridden to `size-7`:

`apps/web/src/components/sidebar/SidebarThreadHeader.tsx:L113-L132`
```tsx
        <SidebarHeaderIconButton
          label="New thread"
          tooltip={
            showNewThreadInProjectHint ? (
              <span className="flex flex-col gap-0.5">
                <span>{newThreadLabel}</span>
                <span className="text-muted-foreground">
                  New thread in current project: Shift+click
                  {newThreadInProjectShortcutLabel ? ` (${newThreadInProjectShortcutLabel})` : ""}
                </span>
              </span>
            ) : (
              newThreadLabel
            )
          }
          disabled={newThreadDisabled}
          onClick={onNewThread}
        >
          <SquarePenIcon />
        </SidebarHeaderIconButton>
```

`apps/web/src/components/sidebar/SidebarThreadHeader.tsx:L153-L174`
```tsx
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            {...rest}
            className={cn("relative size-7 shrink-0", className)}
          />
        }
      >
        {children}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
```

`apps/web/src/components/ui/sidebar.tsx:L711-L732`
```tsx
const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full cursor-pointer items-center gap-[var(--sidebar-control-gap)] overflow-hidden text-left outline-hidden ring-ring transition-[width,height,padding] hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset active:bg-sidebar-row-active active:text-sidebar-foreground disabled:pointer-events-none disabled:opacity-64 aria-disabled:pointer-events-none aria-disabled:opacity-64 data-[active=true]:bg-sidebar-row-selected data-[active=true]:font-medium data-[active=true]:text-sidebar-foreground data-[state=open]:hover:bg-sidebar-row-hover data-[state=open]:hover:text-sidebar-foreground group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-[var(--sidebar-content-inset)]! [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-[var(--sidebar-icon-color)] hover:[&>svg]:text-sidebar-foreground active:[&>svg]:text-sidebar-foreground data-[active=true]:[&>svg]:text-sidebar-foreground",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default:
          "h-8 rounded-[var(--control-radius)] px-[var(--sidebar-row-content-inset)] py-1.5 text-sm",
        icon: "size-8 justify-center rounded-[var(--control-radius)] p-0",
        lg: "h-12 rounded-[var(--control-radius)] px-[var(--sidebar-row-content-inset)] py-2 text-sm group-data-[collapsible=icon]:p-0!",
        sm: "h-7 rounded-[var(--control-radius)] px-[var(--sidebar-row-content-inset)] py-2 text-xs",
      },
      variant: {
        default: "font-medium text-sidebar-muted-foreground/80",
        outline: "bg-sidebar-control-surface ring-1 ring-sidebar-border",
      },
    },
  },
);
```

Search field wrapper (header):

`apps/web/src/components/sidebar/SidebarThreadHeader.tsx:L63-L66`
```tsx
      <div
        ref={searchFieldRef}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-within:bg-sidebar-row-hover focus-within:text-sidebar-foreground focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring/70"
      >
```


## 5. Favicons and branding

### 5.1 Summary

**Render pipeline** (`apps/web/src/components/ProjectFavicon.tsx`), in order:
1. A user override (`projectIcon.kind` = `monogram` | `emoji` | `lucide`).
2. The server-resolved favicon image.
3. A generated monogram from the project title (`FolderCodeIcon` only if the title is empty).

Image loading is double-buffered. A hidden `<img>` preloads the new src, and the monogram shows until it loads or if it errors, so there's never a broken-image flash.

**Monogram** (`ProjectMonogram.tsx`, `projectIdentity.ts`, `projectIconColors.ts`): a 16x16 viewBox SVG with `rounded-[25%]`. The background is `color-mix(in srgb, currentColor 14%, transparent)`, a 14% tint of the glyph color, with bold mono letters. Two letters are squeezed with `textLength=12 lengthAdjust="spacingAndGlyphs"`.

Letter rule: the first glyph of the first word, plus the first digit in that word, else the first glyph of the last word, else the last glyph of the first word. Uppercased. Falls back to `"PR"` if there are no letters.

Color: `index = (index * 31 + codePoint) % 18` over the NFKC-lowercased name, into an 18-hue Tailwind palette (600 in light, 400 in dark). Default wrapper is `size-4`.

**Server discovery** (`ProjectFaviconResolver`, wired in `apps/server/src/server.ts`), in order:
1. The stored per-project `faviconPath` override.
2. `iconPath` from the repo's `t3.json`.
3. 23 well-known candidate paths, probed concurrently but taken in list order.
4. `<link rel="icon">` hrefs parsed from HTML / root-route source files (including TanStack/Remix object literals), resolved under `public/` and then the repo root.

It does **not** read package.json. Cache: capacity 512, 10 min TTL for hits, 1 min for misses. A hit is re-stat'ed on every lookup.

**Security.**
- Candidates go through `resolveRelativePathWithinRoot`, which rejects absolute paths and `..`.
- At mint time and again at serve time, `realpath` containment is checked, so symlinks out of the repo are refused.
- Assets are served via signed URLs with an extension allowlist.
- The client caches 96px/48px WebP thumbnails in IndexedDB `t3code:project-favicons`. Limits: 4 MB source, 32 KB per entry, 128 entries.

**App branding.**
- `index.html` links `/favicon.ico` (48x48), `/apple-touch-icon.png` and `/manifest.webmanifest`, with `theme-color #000000`.
- A boot splash shows the 64px app icon until React mounts, and an inline script paints theme colors first to avoid a flash.
- Dev, nightly and prod use different icon sets. `apps/web/public` holds the dev "blueprint" set, and hosted builds overwrite it via `scripts/apply-web-brand-assets.ts`.
- Title: `T3 Code (<Stage>)`, e.g. `T3 Code (Beta)` in `index.html`.

**Unread badge favicon.** When threads need attention, a 64x64 canvas favicon is drawn: red circle `#e5484d`, white bold count, `9+` cap. It replaces `<link rel="icon">` in the browser and goes to the dock badge on desktop, driven by `ThreadNotificationCoordinator`.

### 5.2 Verbatim evidence

#### Project icon render pipeline (ProjectFavicon)

`ProjectFavicon` picks in this order: a user override (`projectIcon.kind` = `monogram` | `emoji` | `lucide`), then the server-resolved favicon image URL, then a generated monogram from the project title (FolderCodeIcon only when the title is empty). Lucide overrides load all lucide icons as one lazy chunk. Image loading is double-buffered: a hidden `<img>` preloads the new `src`, and the monogram fallback shows until it loads or if it errors.

`apps/web/src/components/ProjectFavicon.tsx:L1-L111`
```tsx
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  getProjectFaviconResourceKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import { FolderCodeIcon } from "lucide-react";
import type { ComponentType } from "react";
import { createElement, lazy, Suspense, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { projectFaviconUrlAtom } from "../state/assets";
import { deriveProjectIdentity } from "../projectIdentity";
import { projectIconColorClassName } from "../projectIconColors";
import { ProjectMonogram } from "./ProjectMonogram";
import { cn } from "~/lib/utils";

// All lucide icons load as one chunk, only once a project uses a lucide override.
const LucideProjectIcon = lazy(() =>
  import("../lib/lucideIconByName").then(({ lucideIconByName }) => ({
    default: function LucideProjectIcon(props: { name: string; className: string }) {
      return createElement(lucideIconByName(props.name) ?? FolderCodeIcon, {
        className: props.className,
      });
    },
  })),
);

function DynamicProjectIconFallback() {
  return <FolderCodeIcon className="size-full text-inherit" />;
}

export type ProjectFaviconProject = Pick<
  EnvironmentProject,
  "environmentId" | "workspaceRoot" | "title" | "faviconPath" | "projectIcon"
>;
export function ProjectFavicon(input: {
  project: ProjectFaviconProject;
  className?: string | undefined;
  fallbackIcon?: ComponentType<{ className?: string }>;
}) {
  const { project } = input;
  const src = useAtomValue(
    projectFaviconUrlAtom({
      environmentId: project.environmentId,
      cwd: project.workspaceRoot,
      faviconPath: project.faviconPath,
    }),
  );
  if (project.projectIcon?.kind === "monogram") {
    return (
      <ProjectMonogram
        text={project.projectIcon.text}
        color={project.projectIcon.color}
        className={input.className}
      />
    );
  }
  if (project.projectIcon?.kind === "emoji") {
    return (
      <ProjectFaviconFallback
        className={input.className}
        icon={FolderCodeIcon}
        emoji={project.projectIcon.emoji}
      />
    );
  }
  if (project.projectIcon?.kind === "lucide") {
    const colorClassName = projectIconColorClassName(project.projectIcon.color);
    const iconClassName = cn(
      "inline-flex size-3.5 shrink-0 items-center justify-center",
      colorClassName,
      input.className,
    );
    return (
      <span aria-hidden="true" className={iconClassName}>
        <Suspense fallback={<DynamicProjectIconFallback />}>
          <LucideProjectIcon
            name={project.projectIcon.name}
            className={cn("size-full", colorClassName)}
          />
        </Suspense>
      </span>
    );
  }
  const FallbackIcon = input.fallbackIcon ?? FolderCodeIcon;

  if (!src || isProjectFaviconFallbackUrl(src)) {
    return (
      <ProjectFaviconFallback
        className={input.className}
        icon={FallbackIcon}
        projectName={project.title}
      />
    );
  }

  const cacheKey = getProjectFaviconResourceKey(
    project.environmentId,
    project.workspaceRoot,
    project.faviconPath,
  );

  return (
    <ProjectFaviconImage
      key={cacheKey}
      src={src}
      className={input.className}
      fallbackIcon={FallbackIcon}
      fallbackProjectName={project.title}
    />
  );
}
```

Fallback and image sub-components. Default size is `size-3.5` (14px); image gets `rounded-[25%] object-contain`. Emoji is sized via container query (`text-[length:80cqh]`).

`apps/web/src/components/ProjectFavicon.tsx:L113-L197`
```tsx
function ProjectFaviconFallback({
  className,
  icon: Icon,
  emoji,
  projectName,
}: {
  readonly className?: string | undefined;
  readonly icon: ComponentType<{ className?: string }>;
  readonly emoji?: string | undefined;
  readonly projectName?: string | undefined;
}) {
  if (projectName && projectName.trim().length > 0) {
    const identity = deriveProjectIdentity(projectName);
    return (
      <ProjectMonogram text={identity.monogram} color={identity.color} className={className} />
    );
  }

  if (emoji) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-3.5 shrink-0 items-center justify-center leading-none [container-type:size]",
          className,
        )}
      >
        <span className="text-[length:80cqh] leading-none">{emoji}</span>
      </span>
    );
  }

  return <Icon className={cn("size-3.5 shrink-0 text-icon-muted", className)} />;
}

function ProjectFaviconImage({
  src,
  className,
  fallbackIcon: FallbackIcon,
  fallbackProjectName,
}: {
  readonly src: string;
  readonly className?: string | undefined;
  readonly fallbackIcon: ComponentType<{ className?: string }>;
  readonly fallbackProjectName?: string | undefined;
}) {
  const [displayedSrc, setDisplayedSrc] = useState<string | null>(() =>
    src.startsWith("data:image/") ? src : null,
  );
  const isLoading = displayedSrc !== src;
  const handleLoadError = (failedSrc: string) => {
    setDisplayedSrc((currentSrc) => (currentSrc === failedSrc ? null : currentSrc));
  };

  return (
    <>
      {displayedSrc === null ? (
        <ProjectFaviconFallback
          className={className}
          icon={FallbackIcon}
          projectName={fallbackProjectName}
        />
      ) : null}
      {displayedSrc ? (
        <img
          src={displayedSrc}
          alt=""
          className={cn("size-3.5 shrink-0 rounded-[25%] object-contain", className)}
          onError={() => handleLoadError(displayedSrc)}
        />
      ) : null}
      {isLoading ? (
        <img
          src={src}
          alt=""
          className="hidden"
          onLoad={() => {
            setDisplayedSrc(src);
          }}
          onError={() => handleLoadError(src)}
        />
      ) : null}
    </>
  );
}
```


#### Monogram tile (ProjectMonogram)

A 16x16 viewBox SVG with `rounded-[25%]`, background `color-mix(in srgb, currentColor 14%, transparent)` (a 14% tint of the text color), bold mono text. One grapheme gets `textLength=6`, two get `textLength=12` with `lengthAdjust="spacingAndGlyphs"` so letters are squeezed to fit. Wrapper default is `size-4`.

`apps/web/src/components/ProjectMonogram.tsx:L1-L49`
```tsx
import type { ProjectIconColor } from "@t3tools/contracts";
import { projectIconColorClassName } from "../projectIconColors";
import { cn } from "~/lib/utils";

const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function ProjectMonogram({
  text,
  color,
  className,
}: {
  readonly text: string;
  readonly color: ProjectIconColor;
  readonly className?: string | undefined;
}) {
  // Wrap the tile to avoid menu/button SVG margin trimming.
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
    >
      <svg
        viewBox="0 0 16 16"
        className={cn(
          "size-full overflow-hidden rounded-[25%] font-mono select-none",
          projectIconColorClassName(color),
        )}
        style={{
          backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)",
        }}
      >
        <text
          x="8"
          y="10.8"
          textAnchor="middle"
          fill="currentColor"
          className="font-mono"
          fontSize="8.25"
          fontWeight="700"
          textLength={Array.from(monogramSegmenter.segment(text)).length === 1 ? 6 : 12}
          lengthAdjust="spacingAndGlyphs"
          textRendering="geometricPrecision"
        >
          {text}
        </text>
      </svg>
    </span>
  );
}
```


#### Monogram letters and color hashing (projectIdentity)

Letters: first glyph of the first word, plus (a) the first digit later in the first word, else (b) the first glyph of the last word if there are multiple words, else (c) the last glyph of the first word. Uppercased, max 2 graphemes; `"PR"` if the name has no letters/digits. Color: polynomial hash `index = (index * 31 + codePoint) % 18` over the NFKC-normalized, lowercased name (seed `"project"` if empty), indexing into the 18-color palette, defaulting to `"blue"`.

`apps/web/src/projectIdentity.ts:L1-L41`
```tsx
import { PROJECT_ICON_COLORS } from "./projectIconColors";
import type { ProjectIconColor } from "@t3tools/contracts";

export interface ProjectIdentity {
  readonly monogram: string;
  readonly color: ProjectIconColor;
}

function normalizeProjectName(projectName: string): string {
  return projectName.normalize("NFKC").trim();
}

function projectMonogram(projectName: string): string {
  const words = normalizeProjectName(projectName).match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0];
  if (!firstWord) return "PR";

  const glyphs = Array.from(firstWord);
  const first = glyphs[0] ?? "P";
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : glyphs.at(-1)) ??
    first;
  return Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("");
}

function projectColor(projectName: string): ProjectIconColor {
  const seed = normalizeProjectName(projectName).toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) {
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % PROJECT_ICON_COLORS.length;
  }
  return PROJECT_ICON_COLORS[index]?.value ?? "blue";
}

export function deriveProjectIdentity(projectName: string): ProjectIdentity {
  return {
    monogram: projectMonogram(projectName),
    color: projectColor(projectName),
  };
}
```


#### Icon color palette (projectIconColors)

18 Tailwind hues. Each entry has a text color class (600 in light, 400 in dark) used for the glyph (the tile background is derived from it via `currentColor`), and a `-500` swatch class used in the picker. The order matters because the hash indexes into it.

`apps/web/src/projectIconColors.ts:L1-L125`
```tsx
import type { ProjectIconColor } from "@t3tools/contracts";

export const PROJECT_ICON_COLORS: ReadonlyArray<{
  readonly value: ProjectIconColor;
  readonly label: string;
  readonly className: string;
  readonly swatchClassName: string;
}> = [
  {
    value: "gray",
    label: "Gray",
    className: "text-gray-600 dark:text-gray-400",
    swatchClassName: "bg-gray-500",
  },
  {
    value: "red",
    label: "Red",
    className: "text-red-600 dark:text-red-400",
    swatchClassName: "bg-red-500",
  },
  {
    value: "orange",
    label: "Orange",
    className: "text-orange-600 dark:text-orange-400",
    swatchClassName: "bg-orange-500",
  },
  {
    value: "amber",
    label: "Amber",
    className: "text-amber-600 dark:text-amber-400",
    swatchClassName: "bg-amber-500",
  },
  {
    value: "yellow",
    label: "Yellow",
    className: "text-yellow-600 dark:text-yellow-400",
    swatchClassName: "bg-yellow-500",
  },
  {
    value: "lime",
    label: "Lime",
    className: "text-lime-600 dark:text-lime-400",
    swatchClassName: "bg-lime-500",
  },
  {
    value: "green",
    label: "Green",
    className: "text-green-600 dark:text-green-400",
    swatchClassName: "bg-green-500",
  },
  {
    value: "emerald",
    label: "Emerald",
    className: "text-emerald-600 dark:text-emerald-400",
    swatchClassName: "bg-emerald-500",
  },
  {
    value: "teal",
    label: "Teal",
    className: "text-teal-600 dark:text-teal-400",
    swatchClassName: "bg-teal-500",
  },
  {
    value: "cyan",
    label: "Cyan",
    className: "text-cyan-600 dark:text-cyan-400",
    swatchClassName: "bg-cyan-500",
  },
  {
    value: "sky",
    label: "Sky",
    className: "text-sky-600 dark:text-sky-400",
    swatchClassName: "bg-sky-500",
  },
  {
    value: "blue",
    label: "Blue",
    className: "text-blue-600 dark:text-blue-400",
    swatchClassName: "bg-blue-500",
  },
  {
    value: "indigo",
    label: "Indigo",
    className: "text-indigo-600 dark:text-indigo-400",
    swatchClassName: "bg-indigo-500",
  },
  {
    value: "violet",
    label: "Violet",
    className: "text-violet-600 dark:text-violet-400",
    swatchClassName: "bg-violet-500",
  },
  {
    value: "purple",
    label: "Purple",
    className: "text-purple-600 dark:text-purple-400",
    swatchClassName: "bg-purple-500",
  },
  {
    value: "fuchsia",
    label: "Fuchsia",
    className: "text-fuchsia-600 dark:text-fuchsia-400",
    swatchClassName: "bg-fuchsia-500",
  },
  {
    value: "pink",
    label: "Pink",
    className: "text-pink-600 dark:text-pink-400",
    swatchClassName: "bg-pink-500",
  },
  {
    value: "rose",
    label: "Rose",
    className: "text-rose-600 dark:text-rose-400",
    swatchClassName: "bg-rose-500",
  },
];

const PROJECT_ICON_COLOR_CLASSES = Object.fromEntries(
  PROJECT_ICON_COLORS.map(({ value, className }) => [value, className]),
) as Record<ProjectIconColor, string>;

export function projectIconColorClassName(color: ProjectIconColor): string {
  return PROJECT_ICON_COLOR_CLASSES[color];
}
```

The same 18 values are the server contract enum. Override schema: lucide name is kebab-case max 64 chars; emoji max 32 chars; monogram text max 32 chars, letters/numbers only. A custom favicon path (`ProjectFaviconPath`) must end in an allowed image extension and be at most 1024 chars.

`packages/contracts/src/project.ts:L46-L106`
```ts
export const ProjectIconColor = Schema.Literals([
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
]);
export type ProjectIconColor = typeof ProjectIconColor.Type;

const ProjectLucideIconName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);

const ProjectEmoji = TrimmedNonEmptyString.check(Schema.isMaxLength(32));

// Grapheme-count validation belongs to the server command boundary, not snapshot decoding.
export const ProjectMonogramText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^[\p{L}\p{N}][\p{L}\p{N}\p{M}\u200c\u200d]*$/u),
);

const ProjectLucideIcon = Schema.Struct({
  kind: Schema.Literal("lucide"),
  name: ProjectLucideIconName,
  color: ProjectIconColor,
});
const ProjectEmojiIcon = Schema.Struct({
  kind: Schema.Literal("emoji"),
  emoji: ProjectEmoji,
});
const ProjectMonogramIcon = Schema.Struct({
  kind: Schema.Literal("monogram"),
  text: ProjectMonogramText,
  color: ProjectIconColor,
});
export const ProjectFaviconPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(/\.(?:avif|gif|icns|ico|jpe?g|png|svg|webp)$/i),
);
export type ProjectFaviconPath = typeof ProjectFaviconPath.Type;

export const ProjectIconOverride = Schema.Union([
  ProjectLucideIcon,
  ProjectEmojiIcon,
  ProjectMonogramIcon,
]);
export type ProjectIconOverride = typeof ProjectIconOverride.Type;
```


#### Server: how a project's favicon is discovered (ProjectFaviconResolver)

Resolution order: (1) the project's stored `faviconPath` override (may be an absolute path anywhere on the filesystem, "filesystem" scope); (2) `iconPath` from the repo's `t3.json` project file (workspace-relative); (3) a fixed list of 23 well-known candidate paths, probed concurrently but taken in list order; (4) parse `<link rel="icon"|"shortcut icon" href=...>` out of a set of HTML/root-route source files (also handles object-literal `rel: "icon", href: "..."` in TanStack/Remix root routes), then look for that href under `public/` first and then the workspace root. It does NOT read package.json. Results are cached in an Effect `Cache`: capacity 512, 10 min TTL for hits, 1 min for misses, failures not cached; a cached hit is re-stat'ed on each lookup and re-resolved if the file vanished. `invalidate(cwd)` drops entries after a clone finishes.

`apps/server/src/project/ProjectFaviconResolver.ts:L17-L78`
```ts
const FAVICON_CACHE_CAPACITY = 512;
const FAVICON_POSITIVE_CACHE_TTL = Duration.minutes(10);
const FAVICON_NEGATIVE_CACHE_TTL = Duration.minutes(1);

function faviconCacheKey(cwd: string, faviconPath?: string): string {
  return `${faviconPath ?? ""}\0${cwd}`;
}

function parseFaviconCacheKey(key: string): {
  readonly cwd: string;
  readonly faviconPath?: string;
} {
  const separatorIndex = key.indexOf("\0");
  if (separatorIndex === -1) {
    return { cwd: key };
  }
  const faviconPath = key.slice(0, separatorIndex);
  const cwd = key.slice(separatorIndex + 1);
  return faviconPath.length === 0 ? { cwd } : { cwd, faviconPath };
}

const FAVICON_CANDIDATES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  ".idea/icon.svg",
  "Resources/AppIcon.icns",
  "AppIcon.icns",
] as const;

const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
] as const;

// Anchor HTML at <link and scan brace-free metadata runs to avoid quadratic regex rescans.
const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const ICON_REL_RE = /\brel\s*:\s*["'](?:icon|shortcut icon)["']/i;
const ICON_HREF_RE = /\bhref\s*:\s*["']([^"'?]+)/i;
```

`apps/server/src/project/ProjectFaviconResolver.ts:L117-L126`
```ts
function extractIconHref(source: string): string | null {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  for (const run of source.split("}")) {
    if (!ICON_REL_RE.test(run)) continue;
    const hrefMatch = run.match(ICON_HREF_RE);
    if (hrefMatch?.[1]) return hrefMatch[1];
  }
  return null;
}
```

`apps/server/src/project/ProjectFaviconResolver.ts:L145-L192`
```ts
  const resolveIconHref = (href: string): ReadonlyArray<string> => {
    const clean = href.replace(/^\//, "");
    return [path.join("public", clean), clean];
  };

  const findExistingFile = Effect.fn("ProjectFaviconResolver.findExistingFile")(function* (
    projectCwd: string,
    relativeCandidates: ReadonlyArray<string>,
    candidateScope: "workspace" | "filesystem",
  ): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
    for (const relativePath of relativeCandidates) {
      const candidate = yield* (
        candidateScope === "filesystem" && path.isAbsolute(relativePath)
          ? Effect.succeed({ absolutePath: relativePath, relativePath })
          : workspacePaths.resolveRelativePathWithinRoot({
              workspaceRoot: projectCwd,
              relativePath,
            })
      ).pipe(
        Effect.asSome,
        Effect.catchTags({
          WorkspacePathOutsideRootError: () =>
            Effect.succeed(
              Option.none<{ readonly absolutePath: string; readonly relativePath: string }>(),
            ),
        }),
      );
      if (Option.isNone(candidate)) {
        continue;
      }
      const stats = yield* optionOnNotFound(fileSystem.stat(candidate.value.absolutePath)).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectFaviconResolutionError({
              operation: "stat-candidate",
              workspaceRoot: projectCwd,
              relativePath,
              absolutePath: candidate.value.absolutePath,
              cause,
            }),
        ),
      );
      if (Option.isSome(stats) && stats.value.type === "File") {
        return candidate.value.absolutePath;
      }
    }
    return null;
  });
```

`apps/server/src/project/ProjectFaviconResolver.ts:L236-L338`
```ts
  // Probe concurrently but join in list order so lower-ranked probes cannot delay a hit.
  // A failure surfaces only if no earlier probe found a file; scope exit interrupts remaining probes.
  const firstInOrder = Effect.fn("ProjectFaviconResolver.firstInOrder")(function* <A>(
    items: ReadonlyArray<A>,
    probe: (item: A) => Effect.Effect<string | null, ProjectFaviconResolutionError>,
  ) {
    const fibers = yield* Effect.forEach(items, (item) => Effect.forkScoped(probe(item)));
    for (const fiber of fibers) {
      const found = yield* Fiber.join(fiber);
      if (found) {
        return found;
      }
    }
    return null;
  }, Effect.scoped);

  const resolvePathUncached = Effect.fn("ProjectFaviconResolver.resolvePathUncached")(function* (
    cwd: string,
    faviconPath?: string,
  ): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
    const projectCwd = yield* workspacePaths.normalizeWorkspaceRoot(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectFaviconResolutionError({
            operation: "normalize-workspace",
            workspaceRoot: cwd,
            cause,
          }),
      ),
    );
    if (faviconPath !== undefined) {
      const existing = yield* findExistingFile(projectCwd, [faviconPath], "filesystem");
      if (existing) {
        return existing;
      }
    }

    const projectFile = yield* projectFileLoader.load(projectCwd);
    if (Option.isSome(projectFile) && projectFile.value.iconPath !== undefined) {
      const existing = yield* findExistingFile(
        projectCwd,
        [projectFile.value.iconPath],
        "workspace",
      );
      if (existing) {
        return existing;
      }
    }

    const wellKnown = yield* firstInOrder(FAVICON_CANDIDATES, (candidate) =>
      findExistingFile(projectCwd, [candidate], "workspace"),
    );
    if (wellKnown) {
      return wellKnown;
    }

    return yield* firstInOrder(ICON_SOURCE_FILES, (sourceFile) =>
      findIconFromSource(projectCwd, sourceFile),
    );
  });

  const faviconCache = yield* Cache.makeWith<string, string | null, ProjectFaviconResolutionError>(
    (key) => {
      const { cwd, faviconPath } = parseFaviconCacheKey(key);
      return resolvePathUncached(cwd, faviconPath);
    },
    {
      capacity: FAVICON_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (value: string | null) =>
          value === null ? FAVICON_NEGATIVE_CACHE_TTL : FAVICON_POSITIVE_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );

  const resolvePath: ProjectFaviconResolver["Service"]["resolvePath"] = Effect.fn(
    "ProjectFaviconResolver.resolvePath",
  )(function* (cwd, faviconPath) {
    const key = faviconCacheKey(cwd, faviconPath);
    const cached = yield* Cache.get(faviconCache, key);
    if (cached === null) {
      return null;
    }

    const stats = yield* optionOnNotFound(fileSystem.stat(cached)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectFaviconResolutionError({
            operation: "stat-candidate",
            workspaceRoot: cwd,
            absolutePath: cached,
            cause,
          }),
      ),
    );
    if (Option.isSome(stats) && stats.value.type === "File") {
      return cached;
    }

    yield* Cache.invalidate(faviconCache, key);
    return yield* Cache.get(faviconCache, key);
  });
```

The `t3.json` field the resolver checks second:

`packages/contracts/src/t3ProjectFile.ts:L78-L86`
```ts
  iconPath: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Workspace-relative path to the project icon (e.g. "assets/logo.svg"). Checked before T3 Code\'s built-in icon locations.',
      },
      T3_PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
```

`packages/contracts/src/t3ProjectFile.ts:L8-L8`
```ts
export const T3_PROJECT_FILE_NAME = "t3.json";
```


#### Server: path-traversal safety

Workspace-scoped candidates go through `resolveRelativePathWithinRoot`, which rejects absolute inputs and anything resolving to `..`/outside the root (those candidates are silently skipped by the resolver). When the asset URL is minted and again when it is served, `resolveCanonicalWorkspaceFile` `realpath`s both root and file and re-checks containment, so a symlink pointing outside the workspace is refused. The external-override case instead requires that the served file's realpath equals the signed path exactly.

`apps/server/src/workspace/WorkspacePaths.ts:L180-L209`
```ts
  const resolveRelativePathWithinRoot: WorkspacePaths["Service"]["resolveRelativePathWithinRoot"] =
    Effect.fn("WorkspacePaths.resolveRelativePathWithinRoot")(function* (input) {
      const normalizedInputPath = input.relativePath.trim();
      if (path.isAbsolute(normalizedInputPath)) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      const absolutePath = path.resolve(input.workspaceRoot, normalizedInputPath);
      const relativeToRoot = toPosixRelativePath(path.relative(input.workspaceRoot, absolutePath));
      if (
        relativeToRoot.length === 0 ||
        relativeToRoot === "." ||
        relativeToRoot.startsWith("../") ||
        relativeToRoot === ".." ||
        path.isAbsolute(relativeToRoot)
      ) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      return {
        absolutePath,
        relativePath: relativeToRoot,
      };
    });
```

`apps/server/src/assets/AssetAccess.ts:L274-L314`
```ts
const resolveCanonicalFile = Effect.fn("AssetAccess.resolveCanonicalFile")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const canonicalFile = yield* ProjectFaviconResolver.optionOnNotFound(
    fileSystem.realPath(filePath),
  );
  if (Option.isNone(canonicalFile)) return null;

  const info = yield* ProjectFaviconResolver.optionOnNotFound(fileSystem.stat(canonicalFile.value));
  return Option.isSome(info) && info.value.type === "File" ? canonicalFile.value : null;
});

const resolveCanonicalWorkspaceFile = Effect.fn("AssetAccess.resolveCanonicalWorkspaceFile")(
  function* (input: { readonly workspaceRoot: string; readonly relativePath: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const resolved = yield* workspacePaths.resolveRelativePathWithinRoot(input).pipe(
      Effect.asSome,
      Effect.catchTags({
        WorkspacePathOutsideRootError: () => Effect.succeedNone,
      }),
    );
    if (Option.isNone(resolved)) return null;

    const [canonicalRoot, canonicalFile] = yield* Effect.all([
      ProjectFaviconResolver.optionOnNotFound(fileSystem.realPath(input.workspaceRoot)),
      ProjectFaviconResolver.optionOnNotFound(fileSystem.realPath(resolved.value.absolutePath)),
    ]);
    if (Option.isNone(canonicalRoot) || Option.isNone(canonicalFile)) return null;

    const path = yield* Path.Path;
    const relative = path.relative(canonicalRoot.value, canonicalFile.value);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;

    const info = yield* ProjectFaviconResolver.optionOnNotFound(
      fileSystem.stat(canonicalFile.value),
    );
    return Option.isSome(info) && info.value.type === "File" ? canonicalFile.value : null;
  },
);
```


#### Unread / attention badge favicon

When there are pending thread notifications in a plain browser (or on Windows desktop), a 64x64 canvas is drawn: red circle `#e5484d`, white bold count, `9+` above 9. In the browser the original `<link rel="icon">` is removed and replaced by the badge PNG; at zero it is removed and the original restored. On desktop the image/count go to the bridge (dock/taskbar badge). Called by `ThreadNotificationCoordinator` with `pending.size`.

`apps/web/src/threadNotifications.ts:L38-L81`
```ts
let originalFavicon: HTMLLinkElement | undefined;
let badgeFavicon: HTMLLinkElement | undefined;

export function setNotificationBadge(count: number) {
  const bridge = window.desktopBridge;
  let image: string | null = null;
  if (count > 0 && (!bridge || bridge.getClientPlatform() === "win32")) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#e5484d";
      context.beginPath();
      context.arc(32, 32, 28, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "white";
      context.font = `600 ${count > 9 ? 30 : 40}px "Segoe UI", sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(count > 9 ? "9+" : String(count), 32, 34);
      image = canvas.toDataURL("image/png");
    }
  }
  if (!bridge) {
    if (image) {
      if (!badgeFavicon) {
        originalFavicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? undefined;
        badgeFavicon = document.createElement("link");
        badgeFavicon.rel = "icon";
        badgeFavicon.type = "image/png";
        badgeFavicon.sizes.value = "64x64";
        originalFavicon?.remove();
        document.head.append(badgeFavicon);
      }
      badgeFavicon.href = image;
    } else if (badgeFavicon) {
      badgeFavicon.remove();
      badgeFavicon = undefined;
      if (originalFavicon) document.head.append(originalFavicon);
      originalFavicon = undefined;
    }
  }
  void bridge?.setNotificationBadge({ count, image }).catch(() => undefined);
}
```


## 6. Icons

### 6.1 Summary

- **Library:** `lucide-react ^0.564.0`, imported as `XxxIcon` (e.g. `SquarePenIcon`). `components.json` declares `"iconLibrary": "lucide"`. `morphicons ^1.7.1` (`MorphIcon.tsx`) animates between two lucide shapes: copy→check, PanelLeft→PanelLeftClose, Maximize2→Minimize2, CornerUpRight→ListPlus for steer/queue. It's forced to `reducedMotion="user"`.
- **Stroke:** every lucide icon drops from 2 to **1.75** via one global rule (`apps/web/src/index.css:L1721-L1727`). Explicit `strokeWidth` is rare: 2.25 on toast close/expand, 1.8 on the custom send arrow.
- **Size is owned by the parent primitive,** via `[&_svg:not([class*='size-'])]:size-X` rules. Buttons are `size-4.5` on mobile and `sm:size-4` on desktop. Menu items are 4.5 / sm:4 at `opacity-80` muted. Badges 3.5 / sm:3, Kbd 3. Most common explicit sizes in components: `size-3.5` (396), `size-3` (272), `size-4` (269).
- **Muted icon color:** `text-icon-muted` (palette rows: `"size-4 text-icon-muted"`, `apps/web/src/components/CommandPalette.logic.ts:L37-L38`). The sidebar uses `--sidebar-icon-color`, which is muted-foreground mixed 85% toward the sidebar background (`index.css:L106-L110`).
- **Brand icons** (Claude, OpenAI/Codex, Cursor, Antigravity) are hand-inlined SVG components in `apps/web/src/components/Icons.tsx` with brand fills: Claude `fill-[#d97757]`, OpenAI `fill-current` in `text-black dark:text-white`. `ProviderInstanceIcon` resolves them in order: registry URL → package icon data → inline component → initials fallback. Default `size-5`, compact `size-3.5`.
- **Status icons are lucide outlines,** not spinners. Working = `CircleDashedIcon`, Done = `CircleCheckIcon`, Failed = `CircleAlertIcon`, Approval = `ShieldQuestionIcon`. Spinner is `LoaderCircleIcon` with a visibility-paused spin.

### 6.2 Verbatim evidence

#### 2.1 Libraries

- `lucide-react` ^0.564.0 is the main icon set (React components, imported as `XxxIcon`).
- `lucide` ^0.564.0 (vanilla icon node arrays, imported without the `Icon` suffix, e.g. `Check`, `Copy`, `PanelLeft`) is used only as input to MorphIcon.
- `morphicons` ^1.7.1: `MorphIcon` animates between two lucide icon shapes (copy -> check, chevron up/down, panel open/close, maximize/minimize, steer/queue). Wrapper forces `reducedMotion="user"`.
- Brand/editor icons are hand-inlined SVG React components (`Icons.tsx`, `JetBrainsIcons.tsx`). Provider packages ship icon artwork as data (`viewBox`, `fill.light/dark`, `paths`) rendered by `ProviderPackageIcon`. Source-control hosts ship artwork data rendered by `SourceControlIconArtwork`. File-tree icons come from `@pierre/trees` sprites plus a custom sprite (`pierre-icons.ts`).

`apps/web/src/components/MorphIcon.tsx:L1-L5`
```tsx
import { MorphIcon as BaseMorphIcon, type MorphIconProps } from "morphicons/react";

export function MorphIcon({ reducedMotion = "user", ...props }: MorphIconProps) {
  return <BaseMorphIcon reducedMotion={reducedMotion} {...props} />;
}
```

`apps/web/src/components/ui/sidebar.tsx:L414-L415`
```tsx
      <MorphIcon className="size-4" icon={isOpen ? PanelLeftClose : PanelLeft} />
      <span className="sr-only">Toggle Sidebar</span>
```

`apps/web/src/components/CommandBlock.tsx:L40-L40`
```tsx
        <MorphIcon className="size-3.5" icon={isCopied ? Check : Copy} />
```

#### 2.2 Global stroke width and sizing rules

Global CSS lightens every lucide icon from stroke 2 to 1.75 (in `@layer base`, so explicit `stroke-*`/`strokeWidth` still win). Toast close/expand chevrons explicitly use `strokeWidth={2.25}`.

`apps/web/src/index.css:L1721-L1727`
```css
/* Lighter default icon stroke. In the base layer so stroke-* utilities still win; any
   CSS beats lucide's stroke-width="2" attribute. */
@layer base {
  :where(svg.lucide[stroke-width="2"]) {
    stroke-width: 1.75;
  }
}
```

Icon size is mostly set by parent primitives, not by each icon: `[&_svg:not([class*='size-'])]:size-X` rules. Button default: `size-4.5` on mobile, `sm:size-4` on desktop; compact/micro/xs buttons step down to 3.5/3; `icon-xl`/`xl` go to 5/4.5. Menu items: 4.5 / sm:4 with `opacity-80` and `text-muted-foreground`. Badge: 3.5 / sm:3. Kbd: 3. Toggle: 4.5 / sm:4, `opacity-80`. Icon color inside buttons: `text-[var(--control-icon-color)]`, which ghost/outline variants set to `var(--contrast-muted-foreground)`.

Counts (`grep -rhoE "size-[0-9.]+" apps/web/src/components | sort | uniq -c | sort -rn`): `size-3.5` 396, `size-3` 272, `size-4` 269, `size-5` 45, `size-4.5` 39, `size-8` 31, `size-7` 26, `size-6` 21, `size-2` 21, `size-1.5` 18, `size-2.5` 11, `size-3.25` 8, `size-9` 7. (These include non-icon boxes like `size-7` buttons.)

Svg rules in `components/ui` (`grep -rhoE "\[&_svg[^ \"]*" apps/web/src/components/ui`): `[&_svg:not([class*='size-'])]:size-4.5` 22, `...:size-4` 22, `[&_svg]:pointer-events-none` 19, `[&_svg]:shrink-0` 17, `...:size-3.5` 7, `[&_svg]:-mx-0.5` 6, `...:size-3` 6, `[&_svg:not([class*='opacity-'])]:opacity-80` 5.

Explicit strokeWidth counts: `strokeWidth={2.25` 6, `strokeWidth="3` 5, `strokeWidth="0.6` 4, `strokeWidth={3` 3, `strokeWidth="2` 3, `strokeWidth="1.75` 3, `strokeWidth="1.5` 3. Rare; the global 1.75 rule is the real default.

Palette icon classes:

`apps/web/src/components/CommandPalette.logic.ts:L37-L38`
```ts
export const ITEM_ICON_CLASS = "size-4 text-icon-muted";
export const ADDON_ICON_CLASS = "size-4";
```

#### 2.3 Icons for key actions (verbatim usages)

| action | icon | where |
|---|---|---|
| New thread | `SquarePenIcon` (lucide-react) | sidebar header button, palette |
| Add project | `FolderPlusIcon` | sidebar header |
| Settings | `SettingsIcon` | sidebar footer utility item, palette |
| Usage | `ChartNoAxesColumnIcon` | sidebar footer, palette |
| Send | custom inline 14x14 up-arrow SVG, `strokeWidth="1.8"` | composer send button |
| Steer / queue while running | MorphIcon `CornerUpRight` / `ListPlus` | composer send button |
| Resume | `PlayIcon` `size-4 fill-current` | composer |
| Update queued | `CheckIcon` `size-4` | composer |
| Sending | `Spinner size="sm"` (LoaderCircleIcon) | composer |
| Stop | custom inline 12x12 rounded square (`rect x=2 y=2 w=8 h=8 rx=1.5`, `fill="currentColor"`) on red circle | composer |
| Archive | `archive` icon id in thread context menu (native menu, fallback draws lucide Archive paths); `ArchiveIcon` / `ArchiveX` in settings Archived list | |
| Terminal drawer toggle | `PanelBottomIcon` `size-4` | chat header |
| Right panel toggle | `PanelRightIcon` `size-4` | chat header |
| Thread details toggle | `SquareMenuIcon` `size-4` | chat header |
| Maximize panel | MorphIcon `Maximize2` / `Minimize2` | panel header |
| Sidebar toggle | MorphIcon `PanelLeft` / `PanelLeftClose` `size-4` | titlebar |
| Diff | `FileDiff` (right-panel surface list), `FileDiffIcon` elsewhere | |
| Terminal (surface/tab) | `TerminalSquare` in right-panel surfaces; `TerminalIcon` in thread rows/chips | |
| Browser surface | `Globe2` | right panel |
| Model picker | provider brand icon(s) via `ProviderInstanceIcon` `size-4` (stacked `-space-x-1` when multi-select), label, no chevron | composer |
| Attach files | `PaperclipIcon` (`translate-y-px`) in `Button variant="ghost" size="icon-sm"` | composer |
| Search | `SearchIcon` | palette input, settings search, menu search |
| Close/dismiss | `XIcon` | dialogs, toasts (`size-3 strokeWidth={2.25}`) |
| Toast types | error `CircleAlertIcon`, info `InfoIcon`, success `CircleCheckIcon`, warning `TriangleAlertIcon`, loading `Spinner` | toast |

`apps/web/src/components/sidebar/SidebarThreadHeader.tsx:L1-L1`
```tsx
import { FolderPlusIcon, SearchIcon, SquarePenIcon, XIcon } from "lucide-react";
```

`apps/web/src/components/sidebar/SidebarThreadHeader.tsx:L104-L132`
```tsx
      <div className="flex shrink-0 items-center">
        {hasProjects ? (
          <>
            {projectScope}
            <SidebarHeaderIconButton label="Add project" onClick={onNewProject}>
              <FolderPlusIcon />
            </SidebarHeaderIconButton>
          </>
        ) : null}
        <SidebarHeaderIconButton
          label="New thread"
          tooltip={
            showNewThreadInProjectHint ? (
              <span className="flex flex-col gap-0.5">
                <span>{newThreadLabel}</span>
                <span className="text-muted-foreground">
                  New thread in current project: Shift+click
                  {newThreadInProjectShortcutLabel ? ` (${newThreadInProjectShortcutLabel})` : ""}
                </span>
              </span>
            ) : (
              newThreadLabel
            )
          }
          disabled={newThreadDisabled}
          onClick={onNewThread}
        >
          <SquarePenIcon />
        </SidebarHeaderIconButton>
```

`apps/web/src/components/sidebar/SidebarThreadHeader.tsx:L137-L175`
```tsx

export function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            {...rest}
            className={cn("relative size-7 shrink-0", className)}
          />
        }
      >
        {children}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
```

`apps/web/src/components/sidebar/SidebarChrome.tsx:L1-L1`
```tsx
import { ArrowLeftIcon, ChartNoAxesColumnIcon, SettingsIcon } from "lucide-react";
```

`apps/web/src/components/sidebar/SidebarChrome.tsx:L206-L211`
```tsx
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={handleSettingsClick}
          />
```

`apps/web/src/components/chat/ComposerPrimaryActions.tsx:L1-L13`
```tsx
import { memo, type MouseEventHandler, type PointerEventHandler } from "react";
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, Minimize2Icon, PlayIcon } from "lucide-react";
import { CornerUpRight, ListPlus } from "lucide";
import { MorphIcon } from "~/components/MorphIcon";
import { useEnvironmentIdentificationMode } from "~/hooks/useSettings";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { cn, isMacPlatform } from "~/lib/utils";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { StageBackdropButtonArt, useSidebarStageBackdropVariant } from "../SidebarStageBackdrop";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
```

`apps/web/src/components/chat/ComposerPrimaryActions.tsx:L127-L152`
```tsx
  const renderStopGenerationButton = (insidePendingAction: boolean) => (
    <Tooltip key="interrupt">
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex shrink-0 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-control-highlight transition-colors duration-150 hover:bg-destructive active:inset-shadow-control-pressed active:shadow-none [&_svg]:pointer-events-none",
              insidePendingAction ? "size-8 sm:size-7" : "size-8 sm:h-8 sm:w-8",
            )}
            {...pointerFocusProps}
            disabled={!canOperateThread}
            onClick={() => {
              if (canOperateThread) onInterrupt();
            }}
            aria-label="Stop generation"
          />
        }
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </TooltipTrigger>
      <TooltipPopup>Interrupt</TooltipPopup>
    </Tooltip>
  );
```

`apps/web/src/components/chat/ComposerPrimaryActions.tsx:L305-L345`
```tsx
      type={showResume ? "button" : "submit"}
      className={cn(
        "relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-control-highlight hover:scale-105 active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 [&_svg]:pointer-events-none",
        stageBackdropVariant
          ? "bg-transparent text-white enabled:shadow-black/24 enabled:hover:brightness-110 disabled:opacity-64"
          : "bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover disabled:bg-foreground/12 disabled:text-muted-foreground",
      )}
      {...pointerFocusProps}
      onClick={showResume ? onResume : onSubmitMessage}
      disabled={
        isSendBusy ||
        isSendDisabled ||
        isEnvironmentUnavailable ||
        (!hasSendableContent && !showResume)
      }
      aria-label={submitStatus ?? submitLabel}
    >
      {stageBackdropVariant ? (
        <span className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
          <StageBackdropButtonArt variant={stageBackdropVariant} />
        </span>
      ) : null}
      {isSendBusy ? (
        <Spinner size="sm" aria-hidden="true" />
      ) : showResume ? (
        <PlayIcon className="size-4 fill-current" aria-hidden="true" />
      ) : isEditingQueuedMessage ? (
        <CheckIcon className="size-4" aria-hidden="true" />
      ) : isRunning ? (
        <MorphIcon className="size-4" icon={isQueuing ? ListPlus : CornerUpRight} />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
```

`apps/web/src/components/ui/sidebar.tsx:L397-L417`
```tsx
  return (
    <Button
      className={cn(
        "size-[var(--workspace-titlebar-control-size)]! [-webkit-app-region:no-drag]",
        className,
      )}
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      aria-pressed={isOpen}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      size="icon"
      variant="ghost"
      {...props}
    >
      <MorphIcon className="size-4" icon={isOpen ? PanelLeftClose : PanelLeft} />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
```

`apps/web/src/components/chat/PanelLayoutControls.tsx:L1-L1`
```tsx
import { PanelBottomIcon, PanelRightIcon, SquareMenuIcon } from "lucide-react";
```

`apps/web/src/components/chat/PanelLayoutControls.tsx:L52-L62`
```tsx
  const threadPanelToggle = (
    <Toggle
      className="relative shrink-0 [-webkit-app-region:no-drag]"
      pressed={threadPanelOpen}
      onPressedChange={threadPanelPresentation === "popover" ? undefined : onToggleThreadPanel}
      aria-label="Toggle thread details panel"
      variant="ghost"
      size="sm"
    >
      <SquareMenuIcon className="size-4" />
    </Toggle>
```

`apps/web/src/components/chat/ComposerAttachmentStrip.tsx:L697-L715`
```tsx
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => inputRef.current?.click()}
              aria-label="Attach files"
            />
          }
        >
          {/* The clip's weight sits in its upper loop; 1px down reads as centered on the row. */}
          <PaperclipIcon className="translate-y-px" />
        </TooltipTrigger>
        <TooltipPopup>Attach files</TooltipPopup>
      </Tooltip>
    </>
```

`apps/web/src/components/threadActionMenu.logic.ts:L221-L228`
```ts
    { id: "project-settings", label: "Project settings", icon: "settings" },
    {
      id: "archive",
      label: "Archive thread",
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
```

`apps/web/src/contextMenuFallback.ts:L5-L10`
```ts
const ICON_PATHS: Record<string, ReadonlyArray<{ tag: string; attrs: Record<string, string> }>> = {
  archive: [
    { tag: "rect", attrs: { width: "20", height: "5", x: "2", y: "3", rx: "1" } },
    { tag: "path", attrs: { d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" } },
    { tag: "path", attrs: { d: "M10 12h4" } },
  ],
```

`apps/web/src/components/RightPanelTabs.tsx:L316-L372`
```tsx
  const actions = [
    {
      label: "Browser",
      icon: Globe2,
      shortcut: "B",
      available: props.browserAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.browser,
      onClick: props.onAddBrowser,
    },
    {
      label: "Terminal",
      icon: TerminalSquare,
      shortcut: "T",
      available: props.terminalAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.terminal,
      onClick: props.onAddTerminal,
    },
    {
      label: "Files",
      icon: Files,
      shortcut: "F",
      available: props.filesAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.files,
      onClick: props.onAddFiles,
    },
    {
      label: "Diff",
      icon: FileDiff,
      shortcut: "D",
      available: props.diffAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.diff,
      onClick: props.onAddDiff,
    },
    {
      label: "Pull request",
      icon: PullRequestGlyph.pullRequest,
      shortcut: "P",
      available: props.pullRequestAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.pullRequest,
      onClick: props.onAddPullRequest,
    },
    {
      label: "Linked pull requests",
      icon: PullRequestGlyph.link,
      shortcut: "L",
      available: props.pullRequestsAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.pullRequests,
      onClick: props.onAddPullRequests,
    },
    {
      label: "Device",
      description: "Watch an iOS Simulator or Android Emulator.",
      icon: Smartphone,
      shortcut: "M",
      available: props.deviceAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.device,
      onClick: props.onAddDevice,
```

`apps/web/src/components/chat/ProviderModelPicker.tsx:L187-L274`
```tsx
      <PopoverTrigger
        render={
          <ComposerControl
            aria-label={
              props.triggerAriaLabel ?? props.triggerLabel ?? allModelNames ?? triggerLabel
            }
            size={size}
            data-chat-provider-model-picker="true"
            className={cn(
              "min-w-0 shrink justify-between whitespace-nowrap",
              props.compact
                ? "max-w-42 shrink-0"
                : !props.isComposerOwned && "max-w-48 sm:max-w-56",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn("flex min-w-0 flex-1 items-center", size === "xs" ? "gap-1" : "gap-1.5")}
        >
          {selectedEntries && props.triggerLabel === undefined ? (
            <span
              data-chat-provider-model-picker-icon
              className="flex shrink-0 items-center -space-x-1"
              aria-hidden="true"
            >
              {selectedEntries
                .slice(0, 3)
                .map((selection) =>
                  selection.entry ? (
                    <ProviderInstanceIcon
                      key={`${selection.instanceId}:${selection.model}`}
                      driverKind={selection.entry.driverKind}
                      displayName={selection.entry.displayName}
                      accentColor={selection.entry.accentColor}
                      className="size-4 rounded-full bg-(--chat-composer-glass-surface,var(--background)) ring-2 ring-(--chat-composer-glass-surface,var(--background))"
                      iconClassName="size-4"
                    />
                  ) : null,
                )}
              {selectedEntries.length > 3 ? (
                <span className="relative z-30 flex size-4 items-center justify-center rounded-full bg-(--chat-composer-glass-surface,var(--background)) text-3xs ring-2 ring-(--chat-composer-glass-surface,var(--background))">
                  +{selectedEntries.length - 3}
                </span>
              ) : null}
            </span>
          ) : activeEntry && props.triggerLabel === undefined ? (
            // Narrow compacted composers hide the provider icon before truncating the name.
            <span data-chat-provider-model-picker-icon className="contents">
              <ProviderInstanceIcon
                driverKind={activeEntry.driverKind}
                displayName={activeEntry.displayName}
                accentColor={activeEntry.accentColor}
                acpRegistryAgentId={activeEntry.acpRegistryAgentId}
                acpRegistryIconUrl={activeEntry.acpRegistryIconUrl}
                showBadge={showInstanceBadge}
                className="size-4"
                iconClassName={cn("size-4", props.activeProviderIconClassName)}
                indicatorBackground={props.instanceIndicatorBackground ?? "var(--contrast-input)"}
                badgeClassName={cn(
                  "right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs",
                  size === "xs" && "shadow-none",
                )}
              />
            </span>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className="min-w-0 flex-1 overflow-hidden truncate"
                  data-chat-provider-model-picker-label="true"
                />
              }
            >
              {props.triggerLabel ?? multipleLabel ?? triggerTitle}
            </TooltipTrigger>
            <TooltipPopup side="top">{triggerTooltipContent}</TooltipPopup>
          </Tooltip>
          {selectedModel?.isUnavailable && !selectedEntries && props.triggerLabel === undefined ? (
            <Badge variant="outline" size="sm">
              Unavailable
            </Badge>
          ) : null}
        </span>
      </PopoverTrigger>
```


## 7. Keyboard shortcuts

### 7.1 Summary

**Implementation: custom, no hotkey library.**
- The parser, matcher and `when` grammar live in `packages/shared/src/keybindings.ts`.
- The default list is `DEFAULT_KEYBINDINGS` in the same file (e.g. `{ key: "mod+b", command: "sidebar.toggle" }` at L148, `{ key: "mod+k", command: "commandPalette.toggle", when: "!terminalFocus" }` at L174).
- Client resolution and label formatting are in `apps/web/src/keybindings.ts`.
- A scope dispatcher is in `apps/web/src/shortcuts/dispatcher.ts`.

**Grammar.** Tokens are split on `+`. Modifiers are `mod`, `cmd`/`meta`, `ctrl`, `shift`, `alt`/`option`. **`mod` = Cmd on macOS/iOS, Ctrl elsewhere.** Exactly one non-modifier key is allowed. `when` is a boolean expression over context flags (`!`, `&&`, `||`, parens). The flags are `terminalFocus`, `composerFocus`, `previewFocus`, `editableFocus`, `modelPickerOpen`, `rightPanelOpen`, `turnRunning`, `draftThreadRoute`, `isDesktop`, `usagePageOpen`. Unknown identifiers are false. The last matching rule wins, so the same chord can mean different things by focus: `mod+n` is a new terminal in the terminal and a new thread elsewhere.

**Dispatcher.** One pair of window `keydown` listeners (capture + bubble). Features register scopes with `registerCommands(handlers, { when, context, capture, observe })`. The newest scope wins, and a handler returning `false` passes the event on.

**User config.** `~/.t3/userdata/keybindings.json`, a JSON array of `{ key, command, when }`. Defaults are written on first run. The server `fs.watch`es it with a 100ms debounce and pushes `keybindingsUpdated` over the websocket. The UI toasts "Keybindings updated", or "Invalid keybindings configuration" with an "Open keybindings.json" button. Overriding a command replaces all of its default chords.

**Hints in the UI.**
- Tooltips append the label in parens, e.g. `Toggle main sidebar (⌘B)`, built from `shortcutLabelForCommand()` so user overrides show up.
- Labels on mac are symbol strings in the order ⌃⌥⇧⌘ + key (`⇧⌘B`). Elsewhere they're `Ctrl+Shift+B`.
- Menu and palette rows show a right-aligned plain `<kbd>`: `ms-auto font-medium font-sans text-secondary-label text-xs tracking-widest`.
- `Kbd` chips: `h-5 min-w-5 rounded bg-foreground/[0.07] px-1 text-xs text-muted-foreground`.
- **Hold-to-reveal:** holding ⌘ for 200ms shows `⌘1..⌘9` badges on the first 9 sidebar rows (desktop), and they hide instantly on release.
- Holding ⌘/Ctrl over the composer flips the send icon to show the alternate action.

**Command palette.** `mod+k` opens it. `mod+p` opens files mode and `mod+shift+f` opens content search; the same chord closes it.
- Shell: Base UI Dialog + Autocomplete, `max-w-xl max-h-105`, `sm:py-[10vh]` from the top.
- Input: `size="lg"` with a leading `SearchIcon`.
- Footer hint bar: `↑ ↓ Navigate`, `Enter <action>`, `Backspace Back`, `Esc Close`.
- Items are actions (`run()`) or submenus (nested groups, trailing chevron), with optional icon, description, timestamp and shortcut.

**Settings > Keybindings.** Rows are grouped by section (Navigation, Threads, Composer, Terminal, Preview & diff, Appearance, Project scripts, Other). Each row shows the chord as a pill. Clicking it records a new chord into a mono `w-44` input ("Press shortcut"), and Escape cancels. Conflicts and unknown `when` identifiers get warning icons.

**Keymap highlights:**

| Keys | Action |
|---|---|
| `mod+k` | Command palette |
| `mod+p` / `mod+shift+f` | Go to file / search project |
| `mod+n` | New thread (project picker if 2+ projects) |
| `mod+shift+n` | New thread in current project |
| `mod+b` | Toggle sidebar |
| `mod+alt+b` / `mod+shift+b` | Toggle right panel / thread details |
| `mod+j` | Toggle terminal drawer |
| `mod+d` | Toggle diff |
| `mod+shift+m` | Model picker |
| `mod+shift+e` / `mod+shift+a` | Effort / permissions mode |
| `mod+shift+[` / `mod+shift+]` | Previous / next thread |
| `mod+1..9` | Jump to Nth thread (desktop) |
| `mod+f` | Find in thread |
| `mod+shift+p` / `mod+shift+s` | Pin / settle thread |
| `mod+z` | Undo last sidebar action (not while typing) |
| `mod+enter` (running) | Opposite of default send (queue vs steer) |
| `alt+arrowup` | Edit last queued message |
| `f6` / `shift+f6` | Cycle focus between workspace areas |

The full 70-row table is below, followed by the verbatim source list.

### 7.2 Verbatim evidence

#### 1.3 Default keymap as a table

`mod` = Cmd on macOS/iOS, Ctrl elsewhere (see 1.5). "always" means the rule has no `when`. "What it does" uses the label the Settings > Keybindings page shows (from `commandLabel`, quoted in 1.9) plus behavior I traced to a handler. Rows marked "(handler not traced)" only have the label; I did not follow the handler.

| # | command | default key | when | what it does |
|---|---|---|---|---|
| 1 | `sidebar.toggle` | `mod+b` | always | Toggle main sidebar. Capture-phase window listener in `AppSidebarLayout.tsx`; yields to Mod+B bold when text is selected inside the rich-text composer. Tooltip "Toggle main sidebar (⌘B)". |
| 2 | `workspace.focusNext` | `f6` | always | "Focus Next Workspace Area" (accessibility focus cycling). |
| 3 | `workspace.focusPrevious` | `shift+f6` | always | "Focus Previous Workspace Area". |
| 4 | `workspace.focusNext` | `mod+f6` | always | Same as F6; comment in source: some browsers keep plain F6. |
| 5 | `workspace.focusPrevious` | `mod+shift+f6` | always | Same as Shift+F6. |
| 6 | `navigation.back` | `mod+[` | `!terminalFocus` | "Navigation: Back" (handler not traced). |
| 7 | `navigation.forward` | `mod+]` | `!terminalFocus` | "Navigation: Forward" (handler not traced). |
| 8 | `terminal.toggle` | `mod+j` | always | Toggle terminal drawer. Header tooltip "Toggle terminal drawer (⌘J)". |
| 9 | `rightPanel.toggle` | `mod+alt+b` | always | Toggle right panel. Tooltip "Toggle right panel (⌥⌘B)". |
| 10 | `threadPanel.toggle` | `mod+shift+b` | `!terminalFocus` | Toggle thread details panel. Tooltip "Toggle thread details (⇧⌘B)". |
| 11 | `rightPanel.new` | `mod+t` | `rightPanelOpen && !terminalFocus` | New right-panel tab (handler not traced). |
| 12 | `terminal.split` | `mod+d` | `terminalFocus` | Split terminal. |
| 13 | `terminal.splitVertical` | `mod+shift+d` | `terminalFocus` | Split terminal vertically. |
| 14 | `terminal.new` | `mod+n` | `terminalFocus` | New terminal. |
| 15 | `terminal.close` | `mod+w` | `terminalFocus` | Close terminal. |
| 16 | `rightPanel.close` | `mod+w` | `!terminalFocus` | Close right-panel tab (handler not traced). |
| 17 | `view.reopenClosed` | `mod+shift+t` | always | "Reopen Closed Tab". |
| 18 | `diff.toggle` | `mod+d` | `!terminalFocus` | Toggle diff. |
| 19 | `preview.toggle` | `mod+shift+j` | always | Toggle in-app preview panel. On web it shows an info toast "Preview is desktop-only". Chat route only. |
| 20 | `preview.refresh` | `mod+r` | `previewFocus` | Preview refresh. |
| 21 | `preview.focusUrl` | `mod+l` | `previewFocus` | "Preview: Focus URL". |
| 22 | `preview.zoomIn` | `mod+=` | `previewFocus` | Preview zoom in. |
| 23 | `preview.zoomIn` | `mod++` | `previewFocus` | Preview zoom in (alt key). |
| 24 | `preview.zoomOut` | `mod+-` | `previewFocus` | Preview zoom out. |
| 25 | `preview.resetZoom` | `mod+0` | `previewFocus` | Preview reset zoom. |
| 26 | `commandPalette.toggle` | `mod+k` | `!terminalFocus` | Toggle command palette ("command" mode). |
| 27 | `filePicker.toggle` | `mod+p` | `!terminalFocus` | Toggle palette in "files" mode ("Go to file"). |
| 28 | `projectSearch.toggle` | `mod+shift+f` | `!terminalFocus` | Toggle palette in "content" mode ("Search project contents"). |
| 29 | `usage.open` | `mod+u` | `!terminalFocus` | Close palette, navigate to `/usage`. |
| 30 | `theme.select` | `mod+alt+a` | `!terminalFocus` | Open palette at "Change theme". |
| 31 | `appearance.cycle` | `mod+alt+shift+a` | `!terminalFocus` | Cycle system -> light -> dark -> system; toast "Appearance: <label>" with `timeout: 1500`. |
| 32 | `themeEditor.toggle` | `mod+alt+shift+t` | always | Toggle theme editor panel. |
| 33 | `composer.stash` | `mod+s` | `!terminalFocus` | "Composer: Stash" (handler not traced). |
| 34 | `thread.steerQueuedMessage` | `mod+shift+enter` | `!terminalFocus` | "Queue: Send First Queued Message". |
| 35 | `thread.editQueuedMessage` | `alt+arrowup` | `composerFocus` | "Queue: Edit Last Queued Message". |
| 36 | `composer.sendAlternate` | `mod+enter` | `composerFocus && turnRunning` | "Composer: Opposite Queue or Steer Action". Rewritten at match time to `mod+shift+enter` when the send setting requires a modifier (see 1.6). |
| 37 | `composer.sendBackground` | `mod+enter` | `composerFocus && draftThreadRoute` | "Composer: Start in Background" (draft threads). |
| 38 | `composer.sendBackground` | `mod+alt+enter` | `composerFocus && draftThreadRoute` | Same, second chord. |
| 39 | `composer.sendAndNewThread` | `mod+alt+enter` | `composerFocus && !draftThreadRoute` | "Composer: Send and Start New Thread". |
| 40 | `chat.new` | `mod+n` | `!terminalFocus` | New thread. With more than one project group and neither the "boring" nor legacy sidebar enabled, opens palette at "new-thread-in" (project chooser); else new thread in current project. |
| 41 | `chat.new` | `mod+shift+o` | `!terminalFocus` | Same as row 40. |
| 42 | `chat.newLocal` | `mod+shift+n` | `!terminalFocus` | New thread in the current project. |
| 43 | `chat.newWithoutProject` | `mod+alt+n` | `!terminalFocus` | New scratch thread with no project. |
| 44 | `chat.find` | `mod+f` | `!terminalFocus && !previewFocus` | "Find in current thread". |
| 45 | `modelPicker.toggle` | `mod+shift+m` | `!terminalFocus` | Open/close model picker. |
| 46 | `composer.host` | `mod+shift+h` | `!terminalFocus` | "Composer: Host" (handler not traced). |
| 47 | `composer.effort` | `mod+shift+e` | `!terminalFocus` | "Composer: Effort" (handler not traced). |
| 48 | `composer.mode` | `mod+shift+a` | `!terminalFocus` | "Composer: Mode" (handler not traced). |
| 49 | `composer.workspace` | `mod+shift+x` | `!terminalFocus` | "Composer: Workspace" (handler not traced). |
| 50 | `composer.branch` | `mod+shift+g` | `!terminalFocus` | "Composer: Branch" (handler not traced). |
| 51 | `composer.previousWorktree` | `mod+shift+l` | `!terminalFocus` | "Composer: Previous Worktree" (handler not traced). |
| 52 | `pullRequest.copyNumber` | `mod+shift+k` | `!terminalFocus` | "Pull Request: Copy Number" (handler not traced). |
| 53 | `modelPicker.previousProvider` | `mod+shift+arrowup` | `modelPickerOpen` | Previous provider tab inside model picker. |
| 54 | `modelPicker.nextProvider` | `mod+shift+arrowdown` | `modelPickerOpen` | Next provider tab inside model picker. |
| 55 | `editor.openFavorite` | `mod+o` | always | Open in favorite editor; ignores key repeat. |
| 56 | `thread.previous` | `mod+shift+[` | always | Previous thread in sidebar order. |
| 57 | `thread.next` | `mod+shift+]` | always | Next thread in sidebar order. |
| 58 | `thread.copyReference` | `mod+shift+c` | `!terminalFocus` | "Pull Request: Copy Link or Thread". |
| 59 | `thread.settle` | `mod+shift+s` | `!terminalFocus` | "Thread: Settle" (handler not traced). |
| 60 | `thread.pin` | `mod+shift+p` | `!terminalFocus` | "Thread: Pin" (handler not traced). |
| 61 | `thread.undo` | `mod+z` | `!terminalFocus && !editableFocus` | "Thread: Undo" (handler not traced); never fires while typing. |
| 62 | `thread.jump.1` .. `thread.jump.9` | `mod+1` .. `mod+9` | `!modelPickerOpen && isDesktop` | Jump to Nth thread in sidebar. Desktop app only by default. Hold-to-reveal hints (1.11). |
| 63 | `modelPicker.jump.1` .. `modelPicker.jump.9` | `mod+1` .. `mod+9` | `modelPickerOpen && isDesktop` | Pick Nth model in open picker. |
| 64 | `usage.cost` | `c` | `usagePageOpen` | Usage page metric: cost. |
| 65 | `usage.tokens` | `t` | `usagePageOpen` | Usage page metric: tokens. |
| 66 | `usage.limits` | `l` | `usagePageOpen` | Usage page metric: limits. |
| 67 | `usage.period.day` | `mod+shift+1` | `usagePageOpen` | Usage period: day. |
| 68 | `usage.period.week` | `mod+shift+2` | `usagePageOpen` | Usage period: week. |
| 69 | `usage.period.month` | `mod+shift+3` | `usagePageOpen` | Usage period: month. |
| 70 | `usage.period.quarter` | `mod+shift+4` | `usagePageOpen` | Usage period: quarter. |

Commands in the vocabulary with NO default binding: `thread.stop`, `rightPanel.toggleMaximized`, `composer.cycleHost`, `composer.increaseEffort`, `composer.decreaseEffort`, and every `script.<id>.run`.

Same chord, different `when` (disambiguated by focus): `mod+n` (terminal.new vs chat.new), `mod+w` (terminal.close vs rightPanel.close), `mod+d` (terminal.split vs diff.toggle), `mod+1..9` (thread jump vs model jump), `mod+enter` (sendAlternate vs sendBackground).

Non-keybinding keys (hardcoded, not user-configurable): Enter sends in the composer (setting `sendShortcut`: `"enter" | "mod-enter-multiline" | "mod-enter"`, default `"enter"`); Escape clears multi-thread selection on chat routes; Escape inside a palette child search (files/content) goes back to the command list; terminal Ctrl+L / Cmd+K clear; Cmd+Backspace and Alt/Cmd+Arrow translate to readline sequences in the terminal on mac.


`packages/contracts/src/settings.ts:L468-L470`
```ts
  sendShortcut: Schema.Literals(["enter", "mod-enter-multiline", "mod-enter"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("enter")),
  ),
```


#### 1.2 Default keymap (verbatim source)

The default list lives in `packages/shared/src/keybindings.ts` as `DEFAULT_KEYBINDINGS`. It is shared by the server (which writes it to the user's `keybindings.json` on first run and backfills missing defaults) and the web client.

`packages/shared/src/keybindings.ts:L147-L239`
```ts
export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+b", command: "sidebar.toggle" },
  { key: "f6", command: "workspace.focusNext" },
  { key: "shift+f6", command: "workspace.focusPrevious" },
  // Some browsers keep plain F6 for their own toolbars; mod+F6 reaches the page in all of them.
  { key: "mod+f6", command: "workspace.focusNext" },
  { key: "mod+shift+f6", command: "workspace.focusPrevious" },
  { key: "mod+[", command: "navigation.back", when: "!terminalFocus" },
  { key: "mod+]", command: "navigation.forward", when: "!terminalFocus" },
  { key: "mod+j", command: "terminal.toggle" },
  { key: "mod+alt+b", command: "rightPanel.toggle" },
  { key: "mod+shift+b", command: "threadPanel.toggle", when: "!terminalFocus" },
  { key: "mod+t", command: "rightPanel.new", when: "rightPanelOpen && !terminalFocus" },
  { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
  { key: "mod+shift+d", command: "terminal.splitVertical", when: "terminalFocus" },
  { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
  { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
  { key: "mod+w", command: "rightPanel.close", when: "!terminalFocus" },
  { key: "mod+shift+t", command: "view.reopenClosed" },
  { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
  { key: "mod+shift+j", command: "preview.toggle" },
  { key: "mod+r", command: "preview.refresh", when: "previewFocus" },
  { key: "mod+l", command: "preview.focusUrl", when: "previewFocus" },
  { key: "mod+=", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod++", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod+-", command: "preview.zoomOut", when: "previewFocus" },
  { key: "mod+0", command: "preview.resetZoom", when: "previewFocus" },
  { key: "mod+k", command: "commandPalette.toggle", when: "!terminalFocus" },
  { key: "mod+p", command: "filePicker.toggle", when: "!terminalFocus" },
  { key: "mod+shift+f", command: "projectSearch.toggle", when: "!terminalFocus" },
  { key: "mod+u", command: "usage.open", when: "!terminalFocus" },
  { key: "mod+alt+a", command: "theme.select", when: "!terminalFocus" },
  { key: "mod+alt+shift+a", command: "appearance.cycle", when: "!terminalFocus" },
  { key: "mod+alt+shift+t", command: "themeEditor.toggle" },
  { key: "mod+s", command: "composer.stash", when: "!terminalFocus" },
  { key: "mod+shift+enter", command: "thread.steerQueuedMessage", when: "!terminalFocus" },
  { key: "alt+arrowup", command: "thread.editQueuedMessage", when: "composerFocus" },
  { key: "mod+enter", command: "composer.sendAlternate", when: "composerFocus && turnRunning" },
  {
    key: "mod+enter",
    command: "composer.sendBackground",
    when: "composerFocus && draftThreadRoute",
  },
  {
    key: "mod+alt+enter",
    command: "composer.sendBackground",
    when: "composerFocus && draftThreadRoute",
  },
  {
    key: "mod+alt+enter",
    command: "composer.sendAndNewThread",
    when: "composerFocus && !draftThreadRoute",
  },
  { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+n", command: "chat.newLocal", when: "!terminalFocus" },
  { key: "mod+alt+n", command: "chat.newWithoutProject", when: "!terminalFocus" },
  { key: "mod+f", command: "chat.find", when: "!terminalFocus && !previewFocus" },
  { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
  { key: "mod+shift+h", command: "composer.host", when: "!terminalFocus" },
  { key: "mod+shift+e", command: "composer.effort", when: "!terminalFocus" },
  { key: "mod+shift+a", command: "composer.mode", when: "!terminalFocus" },
  { key: "mod+shift+x", command: "composer.workspace", when: "!terminalFocus" },
  { key: "mod+shift+g", command: "composer.branch", when: "!terminalFocus" },
  { key: "mod+shift+l", command: "composer.previousWorktree", when: "!terminalFocus" },
  { key: "mod+shift+k", command: "pullRequest.copyNumber", when: "!terminalFocus" },
  { key: "mod+shift+arrowup", command: "modelPicker.previousProvider", when: "modelPickerOpen" },
  { key: "mod+shift+arrowdown", command: "modelPicker.nextProvider", when: "modelPickerOpen" },
  { key: "mod+o", command: "editor.openFavorite" },
  { key: "mod+shift+[", command: "thread.previous" },
  { key: "mod+shift+]", command: "thread.next" },
  { key: "mod+shift+c", command: "thread.copyReference", when: "!terminalFocus" },
  { key: "mod+shift+s", command: "thread.settle", when: "!terminalFocus" },
  { key: "mod+shift+p", command: "thread.pin", when: "!terminalFocus" },
  { key: "mod+z", command: "thread.undo", when: "!terminalFocus && !editableFocus" },
  ...THREAD_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
    key: `mod+${index + 1}`,
    command,
    when: "!modelPickerOpen && isDesktop",
  })),
  ...MODEL_PICKER_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
    key: `mod+${index + 1}`,
    command,
    when: "modelPickerOpen && isDesktop",
  })),
  { key: "c", command: "usage.cost", when: "usagePageOpen" },
  { key: "t", command: "usage.tokens", when: "usagePageOpen" },
  { key: "l", command: "usage.limits", when: "usagePageOpen" },
  { key: "mod+shift+1", command: "usage.period.day", when: "usagePageOpen" },
  { key: "mod+shift+2", command: "usage.period.week", when: "usagePageOpen" },
  { key: "mod+shift+3", command: "usage.period.month", when: "usagePageOpen" },
  { key: "mod+shift+4", command: "usage.period.quarter", when: "usagePageOpen" },
];
```


#### 1.4 Implementation: custom, no library

Everything is hand-written. The parser, matcher and `when` grammar live in `packages/shared/src/keybindings.ts`; the client resolver, label formatting and helpers in `apps/web/src/keybindings.ts`; a scope-based dispatcher in `apps/web/src/shortcuts/dispatcher.ts`.

##### Key-string grammar

Tokens are split on `+`, lowercased, trimmed. Modifier tokens: `cmd`/`meta`, `ctrl`/`control`, `shift`, `alt`/`option`, `mod`. Exactly one non-modifier key is allowed (two keys = invalid). `space` maps to `" "`, `esc` to `escape`. A trailing `+` (as in `mod++`) is the literal plus key. The result is a `KeybindingShortcut` `{ key, metaKey, ctrlKey, shiftKey, altKey, modKey }`.

`packages/shared/src/keybindings.ts:L241-L309`
```ts
function normalizeKeyToken(token: string): string {
  if (token === "space") return " ";
  if (token === "esc") return "escape";
  return token;
}

export function parseKeybindingShortcut(value: string): KeybindingShortcut | null {
  const rawTokens = value
    .toLowerCase()
    .split("+")
    .map((token) => token.trim());
  const tokens = [...rawTokens];
  let trailingEmptyCount = 0;
  while (tokens[tokens.length - 1] === "") {
    trailingEmptyCount += 1;
    tokens.pop();
  }
  if (trailingEmptyCount > 0) {
    tokens.push("+");
  }
  if (tokens.some((token) => token.length === 0)) {
    return null;
  }
  if (tokens.length === 0) return null;

  let key: string | null = null;
  let metaKey = false;
  let ctrlKey = false;
  let shiftKey = false;
  let altKey = false;
  let modKey = false;

  for (const token of tokens) {
    switch (token) {
      case "cmd":
      case "meta":
        metaKey = true;
        break;
      case "ctrl":
      case "control":
        ctrlKey = true;
        break;
      case "shift":
        shiftKey = true;
        break;
      case "alt":
      case "option":
        altKey = true;
        break;
      case "mod":
        modKey = true;
        break;
      default: {
        if (key !== null) return null;
        key = normalizeKeyToken(token);
      }
    }
  }

  if (key === null) return null;
  return {
    key,
    metaKey,
    ctrlKey,
    shiftKey,
    altKey,
    modKey,
  };
}
```

##### Event matching

`mod` resolves to Meta on mac platforms (`/mac|iphone|ipad|ipod/i` on `navigator.platform`) and Ctrl elsewhere. Modifiers must match exactly (an extra Shift fails). The key side is layout-tolerant: the event matches if the shortcut key equals the layout key (`event.key` lowercased), the physical letter from `event.code` (`KeyA` -> `a`) when the layout key is not a latin letter, or the US punctuation/digit mapped from `event.code` (`BracketLeft` -> `[`, `Digit1` -> `1`). On non-mac, an AltGraph keypress producing a non-alphanumeric char never matches (so AltGr characters type normally).

`packages/shared/src/keybindings.ts:L13-L137`
```ts
export interface ShortcutEventLike {
  getModifierState?: (key: "AltGraph") => boolean;
  type?: string;
  code?: string;
  key: string;
  repeat?: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutModifierStateLike {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export const EVENT_CODE_SHORTCUT_KEYS: Readonly<Record<string, string>> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
};

export const US_SHIFTED_TO_UNSHIFTED_KEYS: ReadonlyMap<string, string> = new Map([
  ["!", "1"],
  ["@", "2"],
  ["#", "3"],
  ["$", "4"],
  ["%", "5"],
  ["^", "6"],
  ["&", "7"],
  ["*", "8"],
  ["(", "9"],
  [")", "0"],
  ["~", "`"],
  ["_", "-"],
  ["+", "="],
  ["{", "["],
  ["}", "]"],
  ["|", "\\"],
  [":", ";"],
  ['"', "'"],
  ["<", ","],
  [">", "."],
  ["?", "/"],
]);

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function normalizeEventKey(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized === "esc") return "escape";
  return normalized;
}

export function shortcutKeyFromEvent(event: Pick<ShortcutEventLike, "key" | "code">): string {
  const layoutKey = normalizeEventKey(event.key);
  if (/^[a-z]$/.test(layoutKey)) return layoutKey;
  const physicalKey = event.code ? EVENT_CODE_SHORTCUT_KEYS[event.code] : undefined;
  return physicalKey ?? layoutKey;
}

export function resolveEventKeys(event: ShortcutEventLike): Set<string> {
  const layoutKey = normalizeEventKey(event.key);
  const keys = new Set([layoutKey]);
  const letterCode = event.code?.match(/^Key([A-Z])$/)?.[1];
  if (letterCode && !/^[a-z]$/.test(layoutKey)) {
    keys.add(letterCode.toLowerCase());
  }
  keys.add(shortcutKeyFromEvent(event));
  return keys;
}

export function matchesKeybindingShortcutModifiers(
  event: ShortcutModifierStateLike,
  shortcut: KeybindingShortcut,
  platform: string,
): boolean {
  const useMetaForMod = isMacPlatform(platform);
  const expectedMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const expectedCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  return (
    event.metaKey === expectedMeta &&
    event.ctrlKey === expectedCtrl &&
    event.shiftKey === shortcut.shiftKey &&
    event.altKey === shortcut.altKey
  );
}

export function matchesKeybindingShortcut(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
  platform: string,
): boolean {
  if (
    !isMacPlatform(platform) &&
    event.getModifierState?.("AltGraph") &&
    !/^[a-z0-9]$/i.test(event.key)
  )
    return false;
  if (!matchesKeybindingShortcutModifiers(event, shortcut, platform)) return false;
  return resolveEventKeys(event).has(shortcut.key);
}
```


##### Merge with user config

If the user file has zero valid rules, defaults are used as-is. Otherwise any default whose COMMAND appears in the user file is dropped entirely (overriding a command replaces all its default chords), and user rules are appended after the remaining defaults. Capped at 256.

`packages/shared/src/keybindings.ts:L478-L498`
```ts
export const DEFAULT_RESOLVED_KEYBINDINGS = compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS);

export function mergeWithDefaultKeybindings(
  custom: ResolvedKeybindingsConfig,
): ResolvedKeybindingsConfig {
  if (custom.length === 0) {
    return [...DEFAULT_RESOLVED_KEYBINDINGS];
  }

  const overriddenCommands = new Set(custom.map((binding) => binding.command));
  const retainedDefaults = DEFAULT_RESOLVED_KEYBINDINGS.filter(
    (binding) => !overriddenCommands.has(binding.command),
  );
  const merged = [...retainedDefaults, ...custom];

  if (merged.length <= MAX_KEYBINDINGS_COUNT) {
    return merged;
  }

  return merged.slice(-MAX_KEYBINDINGS_COUNT);
}
```


#### 1.10 How shortcut hints render

##### Platform symbols

`formatShortcutLabel`: on mac it concatenates symbols with no separator in the order Control, Option, Shift, Command, then key: `⌃⌥⇧⌘K` (e.g. `⇧⌘B`). Elsewhere it joins words with `+` in order Ctrl, Alt, Shift, Meta: `Ctrl+Shift+B`. Key labels: single chars uppercased, `Space`, `Esc`, arrows as `Up`/`Down`/`Left`/`Right`, other names capitalized (`Enter`, `F6`). Note the settings page pill uses a different, per-token renderer (`KeybindingPill` above: `⌘`/`Ctrl`, `⇧` on every platform, `⌥`/`Alt`, `⌃`).

`apps/web/src/keybindings.ts:L208-L256`
```ts
export function formatShortcutKeyLabel(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  if (key === "escape") return "Esc";
  if (key === "arrowup") return "Up";
  if (key === "arrowdown") return "Down";
  if (key === "arrowleft") return "Left";
  if (key === "arrowright") return "Right";
  return key.slice(0, 1).toUpperCase() + key.slice(1);
}

export function formatShortcutLabel(
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): string {
  const keyLabel = formatShortcutKeyLabel(shortcut.key);
  const useMetaForMod = isMacPlatform(platform);
  const showMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const showCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  const showAlt = shortcut.altKey;
  const showShift = shortcut.shiftKey;

  if (useMetaForMod) {
    return `${showCtrl ? "\u2303" : ""}${showAlt ? "\u2325" : ""}${showShift ? "\u21e7" : ""}${showMeta ? "\u2318" : ""}${keyLabel}`;
  }

  const parts: string[] = [];
  if (showCtrl) parts.push("Ctrl");
  if (showAlt) parts.push("Alt");
  if (showShift) parts.push("Shift");
  if (showMeta) parts.push("Meta");
  parts.push(keyLabel);
  return parts.join("+");
}

export function shortcutLabelForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand | null,
  options?: string | ResolvedShortcutLabelOptions,
): string | null {
  if (command === null) return null;
  const resolvedOptions =
    typeof options === "string"
      ? ({ platform: options } satisfies ResolvedShortcutLabelOptions)
      : options;
  const platform = resolvePlatform(resolvedOptions);
  const shortcut = findEffectiveShortcutForCommand(keybindings, command, resolvedOptions);
  return shortcut ? formatShortcutLabel(shortcut, platform) : null;
}
```

##### Kbd component (verbatim)

`apps/web/src/components/ui/kbd.tsx:L1-L28`
```tsx
import type * as React from "react";

import { cn } from "~/lib/utils";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded bg-foreground/[0.07] px-1 font-medium font-sans text-muted-foreground text-xs [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      data-slot="kbd"
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn("inline-flex items-center gap-1", className)}
      data-slot="kbd-group"
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
```

##### Shortcut inside tooltips (pattern)

There is no special tooltip-shortcut component. Tooltips append the label in parentheses: `` `Toggle main sidebar${shortcutLabel ? ` (${shortcutLabel})` : ""}` ``. Labels come from `shortcutLabelForCommand(keybindings, command, { context })`, so they reflect user overrides and context.

`apps/web/src/components/AppSidebarLayout.tsx:L322-L324`
```tsx
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle", {
    context: { usagePageOpen },
  });
```

`apps/web/src/components/AppSidebarLayout.tsx:L382-L398`
```tsx
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger
              variant={isSidebarVisible && stageBackdropVariant ? "media-navigation" : "ghost"}
              className={cn(
                "pointer-events-auto",
                isSidebarVisible && stageBackdropVariant && "relative top-auto translate-y-0",
              )}
              aria-label="Toggle main sidebar"
            />
          }
        />
        <TooltipPopup side="bottom">
          Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
```

`apps/web/src/components/chat/PanelLayoutControls.tsx:L86-L130`
```tsx
      {showTerminalControl ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={terminalOpen}
              onPressedChange={onToggleTerminal}
              aria-label="Toggle terminal drawer"
              variant="ghost"
              size="sm"
              disabled={!terminalAvailable}
            >
              <PanelBottomIcon className="size-4" />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {terminalAvailable
              ? `Toggle terminal drawer${terminalShortcutLabel ? ` (${terminalShortcutLabel})` : ""}`
              : "Terminal drawer is unavailable"}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {showRightPanelControl ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={rightPanelOpen}
              onPressedChange={onToggleRightPanel}
              aria-label="Toggle right panel"
              data-right-panel-toggle
              variant="ghost"
              size="sm"
              disabled={!rightPanelAvailable}
            >
              <PanelRightIcon className="size-4" />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {rightPanelAvailable
              ? `Toggle right panel${rightPanelShortcutLabel ? ` (${rightPanelShortcutLabel})` : ""}`
              : rightPanelUnavailableLabel}
          </TooltipPopup>
        </Tooltip>
      ) : null}
```

`apps/web/src/components/sidebar/SidebarThreadHeader.tsx:L57-L59`
```tsx
  const newThreadLabel = newThreadShortcutLabel
    ? `New thread (${newThreadShortcutLabel})`
    : "New thread";
```

`apps/web/src/components/sidebar/SidebarThreadHeader.tsx:L113-L131`
```tsx
        <SidebarHeaderIconButton
          label="New thread"
          tooltip={
            showNewThreadInProjectHint ? (
              <span className="flex flex-col gap-0.5">
                <span>{newThreadLabel}</span>
                <span className="text-muted-foreground">
                  New thread in current project: Shift+click
                  {newThreadInProjectShortcutLabel ? ` (${newThreadInProjectShortcutLabel})` : ""}
                </span>
              </span>
            ) : (
              newThreadLabel
            )
          }
          disabled={newThreadDisabled}
          onClick={onNewThread}
        >
          <SquarePenIcon />
```

##### Shortcut inside menus / palette rows

`MenuShortcut` and `CommandShortcut` are identical right-aligned `<kbd>` text (no chip): `ms-auto font-medium font-sans text-secondary-label text-xs tracking-widest`. Palette rows render `CommandShortcut` with the formatted label when an item has `shortcutCommand`. The right-panel empty state shows single-letter `Kbd` chips (B, T, F, D, P, L, M).

`apps/web/src/components/ui/menu.tsx:L292-L303`
```tsx
function MenuShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "ms-auto font-medium font-sans text-secondary-label text-xs tracking-widest",
        className,
      )}
      data-slot="menu-shortcut"
      {...props}
    />
  );
}
```

`apps/web/src/components/ui/command.tsx:L204-L215`
```tsx
function CommandShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "ms-auto font-medium font-sans text-secondary-label text-xs tracking-widest",
        className,
      )}
      data-slot="command-shortcut"
      {...props}
    />
  );
}
```

`apps/web/src/components/CommandPaletteResults.tsx:L223-L282`
```tsx
function CommandPaletteResultRow(props: {
  index?: number;
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
  isActive: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}) {
  const shortcutLabel = props.item.shortcutCommand
    ? shortcutLabelForCommand(props.keybindings, props.item.shortcutCommand)
    : null;

  return (
    <CommandItem
      {...(props.index === undefined ? {} : { index: props.index })}
      value={props.item.value}
      active={props.isActive}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onExecuteItem(props.item);
      }}
    >
      <CommandPaletteTitleIcon>{props.item.icon}</CommandPaletteTitleIcon>
      {props.item.description || props.item.threadContentMatch ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            {props.item.titleLeadingContent}
            <CommandPaletteTitle item={props.item} />
            <ThreadRowContext item={props.item} />
          </span>
          {props.item.threadContentMatch ? (
            <ThreadSearchMatchExcerpt match={props.item.threadContentMatch} />
          ) : props.item.matchHint ? (
            <SearchMatchHintLine hint={props.item.matchHint} />
          ) : props.item.description ? (
            <span className="min-w-0 text-muted-foreground/70 text-xs">
              {props.item.description}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
          {props.item.titleLeadingContent}
          <CommandPaletteTitle item={props.item} />
        </span>
      )}
      {props.item.titleTrailingContent}
      {props.item.timestamp ? (
        <span className="min-w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground/70">
          {props.item.timestamp}
        </span>
      ) : null}
      {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
      {props.item.kind === "submenu" ? (
        <ChevronRightIcon className="-me-0.5 ms-auto size-4 shrink-0 text-muted-foreground/70" />
      ) : null}
    </CommandItem>
  );
}
```

`apps/web/src/components/RightPanelTabs.tsx:L273-L293`
```tsx

function SurfaceMenuItem(props: {
  available: boolean;
  disabledReason?: string;
  shortcut: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const item = (
    <MenuItem
      className={!props.available ? "data-disabled:pointer-events-auto" : undefined}
      onClick={props.onClick}
      disabled={!props.available}
      aria-keyshortcuts={props.shortcut}
    >
      {props.children}
      <MenuShortcut>{props.shortcut}</MenuShortcut>
    </MenuItem>
  );
  if (props.available || !props.disabledReason) return item;
  return <DisabledReasonTooltip reason={props.disabledReason} trigger={item} />;
```

##### Composer send tooltip mentions the modifier

While a turn is running and steering is possible, the send tooltip reads "Click to <steer|queue>, ⌘-click or <label> to <alternate>" (`Ctrl` instead of `⌘` off mac). Holding Cmd/Ctrl (tracked by `useShortcutModifierState`) flips the send button icon live between `CornerUpRight` (steer) and `ListPlus` (queue) via MorphIcon.

`apps/web/src/components/chat/ComposerPrimaryActions.tsx:L114-L123`
```tsx
  const shortcutModifiers = useShortcutModifierState();
  const isQueuing =
    !isEditingQueuedMessage &&
    resolveComposerDispatchMode({
      running: isRunning,
      activeTurnDefault: followUpBehavior,
      canSteer,
      alternateModifier: shortcutModifiers.metaKey || shortcutModifiers.ctrlKey,
    }) === "queue";
  const alternateAction = alternateComposerDispatchAction(followUpBehavior);
```

`apps/web/src/components/chat/ComposerPrimaryActions.tsx:L296-L303`
```tsx
    submitStatus ??
    (compactsBeforeSend
      ? `Summarize ${compactTokens} tokens of history, then send`
      : isRunning && !isEditingQueuedMessage && canSteer
        ? `Click to ${followUpBehavior}, ${isMacPlatform(navigator.platform) ? "⌘" : "Ctrl"}-click${alternateShortcutLabel ? ` or ${alternateShortcutLabel}` : ""} to ${alternateAction}`
        : submitLabel);

  const sendButton = (
```


#### 1.11 Hold-modifier-to-reveal hints

`useShortcutModifierState` tracks which of Meta/Ctrl/Alt/Shift are physically held, from window keydown/keyup in capture phase. It resets on paste and window blur (dictation tools can drop Meta keyup), and for non-modifier keys it ANDs current state with the event's flags to self-heal. With `ignoreEditable = true` it reports nothing while focus is in an editable element.

Sidebar thread jump hints: `shouldShowThreadJumpHintsForModifiers` is true when the held modifiers exactly match the modifiers of any effective `thread.jump.N` shortcut (so Cmd on mac by default) and the terminal is not focused. `useThreadJumpHintsVisible` delays showing by 200 ms (so a quick Cmd+1 never flashes hints) and hides immediately on release. Each of the first 9 sidebar rows then shows a `JumpHintBadge` pill (e.g. `⌘1`) absolutely positioned at the row's right edge. Because `thread.jump.*` defaults have `when: "... && isDesktop"`, hints only appear in the desktop app by default.

Model picker rows show their `modelPicker.jump.N` label as a plain `Kbd` always (not gated by holding).

Shift-held "speed mode" in pull-request quick actions uses the same hook.

`apps/web/src/shortcutModifierState.ts:L1-L113`
```ts
import { useEffect, useRef, useState } from "react";
import { isEditableFocused } from "./lib/editableFocus";

export interface ShortcutModifierState {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const EMPTY_SHORTCUT_MODIFIER_STATE: ShortcutModifierState = {
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};

function areShortcutModifierStatesEqual(
  left: ShortcutModifierState,
  right: ShortcutModifierState,
): boolean {
  return (
    left.metaKey === right.metaKey &&
    left.ctrlKey === right.ctrlKey &&
    left.altKey === right.altKey &&
    left.shiftKey === right.shiftKey
  );
}

export function useShortcutModifierState(ignoreEditable = false): ShortcutModifierState {
  const [state, setState] = useState(EMPTY_SHORTCUT_MODIFIER_STATE);
  const stateRef = useRef(EMPTY_SHORTCUT_MODIFIER_STATE);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window key, focus, paste and blur listeners that track held shortcut modifiers
  useEffect(() => {
    const updateState = (next: ShortcutModifierState) => {
      if (areShortcutModifierStatesEqual(stateRef.current, next)) return;
      stateRef.current = next;
      setState(next);
    };
    const onKeyboardEvent = (event: KeyboardEvent) => {
      updateState(
        ignoreEditable && isEditableFocused(event.target)
          ? EMPTY_SHORTCUT_MODIFIER_STATE
          : shortcutModifierStateAfterKeyboardEvent(stateRef.current, event),
      );
    };
    // Dictation tools can omit Meta keyup after synthetic paste, leaving jump hints stuck.
    const onResetEvent = () => {
      updateState(EMPTY_SHORTCUT_MODIFIER_STATE);
    };

    const onFocus = (event: FocusEvent) => {
      if (ignoreEditable && isEditableFocused(event.target)) onResetEvent();
    };
    window.addEventListener("focusin", onFocus);
    window.addEventListener("keydown", onKeyboardEvent, true);
    window.addEventListener("keyup", onKeyboardEvent, true);
    window.addEventListener("paste", onResetEvent, true);
    window.addEventListener("blur", onResetEvent);
    return () => {
      window.removeEventListener("focusin", onFocus);
      window.removeEventListener("keydown", onKeyboardEvent, true);
      window.removeEventListener("keyup", onKeyboardEvent, true);
      window.removeEventListener("paste", onResetEvent, true);
      window.removeEventListener("blur", onResetEvent);
    };
  }, [ignoreEditable]);

  return state;
}

function normalizeModifierKey(key: string): keyof ShortcutModifierState | null {
  switch (key) {
    case "Meta":
    case "OS":
    case "Command":
      return "metaKey";
    case "Control":
      return "ctrlKey";
    case "Alt":
    case "Option":
      return "altKey";
    case "Shift":
      return "shiftKey";
    default:
      return null;
  }
}

export function shortcutModifierStateAfterKeyboardEvent(
  currentState: ShortcutModifierState,
  event: KeyboardEvent,
): ShortcutModifierState {
  const normalizedModifierKey = normalizeModifierKey(event.key);
  let nextState: ShortcutModifierState;
  if (normalizedModifierKey) {
    nextState = {
      ...currentState,
      [normalizedModifierKey]: event.type === "keydown",
    };
  } else {
    // Dictation paste can poison real events with metaKey=true until a physical Meta press.
    nextState = {
      metaKey: currentState.metaKey && event.metaKey,
      ctrlKey: currentState.ctrlKey && event.ctrlKey,
      altKey: currentState.altKey && event.altKey,
      shiftKey: currentState.shiftKey && event.shiftKey,
    };
  }

  return areShortcutModifierStatesEqual(currentState, nextState) ? currentState : nextState;
}
```

`apps/web/src/keybindings.ts:L275-L296`
```ts
export function shouldShowThreadJumpHintsForModifiers(
  modifiers: ShortcutModifierStateLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  // Ghostty can write keys to the shell before window shortcuts run, regardless of the when clause.
  if (resolveContext(options).terminalFocus) {
    return false;
  }

  const platform = resolvePlatform(options);

  for (const command of THREAD_JUMP_KEYBINDING_COMMANDS) {
    const shortcut = findEffectiveShortcutForCommand(keybindings, command, options);
    if (!shortcut) continue;
    if (matchesKeybindingShortcutModifiers(modifiers, shortcut, platform)) {
      return true;
    }
  }

  return false;
}
```

`apps/web/src/components/Sidebar.logic.ts:L55-L55`
```ts
const THREAD_JUMP_HINT_SHOW_DELAY_MS = 200;
```

`apps/web/src/components/Sidebar.logic.ts:L663-L675`
```ts
/**
 * Thread jump hints appear once the jump modifier has been held for a moment,
 * so a quick shortcut never flashes them, and hide as soon as it is released.
 */
export function useThreadJumpHintsVisible(shouldShow: boolean): boolean {
  const [showAt, setShowAt] = React.useState<number | null>(null);
  // The clock is read inside the updater: the compiler caches a bare clock read
  // in render once per instance, so a second hold would reuse the first deadline.
  // React discards this render and re-runs with the update.
  if (shouldShow !== (showAt !== null)) {
    setShowAt(shouldShow ? () => deadlineAfter(THREAD_JUMP_HINT_SHOW_DELAY_MS) : null);
  }
  return useDeadlinePassed(showAt);
```

`apps/web/src/components/Sidebar.tsx:L2828-L2842`
```tsx
  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform: navigator.platform,
      context: {
        terminalFocus: terminalFocused,
        terminalOpen: routeTerminalOpen,
        modelPickerOpen: isModelPickerOpen(),
        isWeb: !isElectron,
        isDesktop: isElectron,
      },
    },
  );
  const showJumpHints = useThreadJumpHintsVisible(shouldShowJumpHintsNow);
```

`apps/web/src/components/Sidebar.tsx:L1366-L1375`
```tsx
  const jumpLabelByKey = (() => {
    const mapping = new Map<string, string>();
    for (const [index, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(index);
      if (!jumpCommand) break;
      const label = shortcutLabelForCommand(keybindings, jumpCommand);
      if (label) mapping.set(threadKey, label);
    }
    return mapping;
  })();
```

`apps/web/src/components/sidebar/SidebarThreadRow.tsx:L151-L160`
```tsx
function JumpHintBadge(props: { label: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1.5 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-3xs font-medium tracking-tight text-foreground shadow-sm"
    >
      {props.label}
    </span>
  );
}
```

`apps/web/src/components/chat/ModelListRow.tsx:L89-L90`
```tsx
      <div className="flex shrink-0 items-center gap-1.5">
        {props.jumpLabel ? <Kbd>{props.jumpLabel}</Kbd> : null}
```

`apps/web/src/components/pullRequest/PullRequestSpeedActions.tsx:L132-L138`
```tsx
/** Tracks Shift for the quick actions below it. */
export function PullRequestSpeedModeProvider({ children }: { children: ReactNode }) {
  const modifiers = useShortcutModifierState(true);
  const speedMode =
    modifiers.shiftKey && !modifiers.metaKey && !modifiers.ctrlKey && !modifiers.altKey;
  return <PullRequestSpeedModeContext value={speedMode}>{children}</PullRequestSpeedModeContext>;
}
```


## 8. Visual style (theme tokens)

### Typography

- Sans: `-apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif` (`apps/web/src/index.css:170-175`, mirrored in `apps/web/src/appearanceFonts.ts:13-14`). So on macOS you get SF Pro, Inter elsewhere.
- Mono: `ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace` (`index.css:173-174`). The runtime default drops `ui-monospace` because "Some engines map `ui-monospace` to a proportional font" (`appearanceFonts.ts:16-18`).
- Sizes are user-configurable. Defaults: interface 16px (root `font-size`, range 12-20), prompt 14px, code 13px (`packages/contracts/src/settings.ts:153-175`). Applied as `root.style.fontSize`, `--font-size-prompt`, `--font-size-code`, `--diffs-font-size` (`appearanceFonts.ts:90-94`). On touch the prompt is forced to at least 16px to stop iOS zoom: `--font-size-prompt-touch: max(var(--font-size-prompt, 1rem), 16px);` (`index.css:133-134`).
- Extra dense text sizes below `text-xs` (`index.css:178-190`): `text-2xs` 11px, `text-3xs` 10px, `text-4xs` 8px, `text-5xs` 7px. Used for metadata rows, badges, counters, keyboard hints.
- Optional `-webkit-font-smoothing: antialiased` toggle (`appearanceFonts.ts:96-100`).

### Density / geometry tokens (`index.css:91-152`)

```css
--control-radius: 0.5rem;
--sidebar-content-inset: 0.5rem;
--sidebar-control-gap: 0.5rem;
--sidebar-row-content-inset: 0.625rem;
--command-shell-inset: 0.5rem;
--command-content-inset: 1rem;
--floating-content-inset: 0.75rem;
--workspace-topbar-height: 52px;
--workspace-titlebar-control-size: 1.75rem;
--workspace-titlebar-control-gap: 0.75rem;
--chat-content-max-width: 46rem;        /* "wide" = 72rem, "full" = 100% (index.css:2258-2264) */
--thread-details-panel-width: 17.5rem;
--workspace-gutter: 0.75rem;            /* 1.25rem from sm up */
--app-scrollbar-width: 6px;
--glass-blur: 12px; --glass-opacity: 80%; --glass-saturation: 1.14;   /* dark: 16px / 1.08 */
```

Radius scale (`index.css:289-294`, base `--radius: 0.5rem` at `index.css:1115`): `sm` 4px, `md` 6px, `lg` 8px, `xl` 12px, `2xl` 16px, `3xl` 20px.

Shadows/motion (`index.css:193-201`):
```css
--inset-shadow-control-highlight: 0 1px rgb(255 255 255 / 16%);
--inset-shadow-control-pressed: 0 1px rgb(0 0 0 / 8%);
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
--shadow-composer: 0 1px 2px rgb(0 0 0 / 5%);
--shadow-composer-dark: 0 14px 32px -18px rgb(0 0 0 / 75%);
```

### Color tokens (default theme, `index.css:1113-1229`)

Light is a quiet zinc ladder on a near-white canvas (`--color-zinc-25: oklch(99.2% 0 0)` is a custom step, `index.css:222`). Dark is true black with raised surfaces mixed 3% toward white. Primary is an indigo-blue `oklch(0.488 0.217 264)` (light) / `oklch(0.571 0.21 264)` (dark). Focus ring = primary.

The app wraps every foreground/border token in a `--contrast-*` layer (`index.css:1599-1711`) that implements an "increase contrast" setting. At defaults (`--appearance-contrast-base: 100%`, `--appearance-contrast-boost: 0%`) `--contrast-foreground` equals `--foreground`, so the paste-ready block below maps utilities straight to the raw tokens.

The sidebar gets its own scoped palette via `[data-app-sidebar]` (`index.css:1231-1278`): zinc-50 nav, zinc-25 hover, white selected row in light; black with 8%/11%/7% white overlays for hover/active/selected in dark.

Everything else on top of the base: body gets a procedural SVG noise grain at 0.035 opacity (`index.css:1763-1780`), glass utilities `surface-glass`, `dialog-glass`, `dropdown-glass`, `dialog-backdrop` (`index.css:364-467`), lucide stroke lowered to 1.75 globally (`index.css:1721-1727`), thin 6px scrollbars with 3px radius (`index.css:1845-1861`), and a global `* { @apply border-border outline-ring/50; }` plus `outline-offset: -2px` so focus outlines sit inside controls (`index.css:714-722`).

Five built-in palette themes also exist (`t3-chat`, `grove`, `ocean`, `ember`, `iris`) with light/dark OKLCH background/foreground/accent, defined in the boot script of `apps/web/index.html` and in `index.css` under `html[data-theme-id=...]`. A pre-React inline script in `index.html` reads `localStorage["t3code:theme"]`, toggles `.dark` on `<html>` and sets `meta[name=theme-color]` so there is no theme flash.


### Paste-ready Tailwind 4 theme (for `web/src/app/globals.css`)

This is a condensed port of `apps/web/src/index.css`. Every value is copied from the cited lines. Two simplifications, both deliberate:
- The `--contrast-*` accessibility layer (`index.css:L1599-L1711`) is dropped. Utilities map straight to the raw tokens, which is exactly what the layer resolves to at its defaults.
- Electron-only bits (window-controls overlay, drag regions) and the five extra palette themes are left out.

Swap the indigo primary for our own brand later. Every surface derives from these tokens, so one change propagates.

```css
@import "tailwindcss";

@custom-variant dark (&:is(.dark, .dark *));
@custom-variant light (&:not(.dark, .dark *));
@custom-variant any-hover {
  @media (any-hover: hover) {
    &:hover {
      @slot;
    }
  }
}

/* index.css:L170-L175 (fonts are runtime-overridable, so keep them out of @theme inline) */
@theme {
  --font-sans:
    -apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif;
  --font-mono:
    ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace;
}

@theme inline {
  /* index.css:L183-L190 dense text sizes: 2xs 11px, 3xs 10px, 4xs 8px, 5xs 7px */
  --text-2xs: 0.6875rem;
  --text-2xs--line-height: calc(1 / 0.6875);
  --text-3xs: 0.625rem;
  --text-3xs--line-height: calc(0.875 / 0.625);
  --text-4xs: 0.5rem;
  --text-4xs--line-height: 1;
  --text-5xs: 0.4375rem;
  --text-5xs--line-height: 1;

  /* index.css:L193-L201 */
  --inset-shadow-control-highlight: 0 1px rgb(255 255 255 / 16%);
  --inset-shadow-control-pressed: 0 1px rgb(0 0 0 / 8%);
  --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
  --shadow-composer: 0 1px 2px rgb(0 0 0 / 5%);
  --shadow-composer-dark: 0 14px 32px -18px rgb(0 0 0 / 75%);
  --color-zinc-25: oklch(99.2% 0 0);

  --animate-skeleton: skeleton 2.4s infinite;
  --animate-status-pulse: status-pulse 2s infinite;
  --animate-status-ping: status-ping 2s infinite;

  /* index.css:L233-L288 semantic colors (mapped to raw tokens, see note above) */
  --color-warning-foreground: var(--warning-foreground);
  --color-warning: var(--warning);
  --color-warning-surface: var(--warning-surface);
  --color-error-foreground: var(--error-foreground);
  --color-tool-error-icon: var(--tool-error-icon);
  --color-error: var(--error);
  --color-error-surface: var(--error-surface);
  --color-success-foreground: var(--success-foreground);
  --color-success: var(--success);
  --color-info-foreground: var(--info-foreground);
  --color-info: var(--info);
  --color-diff-addition: var(--diff-addition);
  --color-diff-deletion: var(--diff-deletion);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-destructive: var(--destructive);
  --color-ring: var(--ring);
  --color-input: var(--input);
  --color-border: var(--border);
  --color-accent-foreground: var(--accent-foreground);
  --color-accent: var(--accent);
  --color-muted-foreground: var(--muted-foreground);
  --color-muted: var(--muted);
  --color-placeholder: var(--placeholder);
  --color-secondary-label: var(--secondary-label);
  --color-icon-muted: var(--icon-muted);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-secondary: var(--secondary);
  --color-primary-foreground: var(--primary-foreground);
  --color-primary: var(--primary);
  --color-popover-foreground: var(--popover-foreground);
  --color-popover: var(--popover);
  --color-card-foreground: var(--card-foreground);
  --color-card: var(--card);
  --color-code: var(--code-background);
  --color-foreground: var(--foreground);
  --color-background: var(--background);
  --color-message: var(--message-surface);
  --color-message-foreground: var(--message-foreground);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-muted-foreground: var(--sidebar-muted-foreground);
  --color-sidebar-control-surface: var(--sidebar-control-surface);
  --color-sidebar-row-hover: var(--sidebar-row-hover);
  --color-sidebar-row-active: var(--sidebar-row-active);
  --color-sidebar-row-selected: var(--sidebar-row-selected);
  --color-sidebar-border: var(--sidebar-border);

  /* index.css:L289-L294 */
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --radius-2xl: calc(var(--radius) + 8px);
  --radius-3xl: calc(var(--radius) + 12px);

  /* index.css:L295-L361 stepped (duty-cycled) animations */
  @keyframes skeleton {
    0%, 42% { opacity: 1; animation-timing-function: steps(4); }
    50%, 92% { opacity: 0.55; animation-timing-function: steps(4); }
    100% { opacity: 1; }
  }
  @keyframes status-pulse {
    0%, 40% { opacity: 1; animation-timing-function: steps(6); }
    50%, 90% { opacity: 0.5; animation-timing-function: steps(6); }
    100% { opacity: 1; }
  }
  @keyframes status-ping {
    0% { opacity: 0.9; scale: 0.75; animation-timing-function: steps(8); }
    40%, 100% { opacity: 0; scale: 2; }
  }
}

/* index.css:L91-L152 geometry */
:root {
  --app-scrollbar-width: 6px;
  --app-scrollbar-thumb: rgb(217 217 217);
  --app-scrollbar-thumb-hover: rgb(191 191 191);
  --control-radius: 0.5rem;
  --sidebar-content-inset: 0.5rem;
  --sidebar-control-gap: 0.5rem;
  --sidebar-row-content-inset: 0.625rem;
  --command-shell-inset: 0.5rem;
  --command-content-inset: 1rem;
  --floating-content-inset: 0.75rem;
  --glass-blur: 12px;
  --glass-opacity: 80%;
  --glass-saturation: 1.14;
  --workspace-topbar-height: 52px;
  --workspace-titlebar-control-size: 1.75rem;
  --workspace-titlebar-control-gap: 0.75rem;
  --chat-content-max-width: 46rem;
  --thread-details-panel-width: 17.5rem;
  --font-size-prompt: 14px;            /* runtime default, appearanceFonts.ts:L91 + contracts DEFAULT_PROMPT_FONT_SIZE */
  --font-size-code: 13px;              /* contracts DEFAULT_CODE_FONT_SIZE */
  --font-size-prompt-touch: max(var(--font-size-prompt, 1rem), 16px);
  --workspace-gutter: 0.75rem;
  --workspace-gutter-start: calc(env(safe-area-inset-left) + var(--workspace-gutter));
  --workspace-gutter-end: calc(env(safe-area-inset-right) + var(--workspace-gutter));

  @variant sm {
    --workspace-gutter: 1.25rem;
  }

  @variant dark {
    --app-scrollbar-thumb: rgb(255 255 255 / 8%);
    --app-scrollbar-thumb-hover: rgb(255 255 255 / 12%);
    --glass-blur: 16px;
    --glass-saturation: 1.08;
  }
}

/* index.css:L1113-L1229 colors */
:root {
  color-scheme: light;
  --radius: 0.5rem;
  --background: var(--color-zinc-25);
  --app-chrome-background: var(--background);
  --foreground: var(--color-zinc-900);
  --card: var(--color-white);
  --card-foreground: var(--color-zinc-900);
  --popover: var(--color-white);
  --popover-foreground: var(--color-zinc-900);
  --primary: oklch(0.488 0.217 264);
  --primary-foreground: var(--color-white);
  --secondary: var(--color-zinc-50);
  --secondary-foreground: var(--color-zinc-800);
  --muted: var(--color-zinc-50);
  --muted-foreground: var(--color-zinc-500);
  --placeholder: var(--muted-foreground);
  --secondary-label: var(--muted-foreground);
  --icon-muted: var(--muted-foreground);
  --message-surface: color-mix(in srgb, var(--color-zinc-200) 55%, var(--color-zinc-100));
  --message-foreground: var(--foreground);
  --accent: var(--color-zinc-100);
  --accent-foreground: var(--color-zinc-900);
  --error: var(--color-red-500);
  --error-foreground: var(--color-red-700);
  --tool-error-icon: var(--error);
  --error-surface: color-mix(in srgb, var(--error) 8%, transparent);
  --destructive: var(--error);
  --border: var(--color-zinc-200);
  --input: var(--color-zinc-300);
  --ring: var(--primary);
  --destructive-foreground: var(--error-foreground);
  --info: var(--color-blue-500);
  --info-foreground: var(--color-blue-700);
  --success: var(--color-emerald-500);
  --success-foreground: var(--color-emerald-700);
  --warning: var(--color-amber-500);
  --warning-foreground: var(--color-amber-700);
  --warning-surface: color-mix(in srgb, var(--warning) 8%, transparent);
  --sidebar: var(--color-zinc-50);
  --sidebar-foreground: var(--foreground);
  --sidebar-muted-foreground: var(--muted-foreground);
  --sidebar-control-surface: var(--color-zinc-100);
  --sidebar-row-hover: var(--color-zinc-25);
  --sidebar-row-active: var(--color-white);
  --sidebar-row-selected: var(--color-white);
  --sidebar-border: var(--border);
  --code-background: color-mix(in srgb, var(--card) 90%, var(--background));
  --diff-addition: var(--success);
  --diff-deletion: var(--destructive);

  @variant dark {
    color-scheme: dark;
    --background: #000;
    --foreground: var(--color-neutral-100);
    --card: color-mix(in srgb, var(--color-neutral-950) 97%, var(--color-white));
    --card-foreground: var(--color-neutral-100);
    --popover: color-mix(in srgb, var(--color-neutral-950) 97%, var(--color-white));
    --popover-foreground: var(--color-neutral-100);
    --primary: oklch(0.571 0.21 264);
    --secondary: --alpha(var(--color-white) / 3%);
    --secondary-foreground: var(--color-neutral-100);
    --muted: --alpha(var(--color-white) / 3%);
    --muted-foreground: var(--color-neutral-400);
    --accent: --alpha(var(--color-white) / 4%);
    --accent-foreground: var(--color-neutral-100);
    --message-surface: color-mix(in srgb, var(--color-neutral-950) 92%, var(--color-white));
    --error: color-mix(in srgb, var(--color-red-500) 90%, var(--color-white));
    --error-foreground: var(--color-red-400);
    --tool-error-icon: #fca5a5;
    --error-surface: color-mix(in srgb, var(--error) 16%, transparent);
    --border: --alpha(var(--color-white) / 8%);
    --input: --alpha(var(--color-white) / 11%);
    --info-foreground: var(--color-blue-400);
    --success-foreground: var(--color-emerald-400);
    --warning-foreground: var(--color-amber-400);
    --warning-surface: color-mix(in srgb, var(--warning) 16%, transparent);
    --sidebar: var(--card);
    --sidebar-control-surface: var(--muted);
    --sidebar-row-hover: var(--accent);
    --sidebar-row-active: var(--accent);
    --sidebar-row-selected: var(--muted);
  }
}

/* index.css:L1234-L1278 the app sidebar carries its own scoped palette */
[data-app-sidebar] {
  --background: var(--color-zinc-25);
  --foreground: var(--color-zinc-900);
  --card: var(--color-white);
  --accent: var(--color-zinc-100);
  --muted: var(--color-zinc-50);
  --muted-foreground: var(--color-zinc-500);
  --border: var(--color-zinc-200);
  --input: var(--color-zinc-300);
  --sidebar: var(--color-zinc-50);
  --sidebar-foreground: var(--color-zinc-900);
  --sidebar-muted-foreground: var(--color-zinc-500);
  --sidebar-control-surface: var(--color-zinc-100);
  --sidebar-row-hover: var(--color-zinc-25);
  --sidebar-row-active: var(--color-white);
  --sidebar-row-selected: var(--color-white);
  --sidebar-border: var(--color-zinc-200);

  @variant dark {
    --background: #000;
    --foreground: #f1f3f7;
    --card: #000;
    --accent: #191a1d;
    --muted: #0a0a0a;
    --muted-foreground: #a3a3a3;
    --border: rgb(255 255 255 / 8%);
    --input: rgb(255 255 255 / 18%);
    --sidebar: var(--card);
    --sidebar-foreground: var(--foreground);
    --sidebar-muted-foreground: var(--muted-foreground);
    --sidebar-control-surface: var(--muted);
    --sidebar-row-hover: color-mix(in srgb, var(--foreground) 8%, transparent);
    --sidebar-row-active: color-mix(in srgb, var(--foreground) 11%, transparent);
    --sidebar-row-selected: color-mix(in srgb, var(--foreground) 7%, transparent);
    --secondary-label: #8f8f8f;
  }
}

/* index.css:L364-L467 glass utilities */
@utility surface-glass {
  background: color-mix(in srgb, var(--background) var(--glass-opacity), transparent);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
}
@utility dialog-glass {
  background: color-mix(in srgb, var(--background) var(--glass-opacity), transparent);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
  border-color: color-mix(in srgb, var(--foreground) 10%, transparent);
  box-shadow: 0 24px 64px -24px rgb(0 0 0 / 65%);
  @variant dark {
    border-color: color-mix(in srgb, var(--color-white) 8%, transparent);
    box-shadow:
      inset 0 1px rgb(255 255 255 / 4%),
      0 24px 72px -20px rgb(0 0 0 / 90%);
  }
}
@utility dialog-backdrop {
  background: color-mix(in srgb, var(--background) 60%, transparent);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  @variant dark {
    background: color-mix(in srgb, var(--background) 64%, transparent);
  }
}
@utility dropdown-glass {
  background: color-mix(
    in srgb,
    var(--popover) 18%,
    color-mix(in srgb, var(--popover) var(--glass-opacity), transparent)
  );
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
  border: 1px solid color-mix(in srgb, var(--foreground) 10%, transparent);
}

/* index.css:L1098-L1102 + L1763-L1780 grain texture */
:root {
  --surface-grain: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.035'/%3E%3C/svg%3E");
  --surface-grain-size: 256px 256px;
}
@utility surface-grain {
  background-image: var(--surface-grain);
  background-repeat: repeat;
  background-size: var(--surface-grain-size);
}

/* index.css:L714-L737 + L1713-L1727 base */
@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  *,
  ::before,
  ::after {
    outline-offset: -2px;
  }
  html,
  body {
    background-color: var(--app-chrome-background);
  }
  body {
    @apply text-foreground relative;
    font-family: var(--font-sans);
    background-image: var(--surface-grain);
    background-repeat: repeat;
    background-size: var(--surface-grain-size);
  }
  :where(svg.lucide[stroke-width="2"]) {
    stroke-width: 1.75;
  }
}

pre,
code {
  font-family: var(--font-mono);
}

/* index.css:L1845-L1861 */
::-webkit-scrollbar { width: var(--app-scrollbar-width); }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--app-scrollbar-thumb); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--app-scrollbar-thumb-hover); }

/* index.css:L1104-L1111 kill transitions while switching theme */
.no-transitions,
.no-transitions *,
.no-transitions *::before,
.no-transitions *::after {
  transition-duration: 0s !important;
  animation-duration: 0s !important;
}
```

Theme switching: t3code sets `.dark` on `<html>` from an inline pre-paint script (`apps/web/index.html`, reads `localStorage["t3code:theme"]`, falls back to `prefers-color-scheme`). In Next.js, use `next-themes` with `attribute="class"`, or the same inline script in `app/layout.tsx`, to get the same no-flash result.

Interface font size defaults to 16px on the root (range 12-20), so `rem` scales with the user preference (`packages/contracts/src/settings.ts:L153-L159`, `apps/web/src/appearanceFonts.ts:L90`).

### Button primitive (verbatim)

#### 3.1 Button (cva, verbatim)

Notable: press feedback is `active:scale-[0.97]` (skipped for `aria-haspopup` triggers); focus ring `focus-visible:ring-2 ring-inset ring-ring ring-offset-1`; disabled `opacity-64`; coarse pointers get an invisible 44px (`min-h-11 min-w-11`) hit area; `sm:` breakpoint shrinks heights by one step (mobile-first is larger). Primary has a 1px white inset top highlight.

`apps/web/src/components/ui/button.tsx:L1-L131`
```tsx
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";

const buttonVariants = cva(
  "[--control-icon-color:currentColor] [&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border font-medium text-base outline-none transition-[box-shadow,scale] [&:not([aria-haspopup]):not(:disabled):not([aria-disabled=true])]:will-change-[scale] [&:active:not([aria-haspopup])]:scale-[0.97] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-not-allowed aria-disabled:opacity-64 sm:text-sm [&_svg:not([class*='text-'])]:text-[var(--control-icon-color)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        compact:
          "h-7 gap-1 rounded-md px-[calc(--spacing(2)-1px)] text-xs before:rounded-[calc(var(--radius-md)-1px)] [&_svg:not([class*='size-'])]:size-3.5",
        default: "h-9 px-[calc(--spacing(3)-1px)] sm:h-8",
        icon: "size-9 sm:size-8",
        "icon-lg": "size-10 sm:size-9",
        "icon-micro":
          "size-5 rounded-sm p-0 before:rounded-[calc(var(--radius-sm)-1px)] [&_svg:not([class*='size-'])]:size-3",
        "icon-tiny": "size-4 p-0 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 sm:size-7",
        "icon-xl":
          "size-11 sm:size-10 [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        "icon-xs":
          "size-7 sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 px-[calc(--spacing(3.5)-1px)] sm:h-9",
        micro:
          "h-5 gap-1 rounded-sm px-[calc(--spacing(1.5)-1px)] text-[11px] before:rounded-[calc(var(--radius-sm)-1px)] sm:text-[11px] [&_svg:not([class*='size-'])]:size-3 sm:[&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:h-7",
        "sm-multiline":
          "min-h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] py-[calc(--spacing(1)-1px)] whitespace-normal sm:min-h-7",
        xl: "h-11 px-[calc(--spacing(4)-1px)] text-lg sm:h-10 sm:text-base [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        xs: "h-7 gap-1 px-[calc(--spacing(2)-1px)] text-sm sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        default:
          "not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] border-primary bg-primary text-primary-foreground shadow-primary/24 shadow-xs [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:bg-primary/90",
        destructive:
          "not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] border-destructive bg-destructive text-white shadow-destructive/24 shadow-xs [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:bg-destructive/90",
        "destructive-outline":
          "border-input bg-popover not-dark:bg-clip-padding text-destructive-foreground shadow-xs/5 not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:bg-input/32 dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:border-destructive/32 [:hover,[data-pressed]]:bg-destructive/4",
        ghost:
          "[--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent",
        "ghost-muted":
          "[--control-icon-color:currentColor] border-transparent text-muted-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent [:hover,[data-pressed]]:text-foreground",
        "ghost-destructive":
          "[--control-icon-color:currentColor] border-transparent text-muted-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent [:hover,[data-pressed]]:text-destructive",
        glass:
          "surface-glass [--control-icon-color:var(--contrast-muted-foreground)] rounded-full border-border/60 text-foreground shadow-sm before:rounded-full [:hover,[data-pressed]]:border-border",
        link: "border-transparent underline-offset-4 [:hover,[data-pressed]]:underline",
        "media-close":
          "[--control-icon-color:currentColor] border-transparent bg-black/65 text-white shadow-sm ring-1 ring-white/20 [:hover,[data-pressed]]:bg-black/80 focus-visible:ring-white",
        "media-navigation":
          "[--control-icon-color:currentColor] absolute top-1/2 z-20 -translate-y-1/2 border-transparent text-white/90 [:hover,[data-pressed]]:bg-white/10 [:hover,[data-pressed]]:text-white focus-visible:ring-white focus-visible:ring-offset-transparent",
        outline:
          "[--control-icon-color:var(--contrast-muted-foreground)] border-input bg-popover not-dark:bg-clip-padding text-foreground shadow-xs/5 not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:bg-input/32 dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:bg-accent/50 dark:[:hover,[data-pressed]]:bg-input/64",
        overlay: "border-transparent bg-black/70 text-white/65 [:hover,[data-pressed]]:bg-black/90",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [:active,[data-pressed]]:bg-secondary/80 [:hover,[data-pressed]]:bg-secondary/90",
        "warning-outline":
          "border-warning/32 bg-warning-surface text-warning-foreground shadow-xs/5 [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:border-warning/40 [:hover,[data-pressed]]:bg-warning/16 dark:[:hover,[data-pressed]]:bg-warning/24",
      },
    },
  },
);

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

function Button({ className, variant, size, render, ...props }: ButtonProps) {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] = render
    ? undefined
    : "button";

  const defaultProps = {
    className: cn(buttonVariants({ className, size, variant })),
    "data-slot": "button",
    type: typeValue,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export { Button, buttonVariants, type ButtonSize, type ButtonVariant };

const inlineButtonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center gap-0.5 font-medium underline-offset-2 [text-align:var(--inline-button-text-align,center)] [white-space:var(--inline-button-white-space,nowrap)] hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64",
  {
    defaultVariants: { tone: "default" },
    variants: {
      tone: {
        default: "text-foreground",
        muted: "text-muted-foreground hover:text-foreground",
        destructive: "text-destructive/80 hover:text-destructive",
        picker:
          "gap-1 text-foreground decoration-from-font underline-offset-4 data-popup-open:underline",
      },
    },
  },
);

export function InlineButton({
  className,
  tone,
  render,
  ...props
}: useRender.ComponentProps<"button"> & VariantProps<typeof inlineButtonVariants>) {
  const defaultProps = {
    className: cn(inlineButtonVariants({ tone }), className),
    "data-slot": "inline-button",
    type: render ? undefined : ("button" as const),
  };
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}
```


## 9. Message / timeline rendering

Core files: `apps/web/src/components/chat/MessagesTimeline.tsx`, `MessagesTimeline.logic.ts`, `TimelineUserMessageRow.tsx`, `TimelineAssistantRows.tsx`, `TimelineWorkGroupRows.tsx`, `TimelineWorkEntryRow.tsx`, `V2ItemInspector.tsx`, `ProposedPlanCard.tsx`, `ChangedFilesTree.tsx`, `apps/web/src/session-logic.ts`.

### 9.1 Summary

**Shell.** One virtualized `LegendList` (`@legendapp/list` 3.3.5) whose rows are a discriminated union: `message`, `work`, `work-live`, `work-toggle`, `thinking`, `working`, `turn-fold`, `proposed-plan`, `context-compaction`, `event`, and others. It starts at the end and uses `maintainScrollAtEnd` (animated while the agent works, unless reduced motion) with `estimatedItemSize={90}`. Content is centered in a lane capped at `--chat-content-max-width: 46rem` (72rem "wide", 100% "full").

**User message.** A right-aligned bubble: `max-w-[80%] rounded-2xl bg-message p-3`, rendered as markdown with line breaks kept and raw HTML off.
- Long messages (over 600 chars or 8 lines) collapse to `max-h-44` with a bottom fade and a "Show full message" ghost button.
- A hover meta row underneath holds timestamp, "Edit from here" (`Undo2`), copy, and copy link.
- A "Steer" marker (`Redo2`) sits above messages that steered a running turn.

**Assistant message.** No bubble, no avatar: a `px-1 py-0.5` block of markdown (`text-sm leading-relaxed`), an optional changed-files card, and a meta row (status pill, copy, fork, timestamp). The meta row stays invisible until hover (`group-hover/assistant:opacity-100`) and is always visible on touch. Empty output shows "(empty response)".

**Streaming.** No caret. New markdown blocks fade in over 600ms via `@starting-style`. The live row and the "Thinking" label get a moving text shimmer (`live-tool-shine`, 2.2s `steps(30)`, `index.css:L551-L578`, off under reduced motion). A "Working for {timer}" row ticks every second at the end of the active turn.

**Work log (tool calls).** Consecutive tool calls between messages collapse into one entry:
- If any call in the group is active: one `work-live` row showing the latest tool (click to expand).
- If there's exactly one call: a standalone row with that tool's label.
- Otherwise: a collapsed `work-toggle` header with a summary sentence like "Read 3 files and ran 2 commands" (top two actions, then "Performed N other actions"). Expanding opens a nested, virtualized region capped at `min(18rem, 50dvh)`.

Icons are lucide `size-4`, muted. Failed tools tint the icon `text-tool-error-icon/40` and add a trailing `XIcon`.

**Single entry.** Icon, label, hover timestamp, and a `ChevronRight` that rotates 90 degrees when open. The expanded body is either a mono `<pre>` (`max-h-64`) or an inspector:
- Commands: a highlighted shell line plus streamed ANSI output (`max-h-80`, follows the bottom), with `exit N` in red for non-zero exits.
- File changes: `path +N -M [Open diff]`. **Full diffs open in the right panel, not inline.**

**Changed files card**, under the assistant turn: `mt-4 rounded-lg bg-secondary`, with a sticky header ("N changed files +A -D"), an expand-all toggle and an "Open diff" button. The body is a folder tree with 28px rows, a 14px indent per level and per-file +N/-M. Clicking a file opens it in the diff panel.

**Approvals.** Rendered inline in the work log:
- a request-kind icon (terminal / square-pen / eye / wrench)
- the command in a scrollable `<code>` block (`max-h-40`)
- then an amber shield, "Waiting for approval", and buttons: "Approve" (default tone) and "Decline" (muted), with "Cancel" and "Always allow this session" under a "More" menu

There are **no approval keyboard shortcuts.** While an approval is pending, the composer placeholder changes, and sending a message declines and redirects. If the provider process died: "Provider process is gone. Interrupt or restart the run to respond."

**Agent questions.** A collapsible card attached above the composer: question in markdown, then radio/checkbox rows each with a `Kbd` digit on the right. Pressing 1-9 picks an option, and single-select auto-advances after 200ms. Multi-question flows show "2/3" with "Next question" / "Submit answers".

**Proposed plan card.** `rounded-2xl border border-border/80 bg-card/70 p-4 sm:p-5`, with a "Plan" badge, a title, and a menu (Copy / Download as markdown / Save to workspace). Long plans collapse to `max-h-104` with "Expand plan". The composer then shows a "Plan ready" banner, and send becomes "Implement" (split: "Implement in a new thread").

**Errors.** A red `CircleAlertIcon` row with the message and an outline "Retry" button. Usage limits use warning color: "Usage limit reached. Retry after {time}." Thread-level errors are a dismissible glass `Alert` banner at the top of the chat column.

**Dividers.** Lifecycle events are centered hairline dividers with a `text-2xs` label: "Run interrupted", "Forked from conversation", "Context handoff", and "Context compacted {before} → {after} tokens".

**Scroll.** Stick-to-bottom, released when the user scrolls up. A "Scroll to end" glass pill (`ChevronDown`) appears above the composer when not at the end (150ms debounced show, instant hide). It can carry a summary such as "Subagent waiting · 2 queued". A left-edge minimap draws one tick per user message (fine pointers only, needs 2+ messages).

### 9.2 Verbatim evidence

#### Essential timeline JSX

Core row components, trimmed. Each fragment is verbatim from its header range; `// ...` marks a trim between fragments.

##### User message row

`apps/web/src/components/chat/TimelineUserMessageRow.tsx:L131-L144`

```tsx
export function UserMessageRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  return ctx.workflowOpening?.messageId === row.message.id ? (
    <WorkflowOpeningBlock
      opening={ctx.workflowOpening}
      environmentId={ctx.activeThreadEnvironmentId}
      onOpenThread={(threadId) => ctx.onOpenThread(ThreadId.make(threadId))}
    />
  ) : resolveUserMessagePresentation(row.message).attribution === "automation" ? (
    <AutomationMessageRow row={row} />
  ) : (
    <UserTimelineRow row={row} />
  );
}
```
// ...

`apps/web/src/components/chat/TimelineUserMessageRow.tsx:L445-L475`

```tsx
  return (
    <div
      className="group flex flex-col items-end gap-1"
      data-user-message-attribution={folded ? "agent" : undefined}
    >
      {userMessage.attribution === "t3code" ? (
        <p
          className="me-1 text-2xs text-muted-foreground/70"
          data-user-message-attribution="t3code"
        >
          Sent by T3 Code
        </p>
      ) : null}
      {/* The row's heading already names the guest for screen readers. */}
      {userMessage.guestName !== undefined ? (
        <div aria-hidden>
          <GuestMessageName name={userMessage.guestName} />
        </div>
      ) : null}
      {row.message.inputIntent === "steer" ||
      row.message.inputIntent === "promoted_queued_to_steer" ? (
        <UserMessageIntentMarker intent={row.message.inputIntent} />
      ) : null}
      <div
        className={cn(
          "relative min-w-0 max-w-[80%] rounded-2xl text-message-foreground",
          BUBBLE_CHIP_CLASS_NAME,
          userMessage.attribution === "guest" ? guestBubbleClassName(false) : "bg-message",
          !folded && "p-3",
          folded && expanded && "w-full",
        )}
```
// ...

`apps/web/src/components/chat/TimelineUserMessageRow.tsx:L646-L662`

```tsx
      <UserMessageProjectedStatus row={row} />
      {!folded || expanded ? (
        <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover:opacity-100">
          <div className="flex shrink-0 items-center gap-2">
            {folded && senderThreadId ? (
              <InlineButton onClick={() => ctx.onOpenThread(senderThreadId)} tone="muted">
                Open thread
              </InlineButton>
            ) : null}
            <Tooltip>
              <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
                {formatDayAwareTimestamp(row.message.createdAt, ctx.timestampFormat)}
              </TooltipTrigger>
              <TooltipPopup>
                {formatChatTimestampTooltip(row.message.createdAt, ctx.timestampFormat)}
              </TooltipPopup>
            </Tooltip>
```

##### Assistant row

`apps/web/src/components/chat/TimelineAssistantRows.tsx:L26-L76`

```tsx
export function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");

  return (
    <>
      <div className="relative min-w-0 px-1 py-0.5">
        <MessageAuthorHeading>T3 Code</MessageAuthorHeading>
        <div data-thread-find-text="true">
          <AssistantCitationSource
            messageId={row.message.id}
            {...(ctx.threadRef ? { threadRef: ctx.threadRef } : {})}
            itemKey={row.id}
            request={ctx.citationRequest}
            listRef={ctx.listRef}
          >
            <ChatMarkdown
              text={messageText}
              cwd={ctx.markdownCwd}
              threadRef={ctx.threadRef ?? undefined}
              isStreaming={Boolean(row.message.streaming)}
              lineBreaks={shouldPreserveAssistantLineBreaks(messageText)}
              skills={ctx.skills}
              headingLevelOffset={MESSAGE_HEADING_LEVEL}
              onUseArtifactTemplate={ctx.onUseArtifactTemplate}
              onRunShellCommand={ctx.onRunShellCommand}
              onImageExpand={ctx.onImageExpand}
            />
          </AssistantCitationSource>
        </div>
        {ctx.onOpenTurnDiff ? (
          <AssistantChangedFilesSection
            turnSummary={row.assistantTurnDiffSummary}
            routeThreadKey={ctx.routeThreadKey}
            resolvedTheme={ctx.resolvedTheme}
            onOpenTurnDiff={ctx.onOpenTurnDiff}
          />
        ) : null}
        {row.showAssistantMeta ? (
          <AssistantMessageMeta
            className="mt-1.5"
            projectedItem={row.projectedItem}
            message={row.message}
            showCopyButton={row.showAssistantCopyButton}
            copyStreaming={row.assistantCopyStreaming}
          />
        ) : null}
      </div>
    </>
  );
}
```

##### Work group rows

`apps/web/src/components/chat/TimelineWorkGroupRows.tsx:L98-L110`

```tsx
  return (
    <section aria-label="Activity">
      {nonEmptyEntries.map((workEntry) => (
        <SimpleWorkEntryRow
          key={workEntry.id}
          workEntry={workEntry}
          workspaceRoot={workspaceRoot}
          displayLabel={displayLabel}
          onToggleEntry={onToggleStandaloneEntry}
        />
      ))}
    </section>
  );
```
// ...

`apps/web/src/components/chat/TimelineWorkGroupRows.tsx:L277-L309`

```tsx
export function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  const { isCompacting, isPreparingWorktree, backgroundWorktreeSetup } =
    use(TimelineRowActivityCtx);
  const compacting = row.compacting === true || isCompacting;
  const shimmer = isPreparingWorktree || compacting;
  const label = isPreparingWorktree ? (
    "Setting up worktree…"
  ) : compacting ? (
    <CompactingLabel createdAt={row.createdAt} />
  ) : row.createdAt ? (
    <>
      Working for <WorkingTimer createdAt={row.createdAt} />
    </>
  ) : (
    "Working..."
  );
  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <div className="flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed text-muted-foreground tabular-nums">
        <span
          ref={shimmer ? observeVisibleAnimation : undefined}
          className="relative shrink-0 overflow-hidden whitespace-nowrap"
        >
          {label}
          {shimmer ? <ActivityShimmerOverlay>{label}</ActivityShimmerOverlay> : null}
        </span>
        {backgroundWorktreeSetup ? (
          <BackgroundWorktreeSetupChip snapshot={backgroundWorktreeSetup} />
        ) : null}
      </div>
    </div>
  );
}
```
// ...

`apps/web/src/components/chat/TimelineWorkGroupRows.tsx:L612-L630`

```tsx
  return (
    <WorkLogButton
      aria-label={props.failed ? `${props.label}, tool call failed` : props.label}
      aria-expanded={props.expanded}
      onClick={props.onToggle}
      icon={
        <ToolActivityIconView
          icon={props.toolIcon}
          fallbackName={props.iconName}
          className="size-4 shrink-0 stroke-2 text-icon-muted"
          muted
        />
      }
      label={<span className="block truncate">{props.label}</span>}
      trailing={
        <TimelineRowTimestamp createdAt={props.createdAt} timestampFormat={props.timestampFormat} />
      }
    />
  );
```

##### Work log line primitive

`apps/web/src/components/chat/WorkLog.tsx:L53-L93`

```tsx
function WorkLogLine({ icon, label, trailing, wrapLabel }: RowContent) {
  return (
    <div
      className={cn(
        "flex min-h-6 min-w-0 gap-1.5 text-sm leading-relaxed select-none [&_*]:select-none",
        wrapLabel ? "items-start" : "items-center",
      )}
    >
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        {icon ? (
          <span className="relative w-6 shrink-0 leading-0">
            <span className="inline-block size-6 overflow-hidden align-[calc(0.5cap_-_0.75rem)]">
              <span className="flex size-full items-center justify-center">{icon}</span>
            </span>
          </span>
        ) : null}
        <div
          className={cn(
            "min-w-0 flex-1 text-secondary-label",
            !wrapLabel && "truncate [&_*]:whitespace-nowrap",
          )}
        >
          {label}
        </div>
      </div>
      {trailing}
    </div>
  );
}

const interactionClassName =
  "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

function useRowClassName(interactive: boolean) {
  const grouped = use(GroupedRows);
  return cn(
    "group/timeline-row relative w-full min-w-0 rounded-md px-0.5 text-left transition-colors",
    grouped ? "py-0" : "py-0.5",
    interactive && interactionClassName,
  );
}
```

##### Row router

`apps/web/src/components/chat/MessagesTimeline.tsx:L1429-L1497`

```tsx
  return (
    <div
      className={cn(
        isWorkLogRow || isSubagentGroup
          ? undefined
          : row.kind === "turn-fold" || row.kind === "working"
            ? "pb-1.5"
            : (row.kind === "message" &&
                  row.message.role === "assistant" &&
                  !row.showAssistantMeta) ||
                row.kind === "worktree-setup" ||
                row.kind === "event" ||
                row.kind === "attempt-fold" ||
                row.kind === "html-render" ||
                row.kind === "mcp-app"
              ? "pb-2"
              : "pb-4",
        (row.kind === "message" && row.message.role === "assistant") ||
          row.kind === "assistant-meta"
          ? "group/assistant"
          : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={
        row.kind === "message" || row.kind === "assistant-meta" ? row.message.id : undefined
      }
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {isWorkLogRow ? (
        <WorkLogBlock
          continues={row.continuesWorkLog}
          layout={
            isExpandedToolGroup
              ? "group-content"
              : isExpandedToolGroupHeader
                ? "group-header"
                : "standalone"
          }
        >
          {row.kind === "work" ? (
            <WorkGroupSection
              anchorKey={row.id}
              groupedEntries={row.groupedEntries}
              isExpandedToolGroup={row.isExpandedToolGroup}
              displayLabel={row.displayLabel}
            />
          ) : null}
          {row.kind === "work-live" ? <LiveWorkEntryTimelineRow row={row} /> : null}
          {row.kind === "work-toggle" ? <WorkGroupToggleTimelineRow row={row} /> : null}
          {row.kind === "thinking" ? <ThinkingTimelineRow row={row} /> : null}
        </WorkLogBlock>
      ) : null}
      {row.kind === "turn-fold" ? <TurnFoldTimelineRow key={row.id} row={row} /> : null}
      {row.kind === "attempt-fold" ? <AttemptFoldTimelineRow row={row} /> : null}
      {row.kind === "context-compaction" ? <ContextCompactionTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserMessageRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "assistant-meta" ? <AssistantMetaTimelineRow row={row} /> : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "html-render" ? <HtmlRenderTimelineRow row={row} /> : null}
      {row.kind === "mcp-app" ? <McpAppTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
      {row.kind === "worktree-setup" ? <WorktreeSetupTimelineRow row={row} /> : null}
      {row.kind === "event" ? <V2EventTimelineRow row={row} /> : null}
    </div>
  );
```

#### 1.12 Approvals (permission requests)

Pending approvals render inline in the work log (and also in the timeline footer for unmatched ones). Layout: request-kind icon (terminal / square-pen / eye / wrench / hammer), the command or detail as a scrollable `<code>` block (max-h-40), then a line: amber shield "Waiting for approval" · inline buttons. Default options: "Decline" and "Approve" as primary inline buttons (Approve uses default tone, Decline muted), "Cancel" and "Always allow this session" under a "More" menu. Options with a warning get a TriangleAlert icon and tooltip. No approve/decline keybinding was found (no "approv" match in `packages/contracts/src/keybindings.ts`, `useChatShortcuts.ts`, or `composerShortcuts.ts`); while an approval is pending the composer placeholder changes and sending a message declines the request and steers the agent. If the provider process died: "Provider process is gone. Interrupt or restart the run to respond."

`apps/web/src/components/chat/TimelinePendingApprovalRow.tsx:L15-L122`

```tsx
const APPROVAL_PRESENTATION = {
  command: { icon: "terminal", label: "Command approval", detailLabel: "Command" },
  "file-change": { icon: "square-pen", label: "File change approval", detailLabel: "File change" },
  "file-read": { icon: "eye", label: "File read approval", detailLabel: "File to read" },
  permission: {
    icon: "wrench",
    label: "App permission approval",
    detailLabel: "Permission request",
  },
  "mcp-elicitation": {
    icon: "hammer",
    label: "App access approval",
    detailLabel: "App access request",
  },
} satisfies Record<
  PendingApproval["requestKind"],
  { icon: WorkEntryIconName; label: string; detailLabel: string }
>;

export const TimelinePendingApprovalRow = memo(function TimelinePendingApprovalRow({
  approval,
}: {
  approval: PendingApproval;
}) {
  const { respondingRequestIds, canOperateThread, onRespondToApproval } = use(TimelineRowCtx);
  const presentation = APPROVAL_PRESENTATION[approval.requestKind];
  const canRespond = approval.responseCapability === "live";
  return (
    <WorkLogRow
      role="group"
      aria-label={presentation.label}
      data-v2-item-type="approval_request"
      wrapLabel
      icon={
        <ToolActivityIconView
          icon={undefined}
          fallbackName={presentation.icon}
          className="block size-4 shrink-0 stroke-2 text-icon-muted"
          muted
        />
      }
      label={
        <code
          aria-label={presentation.detailLabel}
          className="block max-h-40 min-w-0 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-foreground select-text! wrap-anywhere [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          data-approval-detail="complete"
          tabIndex={0}
        >
          {approval.detail || presentation.label}
        </code>
      }
    >
      <div className="ms-7.5 flex min-w-0 flex-col gap-1 pb-1 text-xs">
        {approval.appName ? (
          <span className="text-muted-foreground wrap-anywhere">{approval.appName}</span>
        ) : null}
        {approval.reason ? (
          <span className="text-muted-foreground select-text wrap-anywhere">{approval.reason}</span>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {canRespond ? (
            <>
              <span className="inline-flex items-center gap-1 text-warning">
                <ShieldIcon aria-hidden className="size-3 shrink-0" />
                Waiting for approval
              </span>
              {onRespondToApproval ? (
                <>
                  <span aria-hidden className="text-muted-foreground">
                    ·
                  </span>
                  <ComposerPendingApprovalActions
                    presentation="inline"
                    requestId={approval.requestId}
                    disabled={!canOperateThread}
                    isResponding={respondingRequestIds.includes(approval.requestId)}
                    canRespond={canRespond}
                    options={approval.options}
                    onRespondToApproval={onRespondToApproval}
                  />
                </>
              ) : null}
            </>
          ) : (
            <span className="text-warning">
              Provider process is gone. Interrupt or restart the run to respond.
            </span>
          )}
          {approval.fullAccessOverride ? (
            <Popover>
              <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
                {FULL_ACCESS_OVERRIDE_QUESTION}
              </PopoverTrigger>
              <PopoverPopup
                aria-label={FULL_ACCESS_OVERRIDE_QUESTION}
                tooltipStyle
                side="top"
                className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
              >
                {fullAccessOverrideExplanation(approval.fullAccessOverride)}
              </PopoverPopup>
            </Popover>
          ) : null}
        </div>
      </div>
    </WorkLogRow>
  );
});
```

`apps/web/src/components/chat/ComposerPendingApprovalActions.tsx:L26-L141`

```tsx
const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  presentation = "composer",
  requestId,
  isResponding,
  canRespond,
  disabled = false,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const primaryOptions = options.filter(
    (option) => option.decision === "decline" || option.decision === "accept",
  );
  const moreOptions = options.filter(
    (option) => option.decision !== "decline" && option.decision !== "accept",
  );

  return (
    <>
      {primaryOptions.map((option) => {
        const buttonProps = {
          disabled: disabled || isResponding || !canRespond,
          "aria-description": option.warning,
          onClick: () => {
            if (!disabled && !isResponding && canRespond) {
              void onRespondToApproval(requestId, option.decision);
            }
          },
        };
        const content = (
          <>
            {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
            <span className={presentation === "inline" ? "whitespace-normal" : "max-w-40 truncate"}>
              {option.label}
            </span>
          </>
        );
        const button =
          presentation === "inline" ? (
            <InlineButton
              key={option.decision}
              {...buttonProps}
              tone={option.decision === "accept" ? "default" : "muted"}
            >
              {content}
            </InlineButton>
          ) : (
            <Button
              key={option.decision}
              {...buttonProps}
              size="xs"
              variant={option.decision === "accept" ? "default" : "outline"}
            >
              {content}
            </Button>
          );
        return option.warning ? (
          <Tooltip key={option.decision}>
            <TooltipTrigger render={button} />
            <TooltipPopup side="top">{option.warning}</TooltipPopup>
          </Tooltip>
        ) : (
          button
        );
      })}
      {moreOptions.length > 0 ? (
        <Menu>
          <MenuTrigger
            disabled={disabled || isResponding || !canRespond}
            render={
              presentation === "inline" ? (
                <InlineButton tone="muted" aria-label="More approval options" />
              ) : (
                <Button size="icon-xs" variant="outline" aria-label="More approval options" />
              )
            }
          >
            {presentation === "inline" ? "More" : <EllipsisIcon />}
          </MenuTrigger>
          <MenuPopup {...composerFloatingLayerProps} side="top" align="end" width="content">
            {moreOptions.map((option) => {
              const item = (
                <MenuItem
                  key={option.decision}
                  disabled={disabled || isResponding || !canRespond}
                  aria-description={option.warning}
                  onClick={() => {
                    if (!disabled && !isResponding && canRespond)
                      void onRespondToApproval(requestId, option.decision);
                  }}
                >
                  {option.warning ? <TriangleAlertIcon className="size-3 text-warning" /> : null}
                  <span className="min-w-0 whitespace-normal wrap-break-word">{option.label}</span>
                </MenuItem>
              );
              return option.warning ? (
                <Tooltip key={option.decision}>
                  <TooltipTrigger render={item} />
                  <TooltipPopup side="top">{option.warning}</TooltipPopup>
                </Tooltip>
              ) : (
                item
              );
            })}
          </MenuPopup>
        </Menu>
      ) : null}
    </>
  );
});
```

`apps/web/src/components/chat/ChatComposer.tsx:L1151-L1158`

```tsx
  const isComposerApprovalState = activePendingApproval !== null;
  // A send declines the approvals shown here to redirect the agent, so it steers the waiting
  // turn instead of queueing behind it. Approvals the typing guard holds stay unseen and pending.
  const followUpBehavior = pendingApprovals.some(
    (approval) => !heldRequestIds.has(approval.requestId),
  )
    ? "steer"
    : settings.followUpBehavior;
```

`apps/web/src/components/chat/ChatComposer.tsx:L3363-L3378`

```tsx
                    placeholder={
                      isComposerApprovalState
                        ? activePendingApproval?.supportsFeedback
                          ? "Send feedback to decline this request"
                          : "Send a message to decline and redirect the agent"
                        : activePendingProgress
                          ? isChoiceOnlyPendingQuestion
                            ? "Choose an option above"
                            : "Type your own answer, or leave this blank to use the selected option"
                          : showPlanFollowUpPrompt && activeProposedPlan
                            ? "Add feedback to refine the plan, or leave this blank to implement it"
                            : projectSelectionRequired
                              ? "Choose a project above to start a thread"
                              : showProviderUnavailable
                                ? "Enable a provider in Settings to send a message"
                                : DEFAULT_COMPOSER_PLACEHOLDER
```

`components/permissions/*` is unrelated to agent approvals: it is an OS permission checklist ("Allow" buttons, "Allowed" status) polled every 1500ms.

`apps/web/src/components/permissions/PermissionChecklist.tsx:L14-L43`

```tsx
export function PermissionChecklist({
  permissions,
  busy = false,
}: {
  permissions: readonly PermissionItem[];
  busy?: boolean;
}) {
  return (
    <div className="space-y-2">
      {permissions.map((permission) => (
        <div key={permission.id} className="flex items-center gap-3 rounded-lg border px-3 py-2">
          {permission.icon}
          <div className="min-w-0 flex-1">
            <p className="font-medium">{permission.title}</p>
            <p className="text-xs text-muted-foreground">{permission.description}</p>
          </div>
          {permission.granted ? (
            <span role="status" className="flex items-center gap-1 text-xs text-success">
              <CircleCheckIcon className="size-4" aria-hidden="true" />
              Allowed
            </span>
          ) : (
            <Button size="xs" variant="outline" disabled={busy} onClick={permission.onAllow}>
              Allow
            </Button>
          )}
        </div>
      ))}
    </div>
  );
```

`apps/web/src/components/permissions/usePermissionStatus.ts:L6-L7`

```ts
const POLL_INTERVAL_MS = 1500;
const CHECK_FAILED_MESSAGE = "Could not check permissions. We'll try again automatically.";
```


## 10. User flows

All facts here come from `docs/research/t3code-notes/timeline-flows.md` sections 2.1-2.13, which carry verbatim quotes and line ranges.

**App shell.** The root route (`apps/web/src/routes/__root.tsx`) resolves an auth gate first. Unauthenticated users go to `/pair`. The authenticated tree is `ToastProvider > AnchoredToastProvider > FirstRunGate > CommandPalette > AppSidebarLayout > Outlet`, with dialog hosts mounted alongside. Router errors show a standalone "Something went wrong." page with Try again / Reload app / Copy error and an "Error report" block. Unknown routes show "Page not found".

**First launch.** `FirstRunGate` (`apps/web/src/onboarding/firstRun.ts`) shows the wizard only when onboarding isn't completed and the workspace is fresh. It only auto-opens from `/`, so deep links are never blocked.
- Stuck pending for 4s: "Still connecting / T3 Code could not confirm this workspace. / Reload".
- Settings fail to load: "Could not read settings / Your saved settings could not be loaded. / Retry".

`/welcome` puts a dialog titled "Set up T3 Code" over the empty-state hero, with a 3-step stepper:
1. **Connect your computers:** a checkbox list of environments (label, status, URL), an "Add a computer" pairing form (paste `https://your-server:5230/pair#token=…`; "Need a pairing link?" reveals `npx t3 pair`), a usage-data notice, and "Continue →".
2. **Connect your agents:** one card per agent (Codex, Claude Code) per computer, with state Ready / Checking... / Disabled / Install / Sign in. **Install and Sign in open an embedded terminal with the command prefilled** ("Review the command, then press Enter to run it.").
3. **Import your projects:** scans the computers for existing Claude Code and Codex projects. It shows "N of M selected" with Select all / Select none, then "Do not import projects" / "Import N projects". Loading: "Looking for projects from Claude Code and Codex…". Empty: "No existing Claude Code or Codex projects found." Error: "Could not check projects. {error}" + Retry.

Finishing persists `onboardingCompletedAt`, opens a new draft in the imported project, and toasts "Imported N threads".

**Home / empty states.**
- `/` auto-starts a draft thread in the most recently updated project and replaces the URL.
- No projects: `NoProjectsHero` with "What should we work on?" and "Add project" / "Start without a project".
- Draft start failure: "Couldn’t start a new thread".
- Hosted web with no computer: "No computer connected" plus numbered setup steps.
- No thread selected: "Pick a thread to continue".

**Adding a project.** "Add project" opens the command palette straight into an add-project submenu (`openCommandPalette({ open: "add-project" })`). Sources:
- **New project**: a name; creates a git repo.
- **Local folder**: type a path with directory autocomplete, placeholder "Enter project path (e.g. ~/projects/my-app)". Desktop also offers "Open in Finder" for the native picker.
- **Git URL**: "Enter Git clone URL".
- One entry per source-control provider ("GitHub repository"), disabled with a "Setup Required" pill until configured.

**Starting a thread.** New threads are client-side drafts at `/draft/$draftId`. The first send promotes the draft to `/$environmentId/$threadId`. Both routes render `null` and the `_chat` layout owns one `ChatView`, so promotion doesn't remount it and the composer keeps focus. Empty drafts are reused per project. The empty draft shows the hero "What should we build in {project}?" above the composer. A workspace select under the composer chooses "Current checkout" vs "New worktree", and it locks once the thread starts.

**Switching models mid-thread.** The picker stays live. If the server supports handoff, picking another provider inserts a "Context handoff" divider (`from → to`). Otherwise other providers are disabled with the tooltip "{name} is unavailable in this thread. Start a new thread to switch providers."

**ChatView layout.** A horizontal flex: chat column + optional right panel.
- Header: the 52px topbar, holding breadcrumb "project / [parent] / title" and panel toggles.
- Middle: banners, the timeline, the "Scroll to end" pill, and the composer floating over the bottom of the timeline.
- Bottom: the terminal drawer.

The right panel can maximize, collapsing the chat to `w-0`.

**Right panel (diff/review and more).** Tabbed "surfaces": Browser, Terminal, Files, Diff, Pull request, Linked PRs, Device.
- Resizable from its left edge: default 540px, min 360px, max 70% of the viewport, and the chat never drops below 360px.
- Width persisted per thread (`t3code:preview-panel-width:{threadKey}`).
- At `max-width: 980px` it becomes a right `Sheet` (`w-[min(42vw,28rem)] min-w-80`).
- Tabs are sortable, with Close / Close others / Close to the right / Close all.
- Empty state: an "Open a surface" launcher with single-letter `Kbd` hints (B, T, F, D, P, L, M).

**Terminal drawer.** Sits at the bottom of the chat column (`border-t`, `z-45`), resized from a 6px top handle: default 280px, min 180px, max 75% of the viewport. Up to 4 split terminals. Empty: "No terminal sessions for this thread yet.". Rendering uses libghostty-vt in wasm.

**Settings.** `/settings` redirects to `/settings/general`. Settings open as a large route modal over the current thread (`max-w-[80rem] max-h-[60rem] rounded-2xl`), and Esc returns to the opener.
- Layout: a left nav, then a content column with a 48px header (breadcrumb, close X) and a `max-w-4xl` scrolling page.
- Sections are a title plus a rounded bordered group of rows: title/description on the left, control on the right.
- Nav groups: [General, Appearance, Chat, Diffs & pull requests, Keybindings, SnapShots], Agents [Providers, Threads, Browser, Devices, Scheduled tasks], Code [Projects, Source control, Worktrees], Connections [Environments, Sharing & access], [Maintenance, Labs, About, Archive].

**Toasts.**
- Base UI toast: top-right, offset below the topbar, inset 16px (32px from `sm`), `max-w-90`.
- Stacking: collapsed toasts peek 12px and shrink 10% per level, and expand on hover. Motion is `transform .5s cubic-bezier(.22,1,.36,1)`, with swipe to dismiss.
- Surface: `dropdown-glass rounded-lg shadow-xl`, with a 24px round close orb at the corner.
- Types: error, info, success, warning, loading. Thread-scoped toasts only render while their thread is active.

**Connection lost.**
- `ConnectionStatusDot` is an 8px dot: green connected, amber with a ping while connecting, red on error.
- When the active thread's environment drops, a composer banner appears after a 2s grace period: WifiOff icon, "{label} is reconnecting" / "{label} is offline", a diagnosis line, and "Reconnect" / "Disconnect server".

## 11. Micro details worth copying

Sources: `docs/research/t3code-notes/shortcuts-icons-primitives.md` (Area 3) and `apps/web/src/index.css`.

- **Press feedback:** buttons use `active:scale-[0.97]`, skipped for `aria-haspopup` triggers so menus don't jiggle. Disabled is `opacity-64`, not 50.
- **Focus rings sit inside controls.** Global `outline-offset: -2px` (`index.css:L718-L722`). Buttons use `focus-visible:ring-2 ring-inset ring-ring ring-offset-1` (109 uses of `ring-inset`). Inputs use a softer 3px ring, `has-focus-visible:border-ring ring-[3px] ring-inset ring-ring/24`. Popups suppress their own outline.
- **Touch targets:** coarse pointers get an invisible 44px (`min-h-11 min-w-11`) hit area on buttons. Mobile-first sizes are one step bigger and `sm:` shrinks them, so the desktop is denser.
- **Tooltips:** Base UI, `side="top"`, `sideOffset=4`, `rounded-md text-xs border bg-popover shadow-md/5 px-2 py-1 max-w-80`. Enter/exit is `scale-98` + `opacity-0`. Sidebar lists drop the delay to 150ms with no close delay and a 400ms "warm" timeout, so moving between rows feels instant. Tooltips close on scroll.
- **Menus and popovers:** `dropdown-glass rounded-lg` with a soft shadow, `p-1`. Items are `min-h-8 sm:min-h-7 rounded-sm px-2 py-1 text-base sm:text-sm` with `data-highlighted:bg-accent`. Separator `mx-2 my-1 h-px bg-border`. Popovers animate width and height between views.
- **Dialogs:** `dialog-glass rounded-2xl border max-w-lg`, `duration-200 ease-in-out`, `scale-98` enter. The backdrop is a 60% tint plus a 4px blur. Nested dialogs push the parent back (scale -10%, up 1.25rem). On mobile they become bottom sheets. The footer is `border-t bg-muted/72 px-6 py-4`.
- **Scroll areas:** 6px scrollbars, hidden until hover or scroll, fading out after 300ms. An optional `scrollFade` masks the top and bottom 1.5rem only as far as content actually overflows. The sidebar content uses a 0.75rem fade with hidden scrollbars.
- **Sticky / chrome:** the 52px topbar has a scroll-fade mask (`topbar-scroll-fade`, `index.css:L469-L506`) so content dissolves under it instead of hard-cutting. The sidebar search row is a non-scrolling `fixedHeader`. The changed-files header is sticky.
- **Animation budget:** durations are mostly `duration-150` (31 uses) and `duration-200` (24), easing `ease-out`. The drawer curve is `cubic-bezier(0.32, 0.72, 0, 1)` and toasts use `cubic-bezier(.22,1,.36,1)`. Status pulses and skeletons use **stepped** keyframes (`steps(4)` / `steps(6)`) so the compositor paints a handful of frames per cycle instead of 120 (`index.css:L295-L361`). Spinners and shimmers pause when offscreen (`visible-animate-spin`, `--visible-animation-state`). Panel open/close animation is a setting that defaults to 0ms.
- **AnimatedHeight:** a ResizeObserver plus a 200ms `ease-out` height transition, clipping overflow only during the transition. Used for collapsible cards.
- **List motion:** sidebar rows reorder with a 150ms FLIP that travels at most 40px. Removed rows fade out as inert clones.
- **Undo instead of confirm:** settle, snooze, archive and discard are instant, with a 5s inline "⌘Z to undo" notice. Confirm dialogs for archive and delete are optional settings.
- **Live text, not spinners:** "Working 42s" in the sidebar, "Working for 1m 3s" in the timeline, shimmering tool labels. The whole UI tells you what the agent is doing right now.
- **Body grain:** a 3.5% SVG noise on the canvas (`index.css:L1763-L1780`) takes the flat digital look off the near-white zinc-25 and the pure black.

### Focus / duration counts (verbatim evidence)

#### 3.14 Focus rings, durations, easing (counts across `apps/web/src/components`)

Focus ring convention: inset 2px ring in `--ring` color with 1px offset in background color. Counts: `focus-visible:ring-inset` 109, `focus-visible:ring-2` 97, `focus-visible:ring-ring` 83, `focus-visible:ring-offset-background` 23, `focus-visible:ring-offset-1` 21, `focus-visible:ring-ring/70` 14, `focus-visible:ring-1` 7, `focus-visible:ring-offset-2` 4, `focus-visible:ring-[3px]` 4. Inputs use the 3px `ring-ring/24` variant instead.

Durations: `duration-150` 31, `duration-200` 24, `duration-100` 6, `duration-180` 4, `duration-2000` 3, `duration-500` 2, `duration-300` 2. Easing classes: `ease-out` 39, `ease-in-out` 3, `ease-linear` 1. Literal curves in `apps/web/src`: `cubic-bezier(0.32, 0.72, 0, 1)` 3 (drawer/composer motion), `cubic-bezier(0.4, 0, 0.2, 1)` 2, `cubic-bezier(.22,1,.36,1)` 1 (toasts).

Typical hover/press: color transitions `transition-colors duration-150`; buttons `transition-[box-shadow,scale]` with `active:scale-[0.97]`; send button `hover:scale-105`; popups `scale-98`+fade in/out.

`apps/web/src/components/BranchToolbar.tsx:L439-L439`
```ts
const COMPOSER_CONTEXT_MOTION_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
```

`apps/web/src/components/chat/useComposerRestingTransition.ts:L6-L6`
```ts
const COMPOSER_RESTING_TRANSITION_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
```

---


## 12. Mapping to our screens

Our screens come from `docs/spec.md` sections 3 and 4. Nav: Team / Project / Workforce / Activity / Settings. The screens are the task composer, mission control, the workforce list, the recovery view, and first-run setup. Below, each t3code pattern maps to a concrete call for our build. "Copy" means rebuild faithfully. "Adapt" means keep the mechanics and change the content.

### 12.1 App shell and sidebar of projects/tasks

- **Copy the shell:** a left sidebar plus a main column under a 52px topbar (`--workspace-topbar-height`), with the optional right panel and bottom drawer as siblings. Port `ui/sidebar.tsx` mechanics: offcanvas collapse on `mod+b`, `sidebar_state` cookie, resizable rail at 256 default / 208 min / keep 640px for main, localStorage width key, double-click reset, Sheet below 768px.
- **Adapt the structure.** Our unit is a *task* (spec: "Task: a user objective with acceptance criteria"), not a chat thread. Use t3code's inbox model, because a multiplayer team cares about "what needs me" more than folder hierarchy:
  - **Needs you** at the top, the equivalent of t3code's Approval / Input status. Tasks waiting on a human approval, acceptance check, or a worker question.
  - **Running**, like the Working shelf, with the live elapsed timer per row.
  - **Recovering**, new for us. Tasks in the recovery flow (spec section 3, "Interruption and recovery"), in warning color.
  - **Done**, like Settled. Paged, 10 then +25.
  - **Projects** are the header filter combobox ("All projects" plus a favicon per project), exactly like t3code. That also covers the spec's Team / Project nav without a second tree. Keep the "boring sidebar" folder mode as a later option only if users ask.
- **Task row (card variant):**
  - line 1: project favicon + project name + status slot
  - line 2: task title
  - line 3: branch, PR badge, and a **stacked harness icon row** (one icon per active worker: Claude Code, Codex...). Reuse t3code's `ProviderInstanceIcon` stack pattern.
  - Status precedence: Needs approval > Worker question > Recovering > Running (timer) > Failed > Done (unread until visited).
  - No unread dot. "Done" after last visit *is* the unread signal.
- **Hover actions:** snooze and settle, as in t3code. Rename, archive and delete go in the context menu. Undo toast instead of confirm. Multiplayer twist: show the owner avatar in the hover card, since the hover card is where t3code puts environment/provider/branch detail.
- **Footer:** Settings, Activity (instead of Usage), Workforce. Add a **team avatar stack** here; t3code has no account block, but we're multiplayer and need presence.
- **Keyboard:** port the ARIA tree navigation and `mod+shift+[` / `]`, `mod+1..9` with hold-⌘ hints. In a browser `mod+1..9` collides with tab switching, which is why t3code gates it to desktop. Gate it the same way, or bind `alt+1..9` on web.
- **Favicons:** port the full `ProjectFavicon` + `ProjectMonogram` + `projectIdentity` hash. Our repos live on Freestyle VMs or GitHub, not a local disk, so the resolver runs **server-side against the VM checkout or the GitHub contents API** using the same 23 candidate paths and `<link rel="icon">` parse. Keep the `realpath` containment check if we read from VM disk, and cache with the same 10 min / 1 min TTLs. Never fetch arbitrary URLs from a project's HTML `href`: resolve them as repo-relative paths only (SSRF guard, same as t3code).
- **Unread favicon badge:** copy the 64px canvas badge (`#e5484d`, `9+`) for "N tasks need you". High value for a tab that sits in the background.

### 12.2 Task composer

- **Copy the composer card wholesale:** glass `rounded-2xl` shell, `shadow-composer`, Tiptap editor (2 lines → `max-h-52`), 46rem centered lane, Enter sends, Shift+Enter newline, IME guard, draft persistence per task in localStorage (`composer-drafts`-style store, 300ms debounce, flush on `beforeunload`), and the placeholder pattern. Ours: "Describe the task. @ files, / commands".
- **Footer controls become the workforce controls**, all as borderless inline text buttons that read as one phrase, the same way t3code reads "Opus 5.5 High":
  - Workforce mode: **Auto / Manual**, in the slot of t3code's Plan/Build toggle.
  - **Max parallel agents** (1-3 default per spec), in the slot of the effort picker (a muted number or bar glyph).
  - Harness/model picker: reuse the model picker popover (provider rail, favorites, search, ⌘1..9) but list *available CLIProfiles* grouped by VM, with Ready / Cooldown / Auth-needed badges in place of "New" / "Unavailable".
  - Budget: an optional chip, hidden until set, like t3code hides the permissions chip when it matches the default.
- **Context strip under the card** (t3code's `BranchToolbar`): repo, branch, and "New worktree vs current" map directly to the spec's "Git branch/repo".
- **Acceptance criteria:** don't cram them into the editor. Use a collapsible attached banner above the card (t3code's `ComposerBannerStack` / pending-question card pattern) holding a checklist. Tiptap task lists also work inline.
- **Planner explanation before Start** maps to t3code's proposed-plan flow. The planner returns a plan card (`rounded-2xl border border-border/80 bg-card/70`) listing workstreams and *why each worker was chosen*. The composer's send button becomes a split **"Start"** with "Start with fewer agents" in the chevron menu, mirroring "Implement" / "Implement in a new thread". Typing feedback turns the button into "Refine", like t3code.
- **Slash commands:** `/workers`, `/budget`, `/plan` built-ins; `@` for files from the repo; `#` for PRs. Same single menu component.

### 12.3 Mission control

The spec layout: left agent topology, center Agent Relay live messages with channel/DM/thread filters, right branch/test/preview panel, bottom task timeline and decision trace.

- **Center (Relay messages) uses the t3code timeline.** LegendList virtualization, stick-to-bottom with the "Scroll to end" glass pill, and centered 46rem lane (switch to "wide" 72rem here, since mission control is dense). Agent messages render like t3code assistant rows (no bubble, hover meta), each prefixed with the worker's harness icon and name. Human messages render as the right-aligned `bg-message` bubble. Inter-agent DMs render as the t3code divider/pill style so they read as system traffic, not chat.
- **Work log grouping:** reuse the "Read 3 files and ran 2 commands" collapse per worker turn. Without it, multi-agent noise drowns the screen.
- **Approvals and verification gates:** copy t3code's inline approval row (shield, "Waiting for approval", Approve/Decline + More menu) and route every human gate here. Steer-on-send also maps directly: typing to a running worker steers it, and ⌘/Ctrl queues.
- **Right panel uses the t3code right-panel surfaces:** tabs for Branch/Diff, Tests, Preview, Terminal. Resizable 540 default / 360 min / 70% max, width persisted per task, Sheet under 980px. The terminal tab is permission-gated per spec, so show a locked state instead of hiding the tab.
- **Left topology:** t3code has no equivalent, so build it new but borrow the row vocabulary. Each worker node is a slim row: harness icon, worker name, VM, status slot (Working timer / Waiting / Cooldown / Failed). Clicking opens its terminal in the right panel, the way t3code opens diffs in the right panel instead of inline.
- **Bottom timeline and decision trace:** use the terminal drawer mechanics (6px resize handle, 280 default / 180 min / 75% max) and t3code's centered hairline dividers for events ("Worker claude@vm-2 hit usage limit", "Handoff → codex@vm-1", "Checkpoint abc123").
- **Status dot:** reuse `ConnectionStatusDot` (green / amber with ping / red) for relay node health.

### 12.4 Workforce list

- Per VM: a settings-style section (title plus a rounded bordered group of rows, `max-w-4xl`, the same layout as t3code Settings). Each **CLI card** is a row: harness icon (`size-5`), provider/account, auth status, running sessions, cooldown timer, permitted scopes. Actions on the right: "Open private terminal", "Pause VM if idle", "Disconnect". Destructive actions go in an ellipsis menu with the destructive variant.
- Keep **VM power status visually separate from CLI account status**, as the spec requires. Use a status dot for VM power and a text badge per CLI. Never show a token balance; follow t3code's "Limited" / "Usage limit reached. Retry after {time}." copy, which only states what the CLI exposes.

### 12.5 First-run setup

t3code's 3-step "Set up T3 Code" wizard (Connect computers → Connect agents → Import projects) is almost exactly our spec section 3 "First-run setup". Copy the stepper dialog over the empty hero:
1. **Team + repo:** create/join team, connect GitHub repo (t3code's palette add-project with the "GitHub repository" source and "Setup Required" pill).
2. **Add my coding environment:** provision a Freestyle VM in place of t3code's pairing form, with "Checking..." / "Ready" states.
3. **Connect agents:** one card per CLI with Ready / Checking... / Install / Sign in. **Sign in opens an embedded terminal with the login command prefilled** ("Review the command, then press Enter to run it."). That's exactly our PTY login flow. Health checks drive the Ready state per CLIProfile.

Keep t3code's guards: the wizard never blocks deep links, and it shows "Still connecting… Reload" after 4s instead of spinning forever.

### 12.6 Recovery view

There's no t3code screen for this, but the pieces exist. Render the failure → checkpoint → replacement → ACK → verification chain as t3code lifecycle dividers plus work-log rows in the mission control timeline, and as a "Recovering" status in the sidebar. Use the thread error banner (dismissible glass `Alert`) for the active failure, with the reason and "View handoff" as its action.

### 12.7 Implementation notes for Next.js 16

- t3code is a Vite SPA on TanStack Router. Our App Router equivalent of its draft → thread promotion trick (one `ChatView` mounted in the `_chat` layout, child routes render `null`) is a **shared `layout.tsx` that owns the composer and timeline**, with `/tasks/new` and `/tasks/[id]` pages rendering nothing heavy. The composer then survives the URL change from draft to task without losing focus.
- Every interactive piece (composer, sidebar, menus) is a client component. Base UI (`@base-ui/react`), Tiptap, zustand, dnd-kit, `@legendapp/list`, lucide-react, cva and tailwind-merge all work in Next.js client components. Install with `bun add`.
- Shortcuts: port the small custom engine (`packages/shared/src/keybindings.ts` + `apps/web/src/shortcuts/dispatcher.ts`) instead of pulling in a hotkey library. It's what gives us `when` clauses, so the same chord can do different things by focus.
- License: MIT (see section 1). Keep a third-party notices entry for anything copied, and don't ship T3 branding.

## 13. Known gaps (what this research did not verify)

- **Library defaults:** tooltip open delay 600ms and toast timeout 5000ms / limit 3 are Base UI defaults taken from Base UI docs. The repo doesn't set them, and with no `node_modules` the installed version couldn't be checked. t3code does set explicit delays in places (sidebar `delay={150}`, appearance toast `timeout: 1500`).
- **Untraced handlers:** about 15 shortcut commands are listed with their settings label only (`navigation.back/forward`, `rightPanel.new/close`, `composer.stash/host/effort/mode/workspace/branch/previousWorktree`, `pullRequest.copyNumber`, `thread.settle/pin/undo`).
- **Summarized, not fully quoted:** the model picker's provider rail (`ModelPickerSidebar.tsx`), stash toast copy (`useComposerStash.ts`), and the branch-changed banner (`ThreadActivityBanners.tsx`).
- **Composer file drops** are handled by the whole chat pane (`ChatView`), not the composer itself.
- **Settings:** only the nav and layout are documented, not each settings page's contents.
- **Assets:** binary icon files in `apps/web/public` and the ~600-line inline theme boot script in `apps/web/index.html` are described, not reproduced.
- **Things that don't exist** (checked, not overlooked): no approval keyboard shortcuts, no Escape-to-interrupt, no streaming caret, no hover archive/delete on sidebar rows, no user/account block in the sidebar footer, no icon-rail collapsed sidebar, and favicon discovery never reads `package.json`.

Full evidence for every section is in `docs/research/t3code-notes/`: `composer.md`, `sidebar-favicons.md`, `shortcuts-icons-primitives.md`, `timeline-flows.md`.
