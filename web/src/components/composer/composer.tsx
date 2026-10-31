"use client";

import {
  COMPARE_HARNESSES,
  TASK_PROMPT_MAX,
  type CliKind,
  type EnvironmentView,
  type MemberView,
  type ProfileView,
  type ProjectView,
  type TaskStrategy,
  type WorkforceMode,
} from "@morrow/contracts";
import { ListChecks, WifiOff } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { canReplan, fewerAgents, primaryAction, refinedPrompt } from "@/components/plan/plan-flow";
import type { PlacementResult } from "@/components/plan/placement";
import type { TaskFlow } from "@/components/plan/use-task-flow";
import type { ConnectionStatus } from "@/lib/realtime";
import { useComposerFocusRequest } from "@/components/shell/composer-focus";
import { cn } from "@/lib/cn";
import { AttachedBanner } from "./attached-banner";
import { ComposerControl, ControlSeparator } from "./composer-control";
import { ComposerError } from "./composer-error";
import { composerKeyIntent } from "./composer-keys";
import { ContextStrip } from "./context-strip";
import { PoolMeter } from "@/components/pool/pool-meter";
import { CriteriaBanner } from "./criteria-banner";
import type { Draft } from "./drafts";
import type { DraftUpdate } from "./use-draft";
import { PrimaryActionButton } from "./primary-action";
import { ProfilePicker } from "./profile-picker";
import { detectSlashTrigger, filterSlashCommands, removeTrigger, SLASH_COMMANDS, type SlashCommand, type SlashTrigger } from "./slash-commands";
import { SLASH_LIST_ID, SlashMenu, slashOptionId } from "./slash-menu";
import { compareMax, HarnessControl, ModeControl, StrategyControl } from "./workforce-controls";
import styles from "./composer.module.css";

export const COMPOSER_PLACEHOLDER = "Describe the task. / for commands";

export type WorkforceSettings = {
  mode: WorkforceMode;
  pins: string[];
  /** Split across workstreams, or Compare: each harness attempts the whole task. */
  strategy: TaskStrategy;
  /** Compare only: the harnesses that each attempt it. */
  harnesses: CliKind[];
};

type ComposerProps = {
  projects: readonly ProjectView[];
  projectId: string | null;
  onProjectChange: (projectId: string) => void;
  /** Set when the viewer may link repos: the project menu offers "Link a repo". */
  linkRepos?: { teamId: string };
  profiles: readonly ProfileView[];
  environments: readonly EnvironmentView[];
  members: readonly MemberView[];
  /** Team policy cap for agents per task: every compare attempt runs at once, so it bounds the harnesses. */
  maxAgentsCap: number;
  settings: WorkforceSettings;
  onSettingsChange: (settings: WorkforceSettings) => void;
  flow: TaskFlow;
  placement: PlacementResult | null;
  connection: ConnectionStatus;
  /** The saved draft for this team + project (see use-draft.ts). */
  draft: Draft;
  onDraftChange: DraftUpdate;
};

/** Offline banners wait this long so a quick reconnect never flashes one (t3code's grace). */
const CONNECTION_GRACE_MS = 2_000;

function useGracefulOffline(connection: ConnectionStatus) {
  const [shown, setShown] = useState(false);
  const down = connection === "offline" || connection === "reconnecting";
  useEffect(() => {
    if (!down) return;
    const timer = setTimeout(() => setShown(true), CONNECTION_GRACE_MS);
    return () => {
      clearTimeout(timer);
      setShown(false);
    };
  }, [down]);
  return shown && down;
}

export function Composer(props: ComposerProps) {
  const { projects, projectId, settings, onSettingsChange, flow, placement } = props;
  const { draft, onDraftChange: setDraft } = props;
  const { text, criteria } = draft;
  const editor = useRef<HTMLTextAreaElement>(null);

  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const [criteriaExpanded, setCriteriaExpanded] = useState(true);
  const [criteriaFocus, setCriteriaFocus] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const offline = useGracefulOffline(props.connection);

  const { phase, busy, task } = flow;
  const action = primaryAction(phase, text.trim().length > 0);
  const composing = phase.kind !== "planning" && phase.kind !== "planned";
  const showCriteria = composing && (criteriaOpen || criteria.length > 0);

  // ---------- slash menu ----------
  const trigger: SlashTrigger | null = useMemo(() => {
    const found = detectSlashTrigger(text, caret);
    return found && found.start !== dismissedAt ? found : null;
  }, [text, caret, dismissedAt]);
  const commands = useMemo(() => (trigger ? filterSlashCommands(SLASH_COMMANDS, trigger.query) : []), [trigger]);
  const menuOpen = trigger !== null;
  const activeIndex = commands.length ? Math.min(menuIndex, commands.length - 1) : 0;

  const syncCaret = () => setCaret(editor.current?.selectionStart ?? 0);

  // ---------- autosize (field-sizing: content where supported) ----------
  useLayoutEffect(() => {
    const el = editor.current;
    if (!el || CSS.supports("field-sizing", "content")) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // ---------- focus requests from the shell (New task, mod+shift+o, the palette) ----------
  useComposerFocusRequest(() => {
    const el = editor.current;
    if (!el || el.disabled) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });

  // ---------- why the primary button cannot run ----------
  const trimmed = text.trim();
  const compare = settings.strategy === "compare";
  let disabledReason: string | null = null;
  if (action === "send") {
    if (projects.length === 0) disabledReason = "Link a repository first";
    else if (!projectId) disabledReason = "Choose a project";
    else if (!trimmed) disabledReason = "Describe the task first";
    else if (text.length > TASK_PROMPT_MAX) disabledReason = `Keep it under ${TASK_PROMPT_MAX.toLocaleString("en-US")} characters`;
    else if (settings.mode === "manual" && settings.pins.length === 0) disabledReason = "Pick at least one profile for Manual";
    else if (compare && compareMax(props.maxAgentsCap) < COMPARE_HARNESSES.min)
      disabledReason = `This team runs ${props.maxAgentsCap} agent per task. Compare needs ${COMPARE_HARNESSES.min}`;
    else if (compare && settings.harnesses.length < COMPARE_HARNESSES.min) disabledReason = `Pick at least ${COMPARE_HARNESSES.min} harnesses to compare`;
    else if (compare && settings.harnesses.length > compareMax(props.maxAgentsCap))
      disabledReason = `This team runs at most ${props.maxAgentsCap} agents per task`;
  } else if (action === "start") {
    disabledReason = placement?.blocked ?? (placement ? null : flow.detail.current ? "Waiting for the workforce" : "Loading the plan");
  } else if (action === "refine") {
    const prompt = flow.detail.data?.prompt;
    if (prompt === undefined) disabledReason = "Loading the plan";
    else if (!refinedPrompt(prompt, text)) disabledReason = "The task plus your feedback is over 8,000 characters";
  }

  /** Creates the task; `submitted` is the editor text it came from, cleared once it lands. */
  const send = async (prompt: string, submitted: string) => {
    if (!projectId || !prompt) return;
    const ok = await flow.create({
      projectId,
      prompt,
      acceptance: criteria.map((c) => c.trim()).filter(Boolean),
      mode: settings.mode,
      pins: settings.pins,
      strategy: settings.strategy,
      harnesses: compare ? settings.harnesses : [],
    });
    if (!ok) return;
    setCriteriaOpen(false);
    // Keep anything typed while the request was in flight.
    setDraft((current) => ({ text: current.text === submitted ? "" : current.text, criteria: [] }));
  };

  const refine = async () => {
    if (!task) return;
    const submitted = text;
    // A refined compare keeps its harnesses: the new task is the same compare with the feedback added.
    const harnesses = task.strategy === "compare" ? task.workstreams.flatMap((w) => (w.harness ? [w.harness] : [])) : [];
    const ok = await flow.refine(text, { mode: settings.mode, pins: settings.pins, strategy: task.strategy ?? "split", harnesses });
    if (ok) setDraft((current) => ({ ...current, text: current.text === submitted ? "" : current.text }));
  };

  const runPrimary = () => {
    if (busy || disabledReason) return;
    if (action === "send") void send(trimmed, text);
    else if (action === "start") void flow.start(placement?.picks ?? null, { mode: settings.mode, pins: settings.pins });
    else if (action === "refine") void refine();
  };

  const runCommand = (command: SlashCommand) => {
    if (!trigger) return;
    const next = removeTrigger(text, trigger);
    setDraft({ ...draft, text: next.text });
    setMenuIndex(0);
    requestAnimationFrame(() => {
      editor.current?.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
    if (command.id === "workers") setPickerOpen(true);
    else if (command.id === "criteria") {
      if (!composing) return;
      setCriteriaOpen(true);
      setCriteriaFocus((n) => n + 1);
    } else if (command.id === "plan") {
      if (phase.kind === "planned" && task) {
        if (canReplan(task)) void flow.replan({ pins: settings.pins, mode: settings.mode });
      }
      // Plan straight away with the text minus the command.
      else if (action === "send" && !disabledReason) void send(next.text.trim(), next.text);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const intent = composerKeyIntent(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.keyCode,
        repeat: event.repeat,
      },
      { menuOpen },
    );
    if (!intent) return;
    event.preventDefault();
    if (intent === "menu-next") setMenuIndex((activeIndex + 1) % Math.max(1, commands.length));
    else if (intent === "menu-prev") setMenuIndex((activeIndex - 1 + commands.length) % Math.max(1, commands.length));
    else if (intent === "menu-close") setDismissedAt(trigger?.start ?? null);
    else if (intent === "menu-select") {
      const command = commands[activeIndex];
      if (command) runCommand(command);
      else setDismissedAt(trigger?.start ?? null);
    } else if (intent === "submit") runPrimary();
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft({ ...draft, text: event.target.value });
    setCaret(event.target.selectionStart ?? 0);
    setMenuIndex(0);
    if (dismissedAt !== null) setDismissedAt(null);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    runPrimary();
  };

  const placeholder =
    phase.kind === "planned"
      ? "Add feedback to refine the plan, or press Enter to start"
      : phase.kind === "planning"
        ? "Type feedback for the plan while it's being made"
        : projects.length === 0
          ? "Link a repository to start a task"
          : COMPOSER_PLACEHOLDER;

  const planLocked = phase.kind === "planning" || phase.kind === "planned";
  // A shown plan fixes the strategy and harnesses: the footer says what it is running with.
  const shownStrategy: TaskStrategy = planLocked && task ? (task.strategy ?? "split") : settings.strategy;
  const shownHarnesses: CliKind[] =
    planLocked && task ? task.workstreams.flatMap((w) => (w.harness ? [w.harness] : [])) : settings.harnesses;
  const count = text.length;
  const failure = flow.failure;

  return (
    <div className="relative mx-auto w-full max-w-(--chat-content-max-width)">
      <form onSubmit={onSubmit} aria-label="New task" className="relative">
        {menuOpen ? (
          <SlashMenu commands={commands} active={activeIndex} onHover={setMenuIndex} onPick={runCommand} />
        ) : null}

        {offline ? (
          <AttachedBanner variant="warning" role="status">
            <p className="flex items-center gap-2 pb-1.5 text-label-secondary">
              <WifiOff className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
              Reconnecting. Your draft is saved; plans show up when the live view is back.
            </p>
          </AttachedBanner>
        ) : null}
        {failure ? <ComposerError failure={failure} onDismiss={flow.clearFailure} /> : null}
        {showCriteria ? (
          <CriteriaBanner
            criteria={criteria}
            onChange={(next) => setDraft({ ...draft, criteria: next })}
            expanded={criteriaExpanded}
            onExpandedChange={setCriteriaExpanded}
            focusRequest={criteriaFocus}
            disabled={busy === "create"}
          />
        ) : null}

        <div className={styles.card}>
          <div className="relative px-4 pt-3.5 pb-2 sm:pt-4">
            <textarea
              ref={editor}
              value={text}
              onChange={onChange}
              onKeyDown={onKeyDown}
              onSelect={syncCaret}
              onClick={syncCaret}
              onBlur={() => setDismissedAt(trigger?.start ?? null)}
              onFocus={() => setDismissedAt(null)}
              rows={2}
              placeholder={placeholder}
              aria-label="Task description"
              aria-describedby={count > TASK_PROMPT_MAX - 1000 ? "composer-count" : undefined}
              aria-autocomplete={menuOpen ? "list" : undefined}
              aria-controls={menuOpen ? SLASH_LIST_ID : undefined}
              aria-expanded={menuOpen}
              aria-activedescendant={menuOpen && commands[activeIndex] ? slashOptionId(commands[activeIndex].id) : undefined}
              role="combobox"
              spellCheck
              className={cn(
                "-m-1 block max-h-52 min-h-[calc(2lh+0.5rem)] w-[calc(100%+0.5rem)] resize-none overflow-y-auto bg-transparent p-1",
                "text-[16px] leading-relaxed whitespace-pre-wrap text-text outline-none [field-sizing:content] placeholder:text-faint sm:text-[15px]",
              )}
            />
          </div>

          <div className="flex min-w-0 flex-nowrap items-center gap-1 px-2 pb-2">
            <div className="flex min-w-0 flex-1 items-center overflow-x-auto no-scrollbar">
              <StrategyControl
                strategy={shownStrategy}
                onStrategyChange={(strategy) => onSettingsChange({ ...settings, strategy })}
                disabled={planLocked}
              />
              <ControlSeparator />
              <ModeControl mode={settings.mode} onModeChange={(mode) => onSettingsChange({ ...settings, mode })} />
              <ControlSeparator />
              {/* A split has no agent count to pick: the planner sizes it to the work and the team's free slots. */}
              {shownStrategy === "compare" ? (
                <>
                  <HarnessControl
                    harnesses={shownHarnesses}
                    onHarnessesChange={(harnesses) => onSettingsChange({ ...settings, harnesses })}
                    profiles={props.profiles}
                    environments={props.environments}
                    projectId={projectId}
                    cap={props.maxAgentsCap}
                    disabled={planLocked}
                  />
                  <ControlSeparator />
                </>
              ) : null}
              <ProfilePicker
                profiles={props.profiles}
                environments={props.environments}
                members={props.members}
                projectId={projectId}
                pins={settings.pins}
                onPinsChange={(pins) => onSettingsChange({ ...settings, pins })}
                open={pickerOpen}
                onOpenChange={setPickerOpen}
              />
              {composing ? (
                <ComposerControl
                  aria-label="Acceptance criteria"
                  aria-pressed={showCriteria}
                  onClick={() => {
                    if (showCriteria && criteria.every((c) => !c.trim())) {
                      setCriteriaOpen(false);
                      setDraft({ ...draft, criteria: [] });
                    } else {
                      setCriteriaOpen(true);
                      setCriteriaFocus((n) => n + 1);
                    }
                  }}
                  className="ml-1"
                >
                  <ListChecks aria-hidden="true" />
                  <span className="max-sm:hidden">Criteria</span>
                </ComposerControl>
              ) : null}
            </div>
            {count > TASK_PROMPT_MAX - 1000 ? (
              <span
                id="composer-count"
                className={cn("shrink-0 px-1 text-[12px] tabular-nums", count > TASK_PROMPT_MAX ? "text-danger" : "text-faint")}
              >
                {count.toLocaleString("en-US")} / {TASK_PROMPT_MAX.toLocaleString("en-US")}
              </span>
            ) : null}
            <PrimaryActionButton
              action={action}
              disabledReason={disabledReason}
              busy={busy !== null && busy !== "cancel"}
              fewerAgents={task ? fewerAgents(task) : null}
              onStartFewer={() => {
                const n = task ? fewerAgents(task) : null;
                if (n) void flow.replan({ maxAgents: n, pins: settings.pins, mode: settings.mode, autoStart: true });
              }}
              onReplan={task && !canReplan(task) ? null : () => task && void flow.replan({ pins: settings.pins, mode: settings.mode })}
            />
          </div>
        </div>
      </form>

      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <ContextStrip projects={projects} projectId={projectId} onProjectChange={props.onProjectChange} locked={planLocked} link={props.linkRepos} />
        </div>
        <div className="shrink-0 px-2 pt-1.5">
          <PoolMeter variant="composer" />
        </div>
      </div>
    </div>
  );
}
