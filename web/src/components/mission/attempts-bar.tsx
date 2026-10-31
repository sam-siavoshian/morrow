"use client";

import type { CliKind, MemberView, TaskDetail, TaskView, WorkforceView, WorkstreamStatus } from "@morrow/contracts";
import { GitBranch, Trophy } from "lucide-react";
import { useState } from "react";
import { HarnessIcon, HARNESS_LABEL } from "@/components/harness/harness-icon";
import { Button } from "@/components/ui/button";
import { DialogContent, DialogRoot } from "@/components/ui/dialog";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { ElapsedTime } from "@/components/ui/timer";
import { toast } from "@/components/ui/toast";
import { errorMessage, pickAttempt } from "@/lib/api";
import { cn } from "@/lib/cn";

// A compare task (docs/multi-harness.md) shows its attempts side by side above the timeline: which harness, whose
// subscription, how far along, what it said when it finished. Once one is done, the creator or an admin picks the
// attempt to ship, or finishes the task without shipping (a review whose findings are the result).

export type AttemptCard = {
  workstreamId: string;
  cli: CliKind | null;
  branch: string;
  status: WorkstreamStatus;
  /** "ada's machine", from the live lease's profile; null before a worker is placed. */
  owner: string | null;
  /** When the current worker started, for the elapsed timer. Null when no worker is live. */
  since: number | null;
  /** The finishing summary the attempt posted, as plain text. Null until it finishes. */
  summary: string | null;
  picked: boolean;
};

const STATUS: Record<WorkstreamStatus, { label: string; tone: StatusTone; pulse?: boolean }> = {
  pending: { label: "Waiting for a worker", tone: "idle" },
  active: { label: "Working", tone: "live", pulse: true },
  handoff: { label: "Moving to another profile", tone: "attention" },
  done: { label: "Finished", tone: "success" },
  failed: { label: "Stopped", tone: "neutral" },
};

/** One card per compare attempt, in plan order; the conflict resolver is not an attempt. */
export function attemptCards(
  task: Pick<TaskView, "workstreams" | "pickedWorkstreamId">,
  detail: Pick<TaskDetail, "workstreams"> | null,
  workforce: Pick<WorkforceView, "leases" | "profiles">,
  members: readonly Pick<MemberView, "userId" | "login">[],
): AttemptCard[] {
  return task.workstreams
    .filter((ws) => ws.harness)
    .map((ws) => {
      const lease = ws.leaseId ? workforce.leases[ws.leaseId] : undefined;
      const profile = lease ? workforce.profiles[lease.profileId] : undefined;
      const login = profile ? members.find((m) => m.userId === profile.ownerUserId)?.login : undefined;
      const live = lease && (lease.state === "reserved" || lease.state === "spawning" || lease.state === "running");
      const full = detail?.workstreams.find((w) => w.id === ws.id);
      return {
        workstreamId: ws.id,
        cli: ws.harness ?? null,
        branch: ws.branch,
        status: ws.status,
        owner: login ? `${login}'s machine` : null,
        since: live ? lease.createdAt : null,
        summary: ws.status === "done" ? (full?.lastCheckpoint?.summary.trim() || null) : null,
        picked: task.pickedWorkstreamId === ws.id,
      };
    });
}

type Confirm = { kind: "pick"; card: AttemptCard } | { kind: "finish" };

export function AttemptsBar({
  teamId,
  task,
  detail,
  workforce,
  members,
  canPick,
  onViewChanges,
}: {
  teamId: string;
  task: TaskView;
  detail: TaskDetail | null;
  workforce: WorkforceView;
  members: readonly MemberView[];
  /** The viewer created the task or is an owner or admin (the backend checks again). */
  canPick: boolean;
  /** Opens the branch's changes in the side panel. */
  onViewChanges: (branch: string) => void;
}) {
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const cards = attemptCards(task, detail, workforce, members);
  if (cards.length === 0) return null;

  const decided = task.pickedWorkstreamId !== undefined && task.pickedWorkstreamId !== null;
  const ended = task.status === "completed" || task.status === "failed" || task.status === "cancelled";
  const open = canPick && !decided && !ended;
  const anyDone = cards.some((c) => c.status === "done");

  const run = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      await pickAttempt(teamId, task.id, confirm.kind === "pick" ? confirm.card.workstreamId : null);
      toast(
        confirm.kind === "pick" ? `Shipping the ${label(confirm.card)} attempt` : "Finished without shipping",
        confirm.kind === "pick"
          ? { description: "The other attempts stopped. The checks run on this branch next." }
          : { description: "Every attempt stopped. Their branches stay on GitHub." },
      );
      setConfirm(null);
    } catch (error) {
      toast.error("Couldn't finish the compare", { description: errorMessage(error, "Try again in a moment.") });
    } finally {
      setBusy(false);
    }
  };

  const headline = decided
    ? null
    : task.status === "choosing"
      ? "Every attempt is in. Pick one to ship."
      : anyDone
        ? "An attempt is in. Pick it now, or wait for the others."
        : "Each harness is attempting the whole task.";

  return (
    <section aria-label="Attempts" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12.5px] font-[550] text-muted">
          Compare · {cards.length} attempts{headline ? <span className="font-[450] text-faint"> · {headline}</span> : null}
        </p>
        {open ? (
          <Button size="xs" variant="quiet" disabled={!anyDone} onClick={() => setConfirm({ kind: "finish" })}>
            Finish without shipping
          </Button>
        ) : null}
      </div>
      <ul className="grid grid-cols-1 gap-2 @min-[44rem]:grid-cols-2 @min-[66rem]:grid-cols-3">
        {cards.map((card) => {
          const status = STATUS[card.status];
          return (
            <li
              key={card.workstreamId}
              data-attempt={card.workstreamId}
              className={cn(
                "flex min-w-0 flex-col gap-2 rounded-row bg-card px-3 py-2.5 shadow-hairline transition-shadow duration-150",
                card.picked && "shadow-[inset_0_0_0_1px_var(--color-success)]",
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                {card.cli ? <HarnessIcon cli={card.cli} size={18} decorative /> : null}
                <span className="shrink-0 text-[13.5px] font-[600] text-text">{label(card)}</span>
                {card.owner ? <span className="min-w-0 truncate text-[12px] text-muted">{card.owner}</span> : null}
                {card.picked ? (
                  <span className="ml-auto flex shrink-0 items-center gap-1 text-[12px] font-[550] text-success">
                    <Trophy className="size-3.5" aria-hidden="true" />
                    Picked
                  </span>
                ) : (
                  <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[12px] text-muted">
                    <StatusDot tone={status.tone} pulse={status.pulse} />
                    {status.label}
                    {card.since !== null && card.status === "active" ? <ElapsedTime since={card.since} className="text-faint" /> : null}
                  </span>
                )}
              </div>
              {card.summary ? <p className="line-clamp-3 text-[12.5px] leading-[1.5] break-words text-label-secondary">{card.summary}</p> : null}
              <div className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => onViewChanges(card.branch)}
                  className="flex min-w-0 items-center gap-1 rounded-[6px] px-1 py-0.5 text-[12px] text-faint outline-none transition-colors duration-150 hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`View changes on ${card.branch}`}
                >
                  <GitBranch className="size-3 shrink-0" aria-hidden="true" />
                  <span className="truncate font-mono">{card.branch}</span>
                </button>
                {open ? (
                  <Button
                    size="xs"
                    variant={card.status === "done" ? "primary" : "secondary"}
                    className="ml-auto shrink-0"
                    disabled={card.status !== "done"}
                    onClick={() => setConfirm({ kind: "pick", card })}
                  >
                    Pick this
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <DialogRoot open={confirm !== null} onOpenChange={(next) => !busy && !next && setConfirm(null)}>
        <DialogContent
          size="sm"
          title={confirm?.kind === "pick" ? `Ship the ${label(confirm.card)} attempt?` : "Finish without shipping?"}
          description={
            confirm?.kind === "pick"
              ? `Morrow merges ${confirm.card.branch} and runs the checks. Attempts still running stop now. Every branch stays on GitHub.`
              : "Every attempt still running stops and nothing is merged. The branches and what the agents said stay."
          }
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirm(null)} disabled={busy}>
                Not yet
              </Button>
              <Button variant="primary" onClick={() => void run()} loading={busy}>
                {confirm?.kind === "pick" ? "Ship it" : "Finish"}
              </Button>
            </>
          }
        />
      </DialogRoot>
    </section>
  );
}

const label = (card: Pick<AttemptCard, "cli">) => (card.cli ? HARNESS_LABEL[card.cli] : "Agent");
