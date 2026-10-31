"use client";

import type { ProjectView, RepoSummary } from "@morrow/contracts";
import { Check, FolderGit2, Lock, RotateCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { RadarSpinner } from "@/components/ui/radar-spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, linkProject, listRepos } from "@/lib/api";
import { cn } from "@/lib/cn";
import { linkedKeys, linkLabel, mergeRepoPages, moveFocus, pruneSelection, repoKey, toggleRepo } from "./repo-selection";

const PER_PAGE = 30;
const SEARCH_DEBOUNCE_MS = 250;

type Page = { repos: RepoSummary[]; nextPage: number | null };
type Failure = { repo: string; message: string };

/** Search, pages, selection and linking for the repos you can push to. The list and its actions read it. */
export function useRepoPicker({ teamId, linked }: { teamId: string; linked: readonly string[] }) {
  const [query, setQuery] = useState("");
  // The query the shown page answers; differs from `query` while a search is debouncing.
  const [shownQuery, setShownQuery] = useState<string | null>(null);
  const [data, setData] = useState<Page | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawSelected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [linking, setLinking] = useState(false);
  const [failures, setFailures] = useState<Failure[]>([]);
  const [reload, setReload] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const linkedSet = useMemo(() => linkedKeys(linked), [linked]);
  // A repo a teammate linked while this was open is no longer ours to link.
  const selected = useMemo(() => pruneSelection(rawSelected, linkedSet), [rawSelected, linkedSet]);

  const load = useCallback(async (page: number, q: string) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError(null);
    try {
      const result = await listRepos({ page, perPage: PER_PAGE, q: q.trim() || undefined }, { signal: controller.signal });
      setData((prev) => (page === 1 || !prev ? result : { repos: mergeRepoPages(prev.repos, result.repos), nextPage: result.nextPage }));
      setShownQuery(q);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(errorMessage(e, "Couldn't load your repos."));
      setShownQuery(q);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(1, query), query ? SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [query, reload, load]);

  useEffect(() => () => abort.current?.abort(), []);

  const toggle = useCallback((fullName: string) => setSelected((prev) => toggleRepo(prev, fullName, linkedSet)), [linkedSet]);

  /** Links every ticked repo, one at a time (each link reads the repo from GitHub, and that bucket is small). */
  const link = useCallback(async (): Promise<ProjectView[]> => {
    if (busy.current || selected.size === 0) return [];
    busy.current = true;
    setLinking(true);
    setFailures([]);
    const done: ProjectView[] = [];
    const failed: Failure[] = [];
    for (const repo of selected) {
      try {
        done.push(await linkProject(teamId, { repoFullName: repo }));
      } catch (e) {
        failed.push({ repo, message: errorMessage(e, "Couldn't link it.") });
      }
    }
    busy.current = false;
    setLinking(false);
    setFailures(failed);
    setSelected(new Set(failed.map((f) => f.repo)));
    return done;
  }, [selected, teamId]);

  return {
    query,
    setQuery,
    /** The shown results answer an older query: a search is debouncing or in flight. */
    stale: shownQuery !== query,
    loading,
    data,
    error,
    retry: () => setReload((n) => n + 1),
    loadMore: () => (data?.nextPage ? void load(data.nextPage, query) : undefined),
    linkedSet,
    selected,
    toggle,
    clear: () => setSelected(new Set()),
    linking,
    failures,
    link,
  };
}

export type RepoPickerState = ReturnType<typeof useRepoPicker>;

type RepoListProps = {
  picker: RepoPickerState;
  /** Enter on the search field or a row, with something ticked: the caller links. */
  onSubmit?: () => void;
  className?: string;
};

/** Search plus one uniform row per repo: tick to select, a Linked badge for what the team already has. */
export function RepoList({ picker, onSubmit, className }: RepoListProps) {
  const { query, setQuery, data, loading, stale, error, linkedSet, selected, toggle, linking, failures } = picker;
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const repos = data?.repos ?? [];
  const firstLoad = data === null && !error;

  const rows = () => [...(list.current?.querySelectorAll<HTMLElement>("[data-repo-check]:not([data-disabled])") ?? [])];

  function submit(event: KeyboardEvent) {
    if (selected.size === 0 || !onSubmit) return false;
    event.preventDefault();
    onSubmit();
    return true;
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      rows()[0]?.focus();
    } else if (event.key === "Enter") {
      if (!submit(event)) {
        event.preventDefault();
        rows()[0]?.focus();
      }
    } else if (event.key === "Escape" && query) {
      // Clear first; a second Escape is the dialog's or the flow's.
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    }
  }

  function onListKey(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (!target.matches("[data-repo-check]")) return;
    if (event.key === "Enter") {
      submit(event);
      return;
    }
    const all = rows();
    const next = moveFocus(event.key, all.indexOf(target), all.length);
    if (next === null) return;
    event.preventDefault();
    if (next === -1) search.current?.focus();
    else all[next]?.focus();
  }

  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)} data-own-keys>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
        <Input
          ref={search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder="Search your repos"
          aria-label="Search your repos"
          aria-describedby="repo-picker-hint"
          maxLength={100}
          className="pr-9 pl-9"
          autoComplete="off"
          spellCheck={false}
        />
        {stale && data ? <RadarSpinner className={cn("absolute top-1/2 -translate-y-1/2 text-soft-sky", query ? "right-9" : "right-3")} /> : null}
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              search.current?.focus();
            }}
            className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-full text-faint transition-colors duration-150 hover:bg-fill-hover hover:text-text focus-visible:outline-2 focus-visible:outline-ring"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
      <p id="repo-picker-hint" className="sr-only">
        Press Down to move into the list, Space to tick a repo, Enter to link what you ticked.
      </p>

      <div
        ref={list}
        role="group"
        aria-label="Your repos"
        aria-busy={loading}
        onKeyDown={onListKey}
        className="flex h-[min(20rem,42svh)] flex-col overflow-y-auto rounded-card bg-fill p-1 shadow-row-rim"
      >
        {error ? (
          <div className="m-auto flex max-w-xs flex-col items-center gap-3 px-4 py-8 text-center" role="alert">
            <p className="text-[14px] font-[600] text-text">Couldn&apos;t load your repos</p>
            <p className="text-[13px] leading-[1.5] text-muted">{error}</p>
            <Button size="sm" variant="secondary" onClick={picker.retry}>
              <RotateCw />
              Try again
            </Button>
          </div>
        ) : firstLoad ? (
          <div aria-label="Loading your repos" role="status">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="flex h-[52px] items-center gap-3 px-3">
                <Skeleton className="size-4 rounded-[5px]" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3 w-2/5 rounded-full" />
                  <Skeleton className="h-2.5 w-3/5 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        ) : repos.length === 0 && !stale ? (
          <div className="m-auto flex max-w-xs flex-col items-center gap-2 px-4 py-8 text-center">
            <FolderGit2 className="size-5 text-faint" />
            {query.trim() ? (
              <>
                <p className="text-[14px] font-[600] text-text">No repos match &ldquo;{query.trim()}&rdquo;</p>
                <Button size="xs" variant="quiet" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              </>
            ) : (
              <>
                <p className="text-[14px] font-[600] text-text">No repos you can push to</p>
                <p className="text-[13px] leading-[1.5] text-muted">Agents push branches, so only repos with write access show up here.</p>
              </>
            )}
          </div>
        ) : (
          <div className={cn("flex flex-col transition-opacity duration-200", stale && "opacity-60")}>
            {repos.map((repo) => (
              <RepoRow
                key={repo.id}
                repo={repo}
                linked={linkedSet.has(repoKey(repo.fullName))}
                checked={selected.has(repo.fullName)}
                disabled={linking}
                onToggle={() => toggle(repo.fullName)}
              />
            ))}
            {stale ? null : loading ? (
              <span role="status" className="flex items-center justify-center gap-2 py-3 text-[13px] text-muted">
                <RadarSpinner className="text-soft-sky" />
                Loading more
              </span>
            ) : data?.nextPage ? (
              <Button size="sm" variant="quiet" className="mx-auto my-1.5" onClick={picker.loadMore}>
                Load more
              </Button>
            ) : null}
          </div>
        )}
      </div>

      {failures.length > 0 ? (
        <Alert tone="danger" title={failures.length === 1 ? "One repo didn't link" : `${failures.length} repos didn't link`}>
          <ul className="mt-1 flex flex-col gap-0.5">
            {failures.map((f) => (
              <li key={f.repo}>
                <span className="font-[550]">{f.repo}</span>: {f.message}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
    </div>
  );
}

type RepoRowProps = { repo: RepoSummary; linked: boolean; checked: boolean; disabled: boolean; onToggle: () => void };

function RepoRow({ repo, linked, checked, disabled, onToggle }: RepoRowProps) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-[550] tracking-[-0.008em] text-text">{repo.fullName}</span>
        {repo.description ? <span className="mt-0.5 block truncate text-[12.5px] text-muted">{repo.description}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {repo.private ? (
          <Badge size="sm" tone="outline">
            <Lock />
            Private
          </Badge>
        ) : null}
        {linked ? (
          <Badge size="sm" tone="mint">
            <Check strokeWidth={2.5} />
            Linked
          </Badge>
        ) : null}
      </span>
    </>
  );

  // Same height, padding and slots either way; only the leading slot and the hover differ.
  const row = "flex min-h-[52px] items-center gap-3 rounded-row px-3 py-2";
  if (linked) {
    return (
      <div className={row}>
        <span className="grid size-4 shrink-0 place-items-center text-faint" aria-hidden="true">
          <FolderGit2 className="size-4" />
        </span>
        {body}
      </div>
    );
  }
  return (
    <label
      className={cn(
        row,
        "cursor-pointer transition-colors duration-150 hover:bg-row-hover has-data-checked:bg-row-active",
        disabled && "cursor-not-allowed hover:bg-transparent",
      )}
    >
      <Checkbox data-repo-check="" checked={checked} disabled={disabled} onCheckedChange={onToggle} aria-label={repo.fullName} />
      {body}
    </label>
  );
}

type RepoPickerActionsProps = {
  picker: RepoPickerState;
  onLinked: (projects: ProjectView[]) => void;
  /** A secondary action next to Link, e.g. "Skip for now". */
  secondary?: ReactNode;
};

/** The count, the secondary action and the one primary: "Link 2 repos". */
export function RepoPickerActions({ picker, onLinked, secondary }: RepoPickerActionsProps) {
  const count = picker.selected.size;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-[13px] text-muted tabular-nums" aria-live="polite">
        {count === 0 ? (
          "Tick the repos agents should work on."
        ) : (
          <>
            {count} selected
            <Button size="xs" variant="quiet" onClick={picker.clear} disabled={picker.linking}>
              Clear
            </Button>
          </>
        )}
      </span>
      <div className="flex items-center gap-2">
        {secondary}
        <Button
          variant="primary"
          size="sm"
          disabled={count === 0}
          loading={picker.linking}
          onClick={async () => {
            const done = await picker.link();
            if (done.length > 0) onLinked(done);
          }}
        >
          {linkLabel(count)}
          {count > 0 ? <Kbd keys="enter" aria-hidden className="-mr-1 [&>span]:bg-[color-mix(in_srgb,var(--color-on-lit)_14%,transparent)] [&>span]:text-on-lit/70" /> : null}
        </Button>
      </div>
    </div>
  );
}

type RepoPickerProps = {
  teamId: string;
  /** Repos the team already has, by full name. Shown with a Linked badge. */
  linked: readonly string[];
  onLinked: (projects: ProjectView[]) => void;
  secondary?: ReactNode;
  className?: string;
};

/** The self-contained picker for dialogs: list plus its own actions. Setup uses the parts instead. */
export function RepoPicker({ teamId, linked, onLinked, secondary, className }: RepoPickerProps) {
  const picker = useRepoPicker({ teamId, linked });
  const submit = async () => {
    const done = await picker.link();
    if (done.length > 0) onLinked(done);
  };
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <RepoList picker={picker} onSubmit={() => void submit()} />
      <RepoPickerActions picker={picker} onLinked={onLinked} secondary={secondary} />
    </div>
  );
}
