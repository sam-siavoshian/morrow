"use client";

import { GITHUB_COMMENT_MAX, type ConversationItem, type MergeMethod, type PullCheck, type PullDetail } from "@morrow/contracts";
import { Check, CircleDashed, CircleX, ExternalLink, FileDiff, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, MessageSquare, MinusCircle, RefreshCw, Reply } from "lucide-react";
import { useCallback, useId, useState, type ReactNode } from "react";
import { GithubMark } from "@/components/auth/github-button";
import { ConfirmDialog } from "@/components/settings/confirm-dialog";
import { safeHref } from "@/components/timeline/linkify";
import { clockTime } from "@/components/timeline/time";
import { Alert } from "@/components/ui/alert";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useMinuteClock } from "@/components/ui/timer";
import { commentOnPull, errorMessage, getPull, getTaskPull, markPullReady, mergePull, setPullState } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useGithubVersion } from "@/lib/store";
import { FreshnessNote, GithubProblem } from "./github-states";
import { MarkdownView } from "./markdown-view";
import { checksSummary, defaultMergeMethod, MERGE_METHOD_LABEL, mergeReadiness, PULL_STATE, relativeAge, REVIEW_LABEL } from "./pull-state";
import { useGithubResource } from "./use-github";

const FILES_SHOWN = 30;

export const PULL_ICON = {
  open: <GitPullRequest className="text-success" />,
  draft: <GitPullRequestDraft className="text-faint" />,
  merged: <GitMerge className="text-soft-lilac-ink" />,
  closed: <GitPullRequestClosed className="text-danger" />,
} as const;

function OutLink({ href, children, className }: { href: string | null; children: ReactNode; className?: string }) {
  const safe = href ? safeHref(href) : null;
  if (!safe) return <span className={className}>{children}</span>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("rounded-[5px] underline-offset-[3px] hover:underline focus-visible:outline-2 focus-visible:outline-ring", className)}
    >
      {children}
    </a>
  );
}

// ---------- the task's pull request (mission control side panel) ----------

/**
 * The pull request Morrow opened for this task, live. Empty until the verifier opens one. Refetches when GitHub reports a
 * change in the project and when the task changes status (not on every trace line).
 */
export function TaskPullPanel({ teamId, taskId, projectId, taskStatus }: { teamId: string; taskId: string; projectId: string; taskStatus: string }) {
  const listVersion = useGithubVersion(projectId);
  const [known, setKnown] = useState<number | null>(null);
  const pullVersion = useGithubVersion(projectId, known);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const res = await getTaskPull(teamId, taskId, { signal });
      if (!signal.aborted) setKnown(res.pull?.number ?? null);
      return res;
    },
    [teamId, taskId],
  );
  const res = useGithubResource(`${teamId}/${taskId}`, load, `${taskStatus}:${listVersion}:${pullVersion}`);

  if (!res.data && res.loading) return <PullSkeleton />;
  if (!res.data) return <GithubProblem error={res.error} fallback="Couldn't load the pull request." onRetry={res.reload} />;
  if (!res.data.pull)
    return (
      <EmptyState
        icon={<GitPullRequest />}
        title="No pull request yet"
        description="Morrow opens one when every workstream is done and the checks pass. It shows up here as soon as it exists."
      />
    );
  return (
    <div className="flex flex-col gap-3">
      {res.error ? <GithubProblem error={res.error} fallback="Couldn't refresh the pull request." onRetry={res.reload} /> : null}
      <PullView teamId={teamId} projectId={res.data.projectId} pull={res.data.pull} onChanged={res.reload} refreshing={res.loading} />
    </div>
  );
}

/** Any pull request of a linked project, live (the pull requests page). */
export function PullPanel({ teamId, projectId, number }: { teamId: string; projectId: string; number: number }) {
  const version = useGithubVersion(projectId, number);
  const load = useCallback((signal: AbortSignal) => getPull(teamId, projectId, number, { signal }), [teamId, projectId, number]);
  const res = useGithubResource(`${teamId}/${projectId}/${number}`, load, version);
  if (!res.data && res.loading) return <PullSkeleton />;
  if (!res.data) return <GithubProblem error={res.error} fallback="Couldn't load the pull request." onRetry={res.reload} />;
  return (
    <div className="flex flex-col gap-3">
      {res.error ? <GithubProblem error={res.error} fallback="Couldn't refresh the pull request." onRetry={res.reload} /> : null}
      <PullView teamId={teamId} projectId={projectId} pull={res.data} onChanged={res.reload} refreshing={res.loading} />
    </div>
  );
}

export function PullSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading the pull request">
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-28 w-full rounded-card" />
      <Skeleton className="h-16 w-full rounded-card" />
    </div>
  );
}

// ---------- one pull request ----------

type PullViewProps = { teamId: string; projectId: string; pull: PullDetail; onChanged: () => void; refreshing: boolean };

export function PullView({ teamId, projectId, pull, onChanged, refreshing }: PullViewProps) {
  const now = useMinuteClock();
  const state = PULL_STATE[pull.state];
  return (
    <article className="flex min-w-0 flex-col gap-3" aria-label={`Pull request #${pull.number}`}>
      <header className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge tone={state.tone} size="sm" className="[&_svg]:size-3">
            {PULL_ICON[pull.state]}
            {state.label}
          </Badge>
          <OutLink href={pull.url} className="inline-flex items-center gap-1 text-[12.5px] font-[550] text-soft-sky-ink">
            <GithubMark className="size-3.5" />#{pull.number} on GitHub
            <ExternalLink className="size-3 opacity-70" />
          </OutLink>
          <Button size="icon-xs" variant="quiet" className="ml-auto" aria-label="Refresh from GitHub" onClick={onChanged} disabled={refreshing}>
            <RefreshCw className={cn(refreshing && "animate-spin")} />
          </Button>
        </div>
        <h2 className="text-[15.5px] leading-snug font-[650] tracking-[-0.014em] [overflow-wrap:anywhere] text-text">{pull.title}</h2>
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-muted">
          {pull.author ? <Avatar name={pull.author.login} src={pull.author.avatarUrl} login={pull.author.login} size={16} /> : null}
          <span className="font-[550] text-label-secondary">{pull.author?.login ?? "ghost"}</span>
          <span>wants to merge</span>
          <code className="max-w-full truncate rounded-[5px] bg-fill px-1 font-mono text-[11.5px]">{pull.headRef}</code>
          <span>into</span>
          <code className="rounded-[5px] bg-fill px-1 font-mono text-[11.5px]">{pull.baseRef}</code>
          <span aria-hidden>·</span>
          <span title={clockTime(pull.updatedAt)}>updated {relativeAge(pull.updatedAt, now)}</span>
        </p>
        <p className="flex flex-wrap items-center gap-2 text-[12.5px] tabular-nums">
          <span className="text-success">+{pull.additions.toLocaleString()}</span>
          <span className="text-danger">−{pull.deletions.toLocaleString()}</span>
          <span className="text-muted">
            {pull.changedFiles} {pull.changedFiles === 1 ? "file" : "files"} · {pull.commits} {pull.commits === 1 ? "commit" : "commits"}
          </span>
        </p>
      </header>

      <FreshnessNote freshness={pull.freshness} />
      <MergeBox teamId={teamId} projectId={projectId} pull={pull} onChanged={onChanged} />
      <Checks pull={pull} />
      <Reviewers pull={pull} />
      <Files pull={pull} />

      <section aria-label="Description" className="rounded-card bg-surface p-3 shadow-raised">
        <MarkdownView source={pull.body} />
      </section>

      <Conversation teamId={teamId} projectId={projectId} pull={pull} onChanged={onChanged} />
    </article>
  );
}

// ---------- merge, ready, close ----------

function MergeBox({ teamId, projectId, pull, onChanged }: Omit<PullViewProps, "refreshing">) {
  const now = useMinuteClock();
  const ready = mergeReadiness(pull);
  const [method, setMethod] = useState<MergeMethod | null>(null);
  const chosen = method && pull.mergeMethods.includes(method) ? method : defaultMergeMethod(pull.mergeMethods);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"ready" | "close" | "reopen" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const review = REVIEW_LABEL[pull.reviewDecision];
  const checks = checksSummary(pull.checks);

  async function act(kind: "ready" | "close" | "reopen") {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "ready") await markPullReady(teamId, projectId, pull.number);
      else await setPullState(teamId, projectId, pull.number, kind === "close" ? "closed" : "open");
      onChanged();
    } catch (e) {
      setError(errorMessage(e, "GitHub didn't take that. Try again."));
    } finally {
      setBusy(null);
    }
  }

  if (pull.state === "merged")
    return (
      <Alert tone="info" icon={<GitMerge />} title="Merged">
        {pull.mergedBy ? `${pull.mergedBy.login} merged this` : "Merged"}
        {pull.mergedAt ? ` ${relativeAge(pull.mergedAt, now)}.` : "."}
      </Alert>
    );

  return (
    <section aria-label="Merge" className="flex flex-col gap-2.5 rounded-card bg-surface p-3 shadow-raised">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={review.tone} size="sm">
          {review.label}
        </Badge>
        {checks ? (
          <Badge tone={checks.tone} size="sm">
            {checks.text}
          </Badge>
        ) : null}
        {pull.mergeable === "conflicts" ? (
          <Badge tone="rose" size="sm">
            Conflicts
          </Badge>
        ) : null}
      </div>
      {ready.blocker && pull.state === "open" ? <p className="text-[12.5px] text-muted">{ready.blocker}</p> : null}
      {!ready.blocker && ready.warning ? <p className="text-[12.5px] text-warning">{ready.warning}</p> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex flex-wrap items-center gap-2">
        {pull.state === "open" && !ready.blocker && chosen ? (
          <>
            {pull.mergeMethods.length > 1 ? (
              <Select<MergeMethod>
                size="sm"
                aria-label="Merge method"
                value={chosen}
                onValueChange={(v) => v && setMethod(v)}
                options={pull.mergeMethods.map((m) => ({ value: m, label: MERGE_METHOD_LABEL[m] }))}
              />
            ) : null}
            <Button size="sm" variant="primary" onClick={() => setConfirming(true)}>
              <GitMerge />
              {pull.mergeMethods.length > 1 ? "Merge" : MERGE_METHOD_LABEL[chosen]}
            </Button>
          </>
        ) : null}
        {pull.state === "draft" && pull.viewerCanWrite ? (
          <Button size="sm" variant="secondary" loading={busy === "ready"} disabled={busy !== null} onClick={() => void act("ready")}>
            Ready for review
          </Button>
        ) : null}
        {pull.viewerCanWrite && (pull.state === "open" || pull.state === "draft") ? (
          <Button size="sm" variant="quiet" loading={busy === "close"} disabled={busy !== null} onClick={() => void act("close")}>
            Close pull request
          </Button>
        ) : null}
        {pull.viewerCanWrite && pull.state === "closed" ? (
          <Button size="sm" variant="secondary" loading={busy === "reopen"} disabled={busy !== null} onClick={() => void act("reopen")}>
            Reopen
          </Button>
        ) : null}
      </div>
      {chosen ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          tone="primary"
          title={`Merge pull request #${pull.number}?`}
          description={`${MERGE_METHOD_LABEL[chosen]} into ${pull.baseRef}, as you on GitHub. A merge can't be undone from Morrow.`}
          confirmLabel={MERGE_METHOD_LABEL[chosen]}
          onConfirm={async () => {
            await mergePull(teamId, projectId, pull.number, { method: chosen, headSha: pull.headSha });
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}

// ---------- checks, reviewers, files ----------

const CHECK_ICON: Record<PullCheck["state"], ReactNode> = {
  passed: <Check className="size-3.5 text-success" />,
  failed: <CircleX className="size-3.5 text-danger" />,
  pending: <CircleDashed className="size-3.5 text-warning" />,
  neutral: <MinusCircle className="size-3.5 text-faint" />,
};
const CHECK_WORD: Record<PullCheck["state"], string> = { passed: "Passed", failed: "Failed", pending: "Running", neutral: "Skipped" };

function Checks({ pull }: { pull: PullDetail }) {
  if (pull.checks.items.length === 0) return null;
  const order = { failed: 0, pending: 1, passed: 2, neutral: 3 } as const;
  const items = [...pull.checks.items].sort((a, b) => order[a.state] - order[b.state]);
  return (
    <Section title="Checks">
      <ul className="flex flex-col gap-1">
        {items.map((c, i) => (
          <li key={`${c.name}-${i}`} className="flex min-w-0 items-center gap-2 text-[12.5px]">
            <span aria-label={CHECK_WORD[c.state]} role="img" className="shrink-0">
              {CHECK_ICON[c.state]}
            </span>
            <OutLink href={c.url} className="min-w-0 truncate font-[550] text-label-secondary">
              {c.name}
            </OutLink>
            {c.detail ? <span className="ml-auto shrink-0 truncate text-faint">{c.detail}</span> : null}
          </li>
        ))}
      </ul>
      {pull.checks.truncated ? <p className="mt-1 text-[12px] text-faint">More checks are on GitHub.</p> : null}
    </Section>
  );
}

const REVIEWER_WORD = { approved: "approved", changes_requested: "requested changes", commented: "commented", dismissed: "dismissed", requested: "review requested" } as const;

function Reviewers({ pull }: { pull: PullDetail }) {
  if (pull.reviewers.length === 0) return null;
  return (
    <Section title="Reviewers">
      <ul className="flex flex-col gap-1">
        {pull.reviewers.map((r) => (
          <li key={r.login} className="flex min-w-0 items-center gap-2 text-[12.5px]">
            <Avatar name={r.login} src={r.avatarUrl} login={r.login} size={18} />
            <span className="min-w-0 truncate font-[550] text-label-secondary">{r.login}</span>
            <span className={cn("ml-auto shrink-0", r.state === "approved" ? "text-success" : r.state === "changes_requested" ? "text-danger" : "text-muted")}>
              {REVIEWER_WORD[r.state]}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

const FILE_LETTER: Record<PullDetail["files"][number]["status"], string> = { added: "A", removed: "D", modified: "M", renamed: "R", copied: "C", changed: "M", unchanged: "·" };

function Files({ pull }: { pull: PullDetail }) {
  const [all, setAll] = useState(false);
  if (pull.files.length === 0) return null;
  const shown = all ? pull.files : pull.files.slice(0, FILES_SHOWN);
  return (
    <Section title={`Files changed (${pull.changedFiles})`} icon={<FileDiff />}>
      <ul className="flex flex-col gap-0.5">
        {shown.map((f) => (
          <li key={f.path} className="flex min-w-0 items-center gap-2 font-mono text-[12px]">
            <span aria-label={f.status} className="w-3 shrink-0 text-center text-faint">
              {FILE_LETTER[f.status]}
            </span>
            <span className="min-w-0 flex-1 truncate text-label-secondary" title={f.previousPath ? `${f.previousPath} → ${f.path}` : f.path}>
              {f.path}
            </span>
            <span className="shrink-0 text-success tabular-nums">+{f.additions}</span>
            <span className="shrink-0 text-danger tabular-nums">−{f.deletions}</span>
          </li>
        ))}
      </ul>
      {pull.files.length > FILES_SHOWN ? (
        <Button size="xs" variant="quiet" className="mt-1 self-start" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${pull.files.length}`}
        </Button>
      ) : null}
      {pull.changedFiles > pull.files.length ? <p className="mt-1 text-[12px] text-faint">The rest of the files are on GitHub.</p> : null}
    </Section>
  );
}

function Section({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col rounded-card bg-surface p-3 shadow-raised">
      <h3 className="mb-2 flex items-center gap-1.5 text-[12.5px] font-[600] text-text [&_svg]:size-3.5 [&_svg]:text-faint">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

// ---------- conversation ----------

const REVIEW_WORD: Record<Extract<ConversationItem, { kind: "review" }>["state"], string> = {
  approved: "approved these changes",
  changes_requested: "requested changes",
  commented: "reviewed",
  dismissed: "had a review dismissed",
};

function Conversation({ teamId, projectId, pull, onChanged }: Omit<PullViewProps, "refreshing">) {
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const items = pull.conversation;
  const now = useMinuteClock();
  return (
    <section aria-label="Conversation" className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1.5 text-[12.5px] font-[600] text-text">
        <MessageSquare className="size-3.5 text-faint" />
        Conversation
      </h3>
      {pull.conversationTruncated ? (
        <p className="text-[12px] text-faint">
          Older comments are on{" "}
          <OutLink href={pull.url} className="text-soft-sky-ink">
            GitHub
          </OutLink>
          .
        </p>
      ) : null}
      {items.length === 0 ? <p className="text-[12.5px] text-muted">No comments yet.</p> : null}
      <ol className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={`${item.kind}-${item.id}`} className="rounded-card bg-surface p-3 shadow-raised">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px]">
              <Avatar name={item.author?.login ?? "ghost"} src={item.author?.avatarUrl} login={item.author?.login} size={18} />
              <span className="font-[600] text-text">{item.author?.login ?? "ghost"}</span>
              <span className="text-muted">{item.kind === "review" ? REVIEW_WORD[item.state] : item.kind === "review_comment" ? "commented on a line" : "commented"}</span>
              <OutLink href={item.url} className="ml-auto text-faint">
                <span title={clockTime(item.createdAt)}>{relativeAge(item.createdAt, now)}</span>
              </OutLink>
            </div>
            {item.kind === "review_comment" ? (
              <div className="mt-2 overflow-hidden rounded-row bg-fill shadow-hairline">
                <p className="truncate px-2 py-1 font-mono text-[11.5px] text-muted">
                  {item.path}
                  {item.line ? `:${item.line}` : ""}
                </p>
                {item.codeLine ? (
                  <pre
                    className={cn(
                      "overflow-x-auto border-t border-border px-2 py-1 font-mono text-[11.5px]",
                      item.codeLine.startsWith("+") ? "text-success" : item.codeLine.startsWith("-") ? "text-danger" : "text-label-secondary",
                    )}
                  >
                    {item.codeLine}
                  </pre>
                ) : null}
              </div>
            ) : null}
            {item.body.trim() ? <MarkdownView source={item.body} className="mt-2" /> : null}
            {item.kind === "review_comment" ? (
              replyTo === item.id ? (
                <Composer
                  className="mt-2"
                  label={`Reply to ${item.author?.login ?? "this comment"}`}
                  submitLabel="Reply"
                  autoFocus
                  onCancel={() => setReplyTo(null)}
                  onSubmit={async (body) => {
                    // GitHub threads replies under the first comment of the thread.
                    await commentOnPull(teamId, projectId, pull.number, { body, inReplyTo: item.inReplyTo ?? item.id });
                    setReplyTo(null);
                    onChanged();
                  }}
                />
              ) : (
                <Button size="xs" variant="quiet" className="mt-1.5" onClick={() => setReplyTo(item.id)}>
                  <Reply />
                  Reply
                </Button>
              )
            ) : null}
          </li>
        ))}
      </ol>
      <Composer
        label="Comment on this pull request"
        submitLabel="Comment"
        onSubmit={async (body) => {
          await commentOnPull(teamId, projectId, pull.number, { body });
          onChanged();
        }}
      />
    </section>
  );
}

type ComposerProps = {
  label: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
  className?: string;
};

/** Markdown comment box. Cmd/Ctrl+Enter sends. Posted as the signed-in member on GitHub. */
export function Composer({ label, submitLabel, onSubmit, onCancel, autoFocus, className }: ComposerProps) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = body.trim();
  const tooLong = trimmed.length > GITHUB_COMMENT_MAX;
  const id = useId();

  async function submit() {
    if (!trimmed || tooLong || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      setBody("");
    } catch (e) {
      setError(errorMessage(e, "Couldn't post that. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Textarea
        id={id}
        value={body}
        rows={2}
        maxRows={12}
        autoFocus={autoFocus}
        placeholder={`${label} (markdown works)`}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
          if (e.key === "Escape" && onCancel) onCancel();
        }}
      />
      {tooLong ? <p className="text-[12px] text-danger">Too long for one comment: keep it under {GITHUB_COMMENT_MAX.toLocaleString()} characters.</p> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex items-center justify-end gap-2">
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" loading={busy} disabled={!trimmed || tooLong} onClick={() => void submit()}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
