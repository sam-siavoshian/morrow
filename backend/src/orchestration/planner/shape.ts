// Turns planner output into a plan the actor accepts, and enforces the section 9.1 heuristics: one
// workstream for small changes, otherwise as many as the work needs up to maxAgents, and workstreams that
// run side by side never own the same files (a test or integration stream gated on the others may). Every
// workstream gets a slug role, a `morrow/<taskShort>/<role>` branch, ownership globs and a rationale.
import { z } from "zod";
import { RESOLVER_ROLE, ROLE_PATTERN, workstreamBranch } from "../names.ts";
import type { PlanInput, PlanWorkstreamInput } from "../workforce.ts";

const LIMITS = { title: 120, brief: 12_000, why: 2_000, rationale: 4_000, warning: 300, ownership: 50, glob: 200 };

/** What we ask the planner CLI to print. Loose on size (we clip), strict on shape. */
export const PlannerOutput = z.object({
  rationale: z.string().min(1).max(20_000),
  workstreams: z
    .array(
      z.object({
        role: z.string().min(1).max(64),
        title: z.string().min(1).max(500),
        brief: z.string().min(1).max(50_000),
        why: z.string().max(10_000).optional().default(""),
        ownership: z.array(z.string().max(500)).max(200).optional().default([]),
        dependsOn: z.array(z.string().max(64)).max(20).optional().default([]),
      }),
    )
    .min(1)
    .max(10),
});
export type PlannerOutput = z.infer<typeof PlannerOutput>;

/** What the planner records: its own plan or the fallback, never a compare plan (compare.ts makes those). */
export type PlannerPlan = PlanInput & { source: "cli" | "fallback" };

export interface PlanTask {
  id: string;
  title: string;
  prompt: string;
  acceptance: string[];
}

interface Draft {
  role: string;
  title: string;
  brief: string;
  why: string;
  ownership: string[];
  dependsOn: string[];
}

/** Multi-line text the actor accepts: no control characters but newline and tab. */
// Half of a surrogate pair is not text, and the actors reject it.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function cleanText(value: string, max: number): string {
  const text = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(LONE_SURROGATE, "").trim();
  if (text.length <= max) return text;
  // Never cut a surrogate pair in half.
  const end = /[\uD800-\uDBFF]/.test(text[max - 2] ?? "") ? max - 2 : max - 1;
  return `${text.slice(0, end)}…`;
}

export function cleanLine(value: string, max: number): string {
  return cleanText(value.replace(/\s+/g, " "), max);
}

/** Roles the system owns: `integration` would share the verifier's integration branch, `resolver` the conflict resolver's. */
const RESERVED_ROLES: Readonly<Record<string, string>> = { integration: "integrationtests", [RESOLVER_ROLE]: "resolve" };

export function normalizeRole(raw: string): string {
  const slug = raw.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^[0-9]+/, "").slice(0, 16);
  if (!ROLE_PATTERN.test(slug)) return "dev";
  return RESERVED_ROLES[slug] ?? slug;
}

/** Relative glob, no traversal, no absolute paths, no shell-ish characters. */
export function validGlob(glob: string): boolean {
  if (glob.length < 1 || glob.length > LIMITS.glob) return false;
  if (!/^[A-Za-z0-9._*?/{},\[\]!@+-]+$/.test(glob)) return false;
  if (glob.startsWith("/") || glob.startsWith("-")) return false;
  return !glob.split("/").some((part) => part === ".." || part === ".");
}

function staticPrefix(glob: string): string {
  const cut = glob.search(/[*?{[!]/);
  return cut === -1 ? glob : glob.slice(0, cut);
}

/** Conservative: two globs overlap unless their fixed prefixes clearly point at different paths. */
export function globsOverlap(a: string, b: string): boolean {
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

const TEST_LIKE = /test|qa|e2e|integration|verify|spec/;
const isGatedTestStream = (ws: Draft) => ws.dependsOn.length > 0 && (TEST_LIKE.test(ws.role) || TEST_LIKE.test(ws.title.toLowerCase()));

/** A short request with few acceptance criteria is a small change: one agent. */
export function isSmallTask(task: Pick<PlanTask, "prompt" | "acceptance">): boolean {
  return task.prompt.trim().length < 280 && task.acceptance.length <= 2;
}

function merge(group: Draft[]): Draft {
  const [first] = group;
  if (!first || group.length === 1) return first!;
  const roles = new Set(group.map((ws) => ws.role));
  return {
    role: first.role,
    title: cleanLine(group.map((ws) => ws.title).join(" + "), LIMITS.title),
    brief: group.map((ws) => `## ${ws.title}\n\n${ws.brief}`).join("\n\n"),
    why: group.map((ws) => ws.why).filter(Boolean).join(" "),
    ownership: [...new Set(group.flatMap((ws) => ws.ownership))],
    dependsOn: [...new Set(group.flatMap((ws) => ws.dependsOn))].filter((role) => !roles.has(role)),
  };
}

/** Merges `group` into its first member and repoints dependencies on the others. */
function collapse(list: Draft[], group: Draft[]): Draft[] {
  if (group.length < 2) return list;
  const merged = merge(group);
  const gone = new Set(group.map((ws) => ws.role));
  const out: Draft[] = [];
  for (const ws of list) {
    if (ws === group[0]) out.push(merged);
    else if (!gone.has(ws.role)) {
      const deps = ws.dependsOn.map((role) => (gone.has(role) ? merged.role : role));
      out.push({ ...ws, dependsOn: [...new Set(deps)].filter((role) => role !== ws.role) });
    }
  }
  return out;
}

function hasCycle(list: Draft[]): boolean {
  const deps = new Map(list.map((ws) => [ws.role, ws.dependsOn]));
  const state = new Map<string, 1 | 2>();
  const visit = (role: string): boolean => {
    if (state.get(role) === 2) return false;
    if (state.get(role) === 1) return true;
    state.set(role, 1);
    for (const dep of deps.get(role) ?? []) if (visit(dep)) return true;
    state.set(role, 2);
    return false;
  };
  return list.some((ws) => visit(ws.role));
}

const sharesFiles = (a: Draft, b: Draft) =>
  a.ownership.length === 0 || b.ownership.length === 0 || a.ownership.some((ga) => b.ownership.some((gb) => globsOverlap(ga, gb)));

/** Roles of the workstreams that would edit the same files, grouped (sharing is transitive), in plan order. Groups of two or more. */
function overlapGroups(build: Draft[]): string[][] {
  const parent = build.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]!)));
  for (let i = 0; i < build.length; i++)
    for (let j = i + 1; j < build.length; j++) if (sharesFiles(build[i]!, build[j]!)) parent[root(j)] = root(i);
  const byRoot = new Map<number, string[]>();
  build.forEach((ws, i) => byRoot.set(root(i), [...(byRoot.get(root(i)) ?? []), ws.role]));
  return [...byRoot.values()].filter((g) => g.length > 1);
}

/**
 * Applies the heuristics to planner output. Returns the actor's PlanInput; `warnings` say what we changed,
 * so the UI can show it next to the plan.
 */
export function shapePlan(
  task: PlanTask,
  output: PlannerOutput,
  options: { maxAgents: number; source: "cli"; profileId: string },
): PlannerPlan {
  const warnings: string[] = [];
  const seen = new Set<string>();
  let list: Draft[] = output.workstreams.map((raw, index) => {
    let role = normalizeRole(raw.role);
    for (let n = 2; seen.has(role); n++) role = `${normalizeRole(raw.role).slice(0, 14)}${n}`;
    seen.add(role);
    const globs = [...new Set(raw.ownership.map((g) => g.trim()))];
    const ownership = globs.filter(validGlob).slice(0, LIMITS.ownership);
    if (ownership.length < globs.length) warnings.push(`Dropped invalid ownership globs from "${role}".`);
    return {
      role,
      title: cleanLine(raw.title, LIMITS.title) || `Workstream ${index + 1}`,
      brief: cleanText(raw.brief, LIMITS.brief),
      why: cleanText(raw.why, LIMITS.why),
      ownership,
      dependsOn: raw.dependsOn.map(normalizeRole),
    };
  });
  const roles = new Set(list.map((ws) => ws.role));
  list = list.map((ws) => ({ ...ws, dependsOn: [...new Set(ws.dependsOn)].filter((role) => roles.has(role) && role !== ws.role) }));
  if (hasCycle(list)) {
    warnings.push("The planner's dependencies formed a cycle; they were dropped.");
    list = list.map((ws) => ({ ...ws, dependsOn: [] }));
  }

  const cap = Math.max(1, options.maxAgents);
  if (list.length > 1 && isSmallTask(task)) {
    warnings.push("Small change: merged into one workstream.");
    list = collapse(list, list);
  }
  if (list.length > cap) {
    warnings.push(`Merged ${list.length} workstreams down to ${cap} (the limit for this task).`);
    list = collapse(list, list.slice(cap - 1));
  }
  // Only the workstreams that would edit the same files merge; the rest of the split stands. A merge rebuilds the
  // drafts that depended on it, so each group is looked up again by role.
  for (const group of overlapGroups(list.filter((ws) => !(list.length > 1 && isGatedTestStream(ws))))) {
    warnings.push(`Merged ${group.map((role) => `"${role}"`).join(", ")}: they would edit the same files in parallel.`);
    list = collapse(list, list.filter((ws) => group.includes(ws.role)));
  }
  // Merging two workstreams with one waiting between them would make them wait on each other.
  if (hasCycle(list)) {
    warnings.push("Merging left the workstreams waiting on each other; their dependencies were dropped.");
    list = list.map((ws) => ({ ...ws, dependsOn: [] }));
  }

  const workstreams: PlanWorkstreamInput[] = list.map((ws) => ({
    id: `ws-${ws.role}`,
    role: ws.role,
    title: ws.title,
    brief: ws.brief || cleanText(task.prompt, LIMITS.brief),
    why: ws.why || "Proposed by the planner.",
    branch: workstreamBranch(task.id, ws.role),
    dependsOn: ws.dependsOn.map((role) => `ws-${role}`),
    ownership: ws.ownership.length > 0 ? ws.ownership : ["**"],
  }));
  return {
    source: options.source,
    profileId: options.profileId,
    rationale: cleanText(output.rationale, LIMITS.rationale) || "Planned by the CLI planner.",
    warnings: [...new Set(warnings)].slice(0, 20).map((w) => cleanLine(w, LIMITS.warning)),
    workstreams,
  };
}

/**
 * The deterministic fallback: one workstream that owns the whole change, with the reason shown in the UI.
 * Plan feedback, when there is any, rides along in the brief so the worker still sees it.
 */
export function fallbackPlan(task: PlanTask, reason: string, feedback?: string): PlannerPlan {
  const why = cleanLine(reason, 200);
  const acceptance = task.acceptance.length > 0 ? `\n\nAcceptance criteria:\n${task.acceptance.map((a) => `- ${a}`).join("\n")}` : "";
  const notes = feedback ? `\n\nPlan feedback from the team:\n${feedback}` : "";
  return {
    source: "fallback",
    profileId: null,
    rationale: `Planner fallback: ${why}. One worker owns the whole change on one branch, so nothing has to be merged across workers.`,
    warnings: [cleanLine(`Planner fallback: ${why}`, LIMITS.warning)],
    workstreams: [
      {
        id: "ws-dev",
        role: "dev",
        title: cleanLine(task.title, LIMITS.title),
        brief: cleanText(`${task.prompt}${acceptance}${notes}`, LIMITS.brief),
        why: `Planner fallback (${why}): a single workstream is the safe default.`,
        branch: workstreamBranch(task.id, "dev"),
        dependsOn: [],
        ownership: ["**"],
      },
    ],
  };
}

/**
 * Partner roles added to a plan that has fewer workstreams than the task should run with (`crewTarget`), so every
 * task has agents to talk to. Each has its own work that needs the others: a reviewer and a researcher. Neither owns
 * product files (only its notes folder), so a partner never conflicts with the code at merge time.
 */
const PARTNERS = [
  {
    role: "review",
    title: "Pair: review and push back",
    why: "A second agent, ideally on another coding CLI, reviews the approach and the diff while the work happens.",
    brief: (builders: string) =>
      [
        `You are the review partner of ${builders}: another agent, usually on a different coding CLI. You do not build the change; they do. Your job is to make their work better while it happens:`,
        "1. When they post their plan, push back on anything wrong, risky or missing, with a concrete alternative.",
        "2. Answer their questions fast, and do quick lookups for them: read the code on your branch (it starts from the default branch), find the existing pattern, the file, the convention.",
        "3. Before they post DONE, ask them for the changed files and the key hunks (or the commit), review them and post concrete findings: file, line, what to change.",
        "4. Check their claims against the code. Say so when something looks off.",
        "Do not edit the files they own. Write anything long in .morrow/review/notes.md and point to it.",
        "When @dispatcher tells you their workstream is done, post your final review in one or two lines, then post DONE.",
      ].join("\n"),
    ownership: [".morrow/review/**"],
  },
  {
    role: "research",
    title: "Research: find what the change needs, then audit it",
    why: "A third agent researches the change and audits the result, so the builders do not guess.",
    brief: (builders: string) =>
      [
        `You are the research partner of ${builders}. You do not build the change; they do. Your job:`,
        "1. Find what the change needs before they guess: how this repository already does it (files, patterns), the relevant docs or standards, the pitfalls. Post each finding as a short message to them, with file paths.",
        "2. Answer their lookups and questions while they work.",
        "3. When they are close to done, check their work against the acceptance criteria and your findings, and tell them what is missing.",
        "Do not edit the files they own. Write anything long in .morrow/research/notes.md and point to it.",
        "When @dispatcher tells you their workstream is done, post a one-line verdict, then post DONE.",
      ].join("\n"),
    ownership: [".morrow/research/**"],
  },
] as const;

/** Roles the partner workstreams take (a planner workstream already using one keeps it). */
export const PARTNER_ROLES: readonly string[] = PARTNERS.map((p) => p.role);

/**
 * How many workers a task should start with, so its agents have someone to talk to: 3 when 3 or more slots are free,
 * 2 when 2 are, else 1. Never above `maxAgents` (the plan's ceiling, which includes a "fewer agents" request).
 */
export function crewTarget(freeSlots: number, maxAgents: number): number {
  const want = freeSlots >= 3 ? 3 : freeSlots >= 2 ? 2 : 1;
  return Math.max(1, Math.min(want, maxAgents));
}

/**
 * Gives a one-workstream plan partner workstreams (review, then research) up to `target`, so its builder has peers to
 * talk to. They run in parallel with it (no dependencies) and own only their notes folders. A plan the planner split
 * already has peers and is left as it is.
 */
export function addPartners(plan: PlannerPlan, taskId: string, target: number): PlannerPlan {
  if (plan.workstreams.length !== 1 || plan.workstreams.length >= target) return plan;
  const taken = new Set(plan.workstreams.map((ws) => ws.role));
  const builders = plan.workstreams.map((ws) => `the ${ws.role} worker`).join(" and ");
  const added: PlanWorkstreamInput[] = [];
  for (const partner of PARTNERS) {
    if (plan.workstreams.length + added.length >= target) break;
    if (taken.has(partner.role)) continue;
    added.push({
      id: `ws-${partner.role}`,
      role: partner.role,
      title: partner.title,
      brief: partner.brief(builders),
      why: partner.why,
      branch: workstreamBranch(taskId, partner.role),
      dependsOn: [],
      ownership: [...partner.ownership],
    });
  }
  if (added.length === 0) return plan;
  return {
    ...plan,
    workstreams: [...plan.workstreams, ...added],
    rationale: cleanText(`${plan.rationale} Added ${added.map((a) => a.role).join(" and ")} partner${added.length > 1 ? "s" : ""} so the agents check each other's work as it happens.`, LIMITS.rationale),
  };
}
