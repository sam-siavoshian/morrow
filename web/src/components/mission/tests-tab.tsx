"use client";

import type { CheckStatus, ProjectView } from "@morrow/contracts";
import { Check, ExternalLink, FlaskConical, Minus, X } from "lucide-react";
import Link from "next/link";
import { safeHref } from "@/components/timeline/linkify";
import { RichText } from "@/components/timeline/rich-text";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { RadarSpinner } from "@/components/ui/radar-spinner";
import { cn } from "@/lib/cn";
import { DetailStatus } from "./detail-status";
import type { TaskDetailState } from "./use-task-detail";

function CheckIcon({ status }: { status: CheckStatus }) {
  switch (status) {
    case "passed":
      return (
        <span className="grid size-5 place-items-center rounded-full bg-soft-mint-wash text-success">
          <Check className="size-3" strokeWidth={2.75} />
        </span>
      );
    case "failed":
      return (
        <span className="grid size-5 place-items-center rounded-full bg-soft-rose-wash text-danger">
          <X className="size-3" strokeWidth={2.75} />
        </span>
      );
    case "pending":
      return (
        <span className="grid size-5 place-items-center rounded-full bg-soft-sky-wash text-soft-sky">
          <RadarSpinner className="size-3" />
        </span>
      );
    case "skipped":
      return (
        <span className="grid size-5 place-items-center rounded-full bg-fill text-faint">
          <Minus className="size-3" strokeWidth={2.75} />
        </span>
      );
  }
}

const SUMMARY: Record<CheckStatus, string> = {
  pending: "Verifying",
  passed: "Verification passed",
  failed: "Verification failed",
  skipped: "Verification skipped",
};

/**
 * Verification evidence: every check, what it found, and a link when there is one. `settingsHref` is the
 * Projects settings link for viewers who can set the test command, null for everyone else.
 */
export function TestsTab({ detail, project, settingsHref }: { detail: TaskDetailState; project: ProjectView | null; settingsHref: string | null }) {
  if (!detail.data) return <DetailStatus detail={detail} what="the checks" className="px-0" />;
  const verification = detail.data.verification;
  if (!verification || verification.checks.length === 0) {
    return (
      <EmptyState
        icon={<FlaskConical />}
        title="No checks yet"
        description={
          project?.testCommand
            ? "Checks run once every workstream is done: the branches merge, then the test command runs on a fresh worktree."
            : settingsHref
              ? "Checks run once every workstream is done. This project has no test command yet, so tests are skipped."
              : "Checks run once every workstream is done. This project has no test command yet; ask a team admin to set one."
        }
        action={
          project?.testCommand ? (
            <code className="rounded-[6px] bg-fill px-2 py-1 font-mono text-[12.5px] text-label-secondary">{project.testCommand}</code>
          ) : project && settingsHref ? (
            <Button size="sm" variant="secondary" render={<Link href={settingsHref} />}>
              Set a test command
            </Button>
          ) : undefined
        }
      />
    );
  }
  const passed = verification.checks.filter((c) => c.status === "passed").length;
  return (
    <div className="flex flex-col gap-3">
      <DetailStatus detail={detail} what="the checks" className="px-0" />
      <div className="flex items-center gap-2.5">
        <CheckIcon status={verification.status} />
        <span
          className={cn(
            "text-[14px] font-[600] tracking-[-0.01em]",
            verification.status === "failed" ? "text-danger" : verification.status === "passed" ? "text-success" : "text-text",
          )}
        >
          {SUMMARY[verification.status]}
        </span>
        <span className="ml-auto text-[12px] text-muted tabular-nums">
          {passed}/{verification.checks.length} passed
        </span>
      </div>
      <ul className="overflow-hidden rounded-card bg-surface shadow-raised">
        {verification.checks.map((check, i) => {
          const href = check.url ? safeHref(check.url) : null;
          return (
            <li key={`${check.name}-${i}`} className="flex items-start gap-2.5 border-b border-border px-3 py-2.5 last:border-b-0">
              <CheckIcon status={check.status} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13.5px] font-[600] tracking-[-0.008em]">{check.name}</span>
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open ${check.name}`}
                      className="ml-auto inline-flex items-center gap-1 text-[12px] font-[550] text-soft-sky-ink hover:underline"
                    >
                      Open <ExternalLink className="size-3" />
                    </a>
                  ) : null}
                </div>
                {check.detail ? <RichText text={check.detail} className="mt-0.5 block font-mono text-[12px] leading-[1.5] text-muted" /> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
