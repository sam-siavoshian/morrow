# Several harnesses on one task

One task, one thread, several coding CLIs working on it at the same time, each on its owner's own subscription. The user picks which harnesses (Claude Code, Codex, opencode) and how they share the work.

The harnesses are `claude`, `codex`, `opencode`, `cursor` (Cursor Agent), `gemini` (Gemini CLI) and `grok` (Grok). The last three start through the node's `morrow-<cli>` shims (`BRIDGED_HARNESS` in `backend/src/integrations/relay/spawn.ts`), never under their own names: the Relay broker would set them up with the workspace key.

## The gap

What already works, end to end:
- **Split.** The composer sends a prompt. The planner (a headless Claude or Codex call on a teammate's VM) cuts it into up to three workstreams. Each workstream gets its own lease, branch, worktree and worker. The verifier merges every branch into `morrow/<taskShort>/integration`, opens one pull request and runs the tests; a conflict gets a resolver worker.
- **One conversation.** Every worker of a project talks in one Relay channel (`proj-<projectShort>`). Mission control filters it to the task's workers (`w-<taskShort>-...` names and leases), shows each sender with its harness icon and "ada's Claude Code", and has a message bar that posts to the channel or DMs one worker. So "one thread with several harnesses in it" already exists for split tasks.
- **Subagents** (`docs/subagents.md`, in progress): a worker hands a child job (a review, research, a test pass) to another CLI on the same VM.

What is missing:
1. **The user cannot choose the harnesses.** Pins are profile preferences. A small prompt is merged into one workstream by the planner, so picking Claude and Codex still runs one worker. `mode: "manual"` was enforced only in the browser's placement preview; it is now a rule the actor holds for the whole run (see Manual mode).
2. **No "same goal" run.** There is no way to have Claude, Codex and opencode each attempt the whole task and then compare. This is the main thing users mean by "several agents on one task": independent attempts, then pick the best. It also covers the original ask, "several agents analyze or review a codebase concurrently": each harness reviews, posts its findings in the thread, and nothing has to ship.
3. **Nothing to pick a winner with.** The verifier always merges every branch.

## Prior art: t3code

Checked in `pingdotgg/t3code` (details in "What t3code does" at the end). Short version: t3code can send one prompt to several models, but each one becomes its own thread and worktree with nothing linking them, and there is no compare or pick step. So we copy the fan-out (one branch per harness from the same base, one idempotent key per harness) and build the three parts t3code left out: a group that holds the attempts (the task), one shared thread, and a "pick one and ship it" action that settles the rest.

## Modes

| Mode | What happens | Status |
|---|---|---|
| **Split** | The planner divides the task; each workstream runs on the best free profile, or on the profile the user chooses for it in the plan card, so one task can run Claude Code on the API and Codex on the UI. Still the default. | Exists, harness mix new |
| **Compare** (the "same goal" mode) | Every picked harness gets the whole task on its own branch. They run at once. The user compares and picks one to ship, or finishes without shipping (review and analysis tasks). | New |
| Pair | One implements, the others review and test live. | Not in this version, see below |

Why not pair now: live review across machines needs the reviewer to see unpushed work on another member's VM. Workers never push; only the backend checkpoints, at DONE and handoff. Cross-machine pair would need periodic pushes of work in progress, a new outbox kind and a reviewer protocol. Same-machine pair is what subagents already give ("have Codex review each workstream before you finish" in the prompt). Compare plus subagents covers the cases users asked for with far less new surface.

TODO(saam): confirm pair stays out. Recommendation: yes, revisit once subagents ship and we see whether users ask for cross-machine review.

## What the user sees

### Composer

- A new first control in the footer: **Split** or **Compare**. Split is the default and changes nothing.
- In Compare, the composer shows a **harness picker** popover (Split has no agent count to pick: the planner sizes it): Claude Code, Codex and opencode, each with its icon, a count from the pool ("2 free", "None free", "Not connected") and a check when picked. At least two must be picked; at most 3 and never more than the team's `maxParallelPerTask` (a team capped at 1 cannot compare, and the send button says why).
- The profile picker still works: a pinned profile is preferred for its harness ("use ada's Codex, not linus's").
- The popover says the cost plainly: "2 agents run at once, each on a teammate's own plan. You pick the one to ship."
- On a 390px screen the footer shows the picked harnesses as icons only.

### Split: choosing the harness mix

The ask is one task with different harnesses at the same time, and that is not only Compare. A Split plan already sends explicit picks on Start (`StartTaskBody.picks`, re-validated by the actor), so no new model was needed: the plan card now lets the user choose them.
- Every starting workstream's worker is a menu: **Auto** (the score picks, as before) or any profile of the team, listed with its harness icon, owner and machine. Profiles that cannot take work are shown greyed out with the reason.
- Choosing a profile chooses its harness: "ada's Claude Code" on the API, "linus's Codex" on the UI.
- A chosen profile wins outright. If it cannot take the work (busy, limited, gone), the row says so and Start is blocked with "A profile you chose can't take its workstream right now. Choose another, or set it back to Auto." It never silently moves to another profile.
- The choice lives in the browser for the plan on screen. It is sent as `picks` on Start and nothing is stored.

TODO(saam): workstreams that depend on others start later and are placed by the scheduler, so they cannot be chosen in this version. Recommendation: leave it. If users ask, store a `preferredCli` per workstream in the actor and have the scheduler filter by it, the same way compare attempts are bound.

### Plan card

Compare tasks skip the planner call: there is nothing to split, and it saves a run on someone's subscription. The plan appears at once:
- Header "Compare · 3 attempts".
- One row per attempt: harness icon and name, branch `morrow/<taskShort>/<cli>`, and the profile that will run it (same placement preview as today, limited to profiles of that harness).
- Each row's worker can be changed within its harness (see Split above; a compare attempt only lists profiles of its own CLI).
- Start is blocked with a plain reason when a picked harness has no free profile: the row says "No Codex profile is free", the card "Not every harness in this compare has a free profile. Connect one, or wait for a slot." If Start is pressed anyway, the backend names the missing harness: "No ready opencode profile has a free slot. Connect one, wait for one to free up, or start a new task without it."
- There is no Re-plan or "Start with fewer agents" for a compare (there is no planner). Typing feedback and pressing Refine files a new compare with the same harnesses.

### Mission control

- The timeline is unchanged: one conversation, every attempt's messages with its harness icon and owner. The user writes to all of them (the channel) or one of them (DM), as today.
- A new **Attempts** bar above the timeline, only for compare tasks. One card per attempt:
  - harness icon, "Codex", "linus's machine", live status (Waiting for a worker, Working with elapsed time, Moving to another profile, Finished, Stopped);
  - when finished: its DONE summary, as text, clamped to three lines; the branch name opens the Branches tab;
  - **Pick this** on finished attempts (creator, owner or admin, the same rule as cancel and retry; others see the cards without actions). It always asks for confirmation: "Ship the Codex attempt? Morrow merges <branch> and runs the checks. Attempts still running stop now."
  - **Finish without shipping**: for review and analysis runs. Completes the task, ships nothing, stops anything still running.
- The bar's caption says where things stand: "Each harness is attempting the whole task", "An attempt is in. Pick it now, or wait for the others", "Every attempt is in. Pick one to ship."
- After a pick: the picked card says "Picked", the others show Stopped or Finished, and the usual verification (merge, pull request, tests) runs on the picked branch only.
- A compare task where every attempt has finished and nothing is picked is in the new status **Choosing**. It shows in "Needs you" for the task's creator ("Pick an attempt") and in the sidebar with its own status icon.
- The user can pick early: as soon as one attempt is done it can be picked, which stops the rest. No one has to wait for the slowest harness.

## Data model

Contracts (`packages/contracts`):
- `TaskStrategy = z.enum(["split", "compare"])`.
- `CreateTaskBody` gains `strategy` (default `split`) and `harnesses: CliKind[]` (default `[]`). Compare needs 2 to 3 distinct harnesses; split must send none. `maxAgents` is ignored for compare (it becomes the harness count).
- `TaskStatus` gains `choosing`.
- `PlanSource` gains `compare` (no planner profile, like `fallback`).
- `TraceKind` gains `task.attempt_picked` (a pick or a finish without shipping; the message says which and who).
- `TaskView` gains `strategy?: TaskStrategy` (absent means split, for tasks stored before this) and `pickedWorkstreamId?: Id | null`.
- `WorkstreamView` gains `harness?: CliKind`, present only on compare attempts, so split tasks pay no bytes in the view. `WorkstreamDetail` extends it, so it has the same optional field.
- `TaskView.pickedWorkstreamId` is only set on compare tasks for the same reason.
- `CLI_LABEL` (Claude Code, Codex, opencode, Cursor Agent, Gemini CLI, Grok) for backend text.
- New `PickAttemptBody { workstreamId: Id | null }` (null: finish without shipping) and `PickAttemptResponse { status: TaskStatus, releasedLeaseIds: Id[] }`.
- Refusals map to HTTP: `not_compare`, `task_terminal`, `already_picked`, `attempt_not_done`, `nothing_finished` are 409; `unknown_workstream` and `unknown_task` are 404.

Actor (`TeamWorkforce`):
- `Task.strategy` (`split | compare`, stored tasks without it read as split) and `Task.pickedWorkstreamId: string | null`.
- `Workstream.harness: CliKind | null`. Split workstreams are null.
- `createTask` takes `strategy`. `recordPlan` validates a compare plan: every workstream has a harness, harnesses are distinct, no `dependsOn`, ownership `**`, and the count matches what was asked (2 to 3, within `maxAgents`). A split plan must not set harnesses.
- `profileRejection` gains `wrong_harness`: a workstream with a harness only takes a profile of that CLI. This holds in `reserveWorkers` and `requestHandoff`, so no path (start, scheduler, handoff, retry) can put Claude on the Codex attempt.
- New `pickAttempt(taskId, workstreamId | null, byUserId)`, `@Atomic`, idempotent by key:
  - compare tasks only; not terminal; nothing picked yet;
  - with a workstream: it must be `done`. Every other live lease of the task is released ("another attempt was picked"), which also releases their subagents. Unfinished attempts become `failed`; finished ones stay `done` and keep their branch. `pickedWorkstreamId` is set and the task derives to `verifying`.
  - with null: the same releases, then `completed` with a verification of one skipped check, "Nothing shipped: the team kept the findings."
  - trace `task.attempt_picked`.
- `deriveTaskStatus` for compare:
  - picked: only the picked workstream (and the resolver, if a conflict opens one) count, so the usual `verifying` / `resolving` rules apply to it alone;
  - not picked: live attempts give `starting`, `running` or `handoff` as today; when no attempt is pending, active or in handoff and at least one is done, the task is `choosing`. It never goes to `verifying` without a pick.
- `retryTask` on a failed compare task re-verifies the picked attempt only. A failed compare task always has a pick (only verification fails a task), so it never reopens the losers.
- `cancelTask` works from `choosing` like any open state.

## Relay channel and timeline

- No new channel. The task's attempts post in the project channel like every worker, so the existing task filter, harness icons, owner labels, DMs and "Needs you" questions work unchanged.
- Agent names are `w-<taskShort>-<cli>-e<epoch>` because the attempt's role is its harness (`claude`, `codex`, `opencode`, `cursor`, `gemini`, `grok`). A reader of the raw channel can tell who is who.
- What changes is what the dispatcher says:
  - The **spawn brief** of an attempt says: you are one of N independent attempts at the same task; the others are listed with their branch, harness and owner; work only on your branch; do not merge, copy or review other attempts' branches; you may answer their questions; post short progress notes and findings in the channel; for review or analysis tasks put the findings in the channel and a summary in DONE; the team picks one attempt to ship.
  - The **`workstream_done` update** to the other attempts says "Codex finished its attempt" with the summary, without the "merge origin/<branch>" line split tasks get.
  - A **pick** sends one notice to the channel: "ada picked Codex's attempt. The other attempts are stopped." The released workers get the usual release.

TODO(saam): should attempts see each other's progress notes at all? Recommendation: yes. Watching them work side by side in one thread is the point of the feature, and the brief already forbids copying branches. A stricter "blind" mode can come later as a brief flag.

## Merging and picking

- Each attempt pushes its own branch at DONE exactly like a workstream (backend commit as the engineer, root push with the VM owner's token).
- Nothing merges before a pick. The verifier refuses a compare task without a pick (it never reaches `verifying` without one anyway).
- After a pick the verifier runs on the picked attempt only: its commit exists on GitHub, it merges into `morrow/<taskShort>/integration`, the pull request into the default branch is mergeable, the tests pass. A conflict with the default branch goes to the existing resolver with only the picked workstream involved.
- The losers' branches stay on GitHub, so the team can still read or cherry-pick them. Morrow does not delete them.
- No automatic pick in this version. The user picks from the summaries, the branch views and the conversation.

TODO(saam): run the project's tests on every finished attempt before the pick, so the cards can say "tests pass" or "2 failing". Recommendation: next version. It costs up to 5 minutes of VM time per attempt and needs a per-workstream check result in the actor; the pick flow does not depend on it.

TODO(saam): allow two attempts on the same harness (ada's Claude and linus's Claude)? Recommendation: no. Same model, same harness, little signal for double the usage.

## Pool and cap accounting

- Each attempt is a normal lease on a profile. It counts against that profile's `maxConcurrent`, shows in the pool meter, and its usage is read like any worker's.
- The team policy `maxParallelPerTask` caps the number of attempts: create refuses more harnesses than the cap with a plain message. Running and replacing attempts hold a slot, same as workstreams.
- The scheduler and `start` only place an attempt on a profile of its harness. Pins win within a harness. Placement still spreads attempts across machines when it can.
- A pick or a finish releases the other leases in the same transaction, so their slots and plan usage stop at once.
- Compare spends about N times the usage of a single run. The composer says so before Start.

## Manual mode

The composer's Auto or Manual toggle with its picked profiles (pins) is stored on the task. In Auto, pins are a preference: the score favors them, any eligible profile can still take the work. In Manual, only the pinned profiles ever take the task's work, and the actor enforces it, so a scripted API call gets no more than the UI.

- **Stored on the task.** `createTask` takes `mode` and `pins`. Pins are ids of this team's profiles, deduplicated, at most 5; an unknown one is refused in either mode (`unknown_pin`). Manual with no pins is refused (`no_pins`). A manual compare needs a pinned profile of every picked harness (`harness_not_pinned`). Tasks stored before this read as Auto with no pins; no schema bump, since a missing field row reads as absent.
- **Changed only before start.** Refine and Start carry the composer's mode and pins as the person sees them and replace the task's (`setTaskWorkforce`). Once any worker was placed the actor refuses (`task_started`, 409), so a running manual task can never be widened.
- **Every lease is checked in the actor.** In Manual, a profile that is not pinned is refused with `not_pinned` inside the `@Atomic` methods: `reserveWorkers` (start picks, scheduler placements of dependent and waiting workstreams, the merge-conflict resolver, compare attempts), `requestHandoff` (replacements), `beginPlanning` (the planner run) and `delegate` (subagents). An invariant check also fails any transition that would leave a live lease of a manual task on an unpinned profile.
- **The backend only offers pins.** Start, retry, the scheduler and the planner filter candidates to the pins in Manual (`placementPool`). A manual handoff may go back to the same pinned profile once it is eligible again, so a task with one pin does not stall for good after a cooldown.
- **Waiting, said plainly.** When a ready workstream or a handoff has no free pinned profile, the scheduler asks the actor to note it, and the trace shows a `worker.waiting` entry: "Waiting for a pinned profile: none of them is free. "API" starts when one is." It is noted once per wait. Nothing falls back to an unpinned profile.
- **Every pin removed mid-run.** The workers on them expire as for any removed profile, the workstream goes to handoff and waits, and the note says so: "Waiting for a pinned profile: all of them were removed from the team. ... cannot start until the task is cancelled and started again with other profiles." Cancel works as usual.
- **Subagents.** In Manual, a worker's `SUBAGENT_OPTIONS` lists unpinned CLIs on its machine as "not one of the profiles picked for this task", and a `DELEGATE` to one gets the usual could-not-start reply: "Codex on your machine is not one of the profiles picked for this task, so it cannot take work here."
- **View budget.** Mode and pins live in actor storage and on the backend's internal task record only. The browser's `TaskView` and `TaskDetail` do not carry them; the composer already holds the person's choice.

## Failure handling

- **An attempt hits its plan limit, crashes or its CLI signs out.** The existing path runs: the profile cools down, the lease expires, the attempt's worktree is checkpointed, and the attempt goes to handoff. The replacement must be the same harness on another profile (another member's Codex, for example). The other attempts keep going untouched.
- **No other profile of that harness is free.** The attempt waits in handoff. It does not fall back to another harness: that would turn a compare into two runs of the same CLI. The cards show "Waiting for a free Codex". The user can pick any finished attempt meanwhile, which releases the waiting one.
- **An attempt keeps failing** (3 failed starts or 8 handoffs): the scheduler stops scheduling it, as for any workstream. The task does not reach `choosing` while it is open; picking another attempt or cancelling ends it.
- **Every attempt but one fails to start for good.** The user picks the one that finished.
- **Two people press Pick at once.** The actor applies the first; the second gets a 409 "An attempt was already picked."
- **A pick races a DONE.** The pick needs the attempt to be `done` in the same transaction, so picking a still-running attempt is refused (409 "That attempt has not finished yet").
- **The backend restarts.** Everything lives in the actor: strategy, harness per workstream, pick. The scheduler resumes from the stored state.
- **The compare plan cannot be recorded right after create** (actor down). No planner would ever record it later, so the backend retries once with the same key, then cancels the task and answers 503 "Could not start the compare task. Try again shortly." No task is left in `planning`.

## Security

- Every attempt is a lease on one profile, spawned on that profile's VM as its owner's Linux user, through the CLI the owner already signed in. No login, token or CLI home moves between machines or members. The harness binding only narrows which profile can take the work.
- Branches are pushed by root on the attempt's own VM with that VM owner's GitHub token, as for any workstream. Verification uses the task creator's token, as today.
- `POST /api/teams/:teamId/tasks/:taskId/pick`: session, CSRF, team membership (404 for outsiders), the `mutations` rate limit, and creator, owner or admin only (it stops teammates' workers and decides what ships). The body is zod-validated; the workstream id must belong to that task, checked in the actor.
- `harnesses` is an enum list, deduplicated and bounded. The prompt is untrusted text exactly as before; the compare plan quotes it into the brief the way the fallback plan does.
- Summaries and messages from attempts are agent-written text. They are cleaned, clipped and rendered as text, never HTML, like every other agent text.
- A Split choice in the plan card is only a pick sent on Start. The actor re-checks it like any pick (eligible, free slot, scope), so a crafted request gets no more than choosing in the UI would.
- `mode: "manual"` is enforced by the actor on every lease of the task (see Manual mode). Pins are validated as this team's profiles, and the browser-sent placement is never trusted: a crafted start, refine or pick on an unpinned profile is refused with `not_pinned`, and the pins cannot change after start.

## Tests

- **Contracts:** `CreateTaskBody` accepts split with no harnesses and compare with 2 or 3 distinct ones; refuses compare with 0, 1, 4 or duplicates, and split with harnesses. Old `TaskView` without `strategy` still parses.
- **Actor** (real Terse, `DURABLE_ACTORS_TEST_DOCKER=1`):
  - compare plan recorded; bad compare plans refused (duplicate harness, `dependsOn`, missing harness, split with harness);
  - `reserveWorkers` and `requestHandoff` refuse `wrong_harness`;
  - status: running while attempts run, `choosing` when all ended with one done, never `verifying` without a pick;
  - `pickAttempt`: happy path releases the others and goes to `verifying`; refuses running attempt, split task, second pick, unknown workstream, terminal task; finish without shipping completes and releases; idempotent replay;
  - pick releases a loser's subagents (cascade);
  - retry of a failed compare task re-verifies only the pick;
  - restart keeps strategy, harnesses and pick;
  - view budget still holds with compare tasks at their limits.
- **Backend** (real Terse, fake ports):
  - create compare records the plan with no planner call; refuses over the policy cap; refuses replan;
  - start places each attempt on its harness, refuses when a harness has no free profile;
  - scheduler handoff picks the same harness and waits when there is none;
  - verifier on a compare task merges only the picked branch;
  - pick route: authz (creator, admin, plain member refused, outsider 404), 409s, validation;
  - attempt brief says independent attempts and lists the others; the `workstream_done` update has no merge line for compare.
- **Manual mode:** actor unit tests (`actors/test/manual.test.ts`) and real-Terse tests (`actors/test/manual.integration.test.ts`: refusals on every path, a 10-way reservation race, pins changed racing a start, every pin removed, the waiting note across a restart, and a task stored before modes loading as Auto); backend tests (`backend/test/orchestration/manual.test.ts`: create validation, start refusals, scheduler filtering and the waiting note, handoff to a pin or the same pin after cooldown, every pin removed, refine and start carrying the choice, subagent refusal); scoring units for `placementPool`, partial picks and `allowSame`.
- **Web:** strategy and harness controls (state, availability, cap), placement for compare, attempt cards (status, pick, finish), sidebar and "Needs you" for `choosing`, hostile summary text renders as text.

## Not in this version

- Pair mode across machines (see Modes).
- Automatic winner pick and per-attempt test runs before the pick.
- Two attempts on the same harness.
- Model choice inside a harness (for example Opus versus Sonnet on one Claude login).
- Splitting the task and then racing each workstream (compare inside split).
- Deleting the losers' branches.
- Harnesses other than Claude Code, Codex, opencode, Cursor Agent, Gemini CLI and Grok.

## What t3code does

Read through Nia from `pingdotgg/t3code`; no t3code code was run.

- **One provider per turn.** A thread can switch provider between runs (`AppThread.defaultProvider`, `Run.provider`, plus a `ContextHandoff` summary for the provider that missed runs, `docs/orchestration-v2/provider-switching-and-context.md`). A thread has one active run. A new message steers it or queues after it (`feature-lifecycles.md`, `queue_after_active`). Several providers never work in one thread at the same time.
- **Fan-out without a group.** `docs/user/thread-sidebar.md`: "To send the same prompt to several models... Each selection starts a separate thread and worktree." The code is `apps/web/src/components/chat/useMultipleModelSend.ts`: one background thread per model, each with `prepareWorktree({ baseBranch, requireWorktree: true })`. It runs in the browser only, and no id links the sibling threads.
- **No compare or pick.** Nothing compares the siblings' results or picks one to ship. Results go out through each thread's own pull request.
- **Children inside the parent.** A delegated child is a timeline row in the parent with the provider logo and a status dot (`V2LifecycleRow.tsx`, `SubagentAvatar`). The user talks only to the parent; a child's question goes to its parent. Stopping a parent stops its children. Children get the task prompt, not the parent's conversation.

What we take:
- **One branch per harness from the same base, and one idempotent key per harness.** Our attempts are workstreams, each with its own branch, worktree and lease.
- **The harness logo and live status on every attempt.** Attempt cards and timeline rows use the existing harness icons and status dots.
- **Prompt-only context.** Each attempt gets the task, not another attempt's conversation.
- **Settle the rest when one wins.** A pick releases the other attempts, like t3code's stop cascade.

What we add that t3code does not have: the attempts share one task, one thread and one timeline, and a pick turns one attempt into the pull request.
