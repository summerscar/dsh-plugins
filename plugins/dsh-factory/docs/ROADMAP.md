# dsh-factory roadmap

> Status date: 2026-11-15. This document is for anyone taking over the project: after reading it you should be able to judge on your own what it can do today, what comes next, and why it was decided that way.
> The **reasons** behind each design choice live here, so they do not have to be argued again. For implementation details read the source; for how to run things read the repository's own `AGENTS.md` and per-directory conventions.

## 1. What this plugin is for

Turn one piece of work (a GitHub issue) into a reviewable pull request, with every step carried out by its own agent session, and a person only approving at the gates that matter.

Three points that are not negotiable:

1. **One card = one dedicated session + one dedicated working tree.** Cards never share a working directory, and never share dependencies.
2. **commit / push / opening a pull request is always approved by a person.** The plugin may prepare everything automatically, but it never pushes changes out by itself.
3. **Multiple projects are first-class.** Each project has its own root path, boards, cards and configuration, and they do not interfere with each other.

The long-term goal is "discover issues on a schedule → analyse → develop automatically → deliver a draft pull request", but **merging always stays with a person**.

## 2. What it can do today (2026-11-15)

### 2.1 Data and boards

- Three levels: **project → board → card**.
- A card's lifecycle has 8 statuses: `inbox` / `triage` / `plan` / `plan-review` / `build` / `review` / `done` / `canceled`.
- Every transition records who made it (person / agent / automatic rule) and is auditable globally.
- The inbox is a data status shown separately in the interface; it does not take a board column.

### 2.2 Dispatch and working trees

- Dispatching a card creates a **git worktree** on branch `factory/<cardId>`, and the session's working directory is that worktree.
- **Worktree isolation is mandatory and has no off switch**: every project and every autonomy level works inside a worktree. The reason is that editing directly in the project root pushes the wrong branch, drags in uncommitted changes, and makes it impossible to tell which changes the approval gate is approving.
- After the worktree is created, a project may run its own preparation steps:
  - `copyFiles`: copy locally ignored files from the project root (such as environment files) into the worktree;
  - `postCreate`: run a preparation command the user supplied, inside the worktree.
  - Neither ships a default: what to install and what to verify is decided by the target repository's own conventions. If either step fails, the whole dispatch rolls back (the worktree and branch are removed and the card stays in the inbox).

### 2.3 Stage continuation (three-level fallback)

A card passes through several stages; each needs a new agent session, but must reuse the same worktree and branch. Continuation falls back through three levels, recording each step instead of doing it silently:

1. **The session is still live** → append to the same session (cheapest);
2. **The session ended but its history is on disk** → resume from the persisted session, with full context;
3. **The history is unusable** → create a new session, inject a history digest, and record the fallback on the card.

Failure handling: a failed continuation only releases the claim. It does not change the card's status, does not delete the worktree, and can be retried.

### 2.4 Circuit breaker

A card that fails dispatch repeatedly up to the threshold (currently 3) is marked stalled and stops retrying automatically, waiting for a person.

### 2.5 Approval gates

- **Commit** and **push branch and create PR** are two separate human actions; without approval there is no git write at all.
- Automatic modes may reach a draft pull request, but **never merge**, never mark done, and never escalate permissions on their own.
- Pushing to a protected branch is refused, an empty diff is refused, and it never force-pushes.

### 2.6 Project creation assistant

- A read-only analysis tool: it reports objective facts about the target repository (root files, directories, ignore rules, manifest files, the declared package manager) and **returns no conclusion about which command to run**.
- A creation tool: registers a project directly. Creating one is local, reversible configuration — it performs no git write. It **drops any `copyFiles` entry the git index already tracks** — a tracked file is already in a fresh worktree, so copying it is redundant; this is a deterministic guard, not a matter of model judgement.
- The `/factory add [path]` command is only a **trigger**: it hands the intent to the agent, and the `factory-add-project` skill guides the agent to analyse the repository, propose a configuration, and then create the project. Without a path it uses the current session's working directory.
- A project root **may** live inside the data root (some of the user's repositories do): it is registered with a warning, but it is **never** used as a session cwd, and its worktree is forced outside. Verified on a real machine (V2b).
- `GET /api/dsh-factory/status` exposes `toolsRegistered`: tool registration used to degrade silently (the command and the API both succeeded while the agent had no tools to call), and this is now an objectively readable signal.

### 2.7 Skills

Seven: six phase skills (triage / plan / build / self-review / review / rereview) plus one project-add skill. The phase skills line up one-to-one with the transitions an agent is allowed to make in the status machine.

## 3. Decisions already settled — no need to reopen them

| Decision | Reason |
|---|---|
| Worktree isolation is mandatory, no off switch | Turning it off means working directly in the project root: wrong branch, uncommitted changes dragged in, and no way to bound which changes the approval gate covers |
| Isolation uses git worktrees, not separate clones | The two are equivalent on "independent dependencies, local files must be copied"; worktrees are created in seconds, the remote is correct by construction, and they do not pile up extra workspaces in the sidebar |
| No attempt at a real container sandbox | The host environment has no container capability, so the isolation on offer is "restrict where writes may land"; we do not pretend it is strong isolation |
| A new session per stage with a history digest, rather than one session throughout | Review must be independent: reviewing your own work breaks injection defence and review discipline |
| Plan approval and delivery authorization stay with a person | This is the product's safety floor; it is not made configurable |
| Automatic modes go no further than a draft pull request | Merging permanently stays with a person |

## 4. What comes next (in priority order)

### P1 — End-to-end verification on a real machine (**done**, 2026-11-15)

The full `/factory add` chain — command → agent → skill → tools → the project appears on the board — **has been run on a real machine and converged in six rounds.**

- Acceptance (final form, seven groups): **V0** tools are registered (read `toolsRegistered` from `GET /api/dsh-factory/status`, never the agent's own account); **V1** bare `add` (the session cwd must be a real git root **outside** the data root — an environment constraint, not a plugin policy); **V2a** `add` with a path outside the data root; **V2b** `add` with a repository **inside** the data root (registered + a `warning` + the worktree lands outside the data root); **V3** the agent really called the tools **and the calls succeeded** (not the command creating the project itself, and not the agent falling back to something else after an error); **V4** the proposal is justified, every `copyFiles` entry is untracked, and no command is baked into the plugin; **V5** the project appears on the board and the repository files survive deletion.
- Evidence: judge "it really got created" by the project count going from 0 to 1, not by the agent's own account; force-refresh before screenshotting so stale front-end assets cannot fool you.
- Six-round ledger (the first five were all real failures; none was a problem with the tests):

| Round | What blocked it |
|---|---|
| 1 | `package.json` declared no `@deepseek-ai/dsh-tools` peer → the host loader never injected it, the `import` always failed, and all six tools were unregistered |
| 2 | Tools returned `warning: undefined` → failed the host's lossless-JSON check, so every call on a repository outside the data root failed |
| 3 | All six tools' `render` returned a string → violated the `ContentBlock[]` contract, `content.some` crashed downstream, all six tools were unusable |
| 4 | `copyFiles` listed files already tracked by git → model judgement drift; replaced with a deterministic guard that drops tracked entries by git index |
| 5 | Packaged skills passed no `source` → the host does not fill it in, so all seven skills failed to register on a real machine |
| 6 | All green: the skill genuinely took effect (the trace showed the skill loading, and the agent ran `git check-ignore` itself), and all seven acceptance groups passed |

The first four (peer / serialization / render / skill `source`) were each "the plugin is simply unusable on a real machine" level and are all fixed. Round 4 no longer relies on the agent behaving: `factory_create_project` drops `copyFiles` entries that the git index already tracks, and round 5 proved the guard fires (the agent passed four tracked files, all were dropped, and the stored `copyFiles` was empty).

### P2 — Autonomy engine (L1 **implemented and committed**; real automatic dispatch still to be verified)

The `autonomy` / `autoStart` / `autoApprove` fields used to hold storage and write validation only, with no code reading them to make a decision. **The L1 engine has landed** (`autonomy.js`):

- **One plugin-level timer**, hosted on the host's timer service and torn down with the plugin; a missing service never degrades silently — the reason is readable in `status.engine.timerReason`. Multiple projects are enumerated each tick, not given a timer each; ticks are single-flight and never overlap.
- **L1 takes exactly one automatic edge**: `inbox -> triage`, through `dispatchCard`, recorded as `autoRule` with `tier` / `rule` / `channel`. Stage advancement still belongs to the in-session skills acting as `agent` — **the engine never moves a card itself**; the chain stops at `plan-review`.
- **`autoApprove` is never read in L1**: even `L1 + autoApprove=true` stops at `plan-review`, which blocks the "the field is on, so the code might as well use it" overreach.
- **Two concurrency ceilings** (per project plus a global backstop), counted by live sessions rather than the `sessionId` field; when full, cards queue without being dropped or marked stalled, and a later tick picks them up once a slot frees.
- **Pause / resume / per-card takeover** are three separate actions, each persisted and each leaving a governance record. Pause and takeover both **leave running sessions alone** and only affect later ticks — killing a session outright would leave a worktree and half-finished changes behind.
- **Zero side effects by default**: `L0` does strictly nothing; a project missing its issue source or target board is skipped with the reason visible in `status` — **no guessing, no reverse-engineering the git remote, no creating a board automatically**.
- **Sync does not approve for you**: `sync.js` uses a separate `syncRule` actor plus an empty `SYNC_AUTO_EDGES` allowlist, so under L1 a remote "PR closed" suggestion is only recorded for a human and never pushes a waiting card into `build`; the `autoRule` semantics stay reserved for L2.
- **The permission level is never overclaimed**: `permissionEnforced` is always `false`, and neither the interface nor the status may claim write restriction is in force.

**Verification status**: offline cases plus four real-machine checks (the `status.engine` fields, pause/resume, the takeover route, the audit route) are done; **real automatic dispatch (AE-2) is not verified end to end**, see §5.

### P3 — L2, fully automatic to a draft pull request (not started)

Let the machine press "approve plan" and "arm the delivery authorization" for a person. This is **a round of its own**, because it changes the model of where approval comes from (today the approval source is hard-wired to a person) — the highest-risk cut in the plan.

- Boundary: reuse the existing approval gate, open no bypass; draft pull request; no merge, no marking done.

### P4 — Autonomy-level interface (not started)

Settings page, status badge, pause/take-over. **Prerequisite**: the engine behaviour must land first, otherwise these are dead switches.

- Hard requirement: the interface must read the level field, **never the two booleans** — "level is back to manual while a switch is still on" is a legitimate combination, and judging by the switches would display "running automatically" while the engine does nothing.
- Hard requirement: a failed save must show the user the original error; never swallow it.
- Hard requirement: after a level is silently normalised (on the new-project path), the interface must show the normalised value.
- Hard requirement: preparation config and autonomy level are **two separate blocks, saved separately** — the backend does not accept both kinds of field in one write.

## 5. Known gaps (do not mistake it for complete)

| Gap | Impact | Note |
|---|---|---|
| **No transaction boundary between a write and its receipt** | A tool runs `execute` (the write has already landed) and only afterwards snapshots, lossless-checks and renders; a failure in any of those steps becomes "the write happened but the call errored", and the receipt is lost. On a real machine this showed up as duplicate same-named projects, with the agent correctly not retrying and the user never learning the project exists | Not fixed in P1 (fixing `render` removes the symptom, not the structure). **L1 works around it with four measures**: idempotency (a card that already has a session/worktree is never dispatched twice), single-flight (ticks never overlap), orphan reconciliation (report only — no cleanup, no rebuild), and reusing `dispatchCard`'s existing rollback on failure. These four must be confirmed by QA running PRD's AE-9; Dev's in-memory self-check does not count. **The structural fix is still mandatory before L2**: either evaluate `render` before the write, or roll the write back on failure — dispatching is far heavier than creating a project, and the same window would leave worktrees and sessions behind |
| **`card.repo` has two meanings** | `intake.js` writes a GitHub repository identifier into it, while `session-context.js`'s `repoOf` treats it first as a local path when building session context. L1's automatic card creation is the first time this path is exercised frequently | **Must be unified before L2**: decide whether the field is a remote identifier or a local path — split them or rename one; never hand the agent a `repo` that cannot be used as a path. Checked this round but left unchanged; recorded as debt per PRD §10 |
| **L1's real automatic dispatch (AE-2) is not verified on a real machine** | The code and offline cases cover the logic, but the end-to-end chain — real GitHub issue source → card created → dispatched automatically → stops at plan-review — **has never run on a real machine**, because it needs a real issue source and board | **Not to be counted as passing.** Must be verified once a real environment is available; use a temporary `DSH_HOME` then and create nothing inside the user's real data root. Same cause as the P1 lesson: offline green is not real-machine green |
| **No interface entry point for takeover** | `POST /cards/:id/takeover` is reachable over HTTP only; `client.js` has no button. Same class as "no interface entry point to delete a project" | Belongs to the P4 interface |
| **Confusing route name** | The real path is `/cards/:id/takeover`, not `/take-over`; guessing 404s (QA hit this on a real machine) | Asked Docs to state the real path in the README's interface notes |
| **Agent behaviour drift (under observation)** | In rounds 5 and 6 the agent asked for confirmation on a card before creating the project; in rounds 1–3 it created directly. No acceptance criterion forbids asking, and the project was created either way | Read as normal behaviour once the skill takes effect (the skill body says to show the config first), not a defect. Recorded here for observation so P2 does not discover an agent that asks about everything |
| GitHub only | The GitLab skills are not implemented | Add them when there is a concrete need |
| No webhooks | Issues are discovered by polling | Good enough for a single machine |
| Single machine, no multi-replica coordination | The concurrency lock is only valid inside one process | Not a problem for the current use case |
| The session permission level does not actually apply | A permission is passed at dispatch, but the host side is not wired up yet | Write restriction in the worktree is currently by convention, not enforced |
| Branch names are bare identifiers | Harder to read during a human review | A pure improvement, not a blocker |
| Inbox discovery is manually triggered | Scheduling belongs to P2 | — |
| No interface entry point to delete a project | Deleting requires the HTTP endpoint (`client.js` makes no DELETE call) | Belongs to the P4 interface |
| Deleting a project leaves its worktree behind | `deleteProject` removes the registration only; the directory stays under the worktree root | Low impact; handle it with P4 |
| **README overstates a card's control over its repository (existing doc/code mismatch)** | Both READMEs say "a card can override the repository it runs against", but `createWorktree` at `dispatch.js:112` uses `project.rootPath`, and `card.repo` has **never** affected the repository actually worked on — it only affects the repository identifier injected into session context. Unrelated to this field split; an existing false statement | **Docs to fix**: after the `repoPath` split, state it accurately — a card can override the **repository identifier / path hint injected into the session**, while the worktree is still decided by the project root. Remove this row once done |
| **Intake's fetch count is hardcoded to `--limit 100`** | `intake.js` hardcodes the cap, and dedupe only compares against existing cards. Pointed at a busy upstream with many issues, one tick can flood the board with up to 100 cards, which the engine then dispatches one by one within its concurrency limit — each spawning a real agent session | **Fixed this round**: becomes a per-project `intakeLimit` (default 100, backwards compatible), passed by the engine tick into `intakeIssues`. A real product gap, not a test workaround. Counted as fixed once QA verifies "set to N creates only N" and "unset still defaults to 100" |
| **Intake has no label filter** | It can only fetch "all open issues"; it cannot fetch only issues with a given label, so combined with a busy upstream it can still pull in a lot of irrelevant issues | Kept as a gap; not this round (a separate feature from `intakeLimit`, do not conflate). `intakeLimit` can cap the volume as a stopgap |

## 6. Research basis (summary, so it is not researched twice)

This plugin does not fork any existing implementation. It compared two reference implementations and took the best of each:

- **Reference A (a kanban-style plugin)**: mature at binding each card to its own session, treating a column move as a stage instruction to the agent, worktree isolation with a dirty check before cleanup, and a background trio (watchdog breaker / cost metering / scheduled jobs). But it **supports only one project root**, and has no plan-approval gate.
- **Reference B (a factory-style framework)**: a multi-source delivery platform of project → board → stage, with an explicit "plan → submit for approval → build" gate and independent review discipline. The cost is that its logic is compressed into a very large runtime dependency and hard-bound to external databases, queues and sandbox vendors.

Conclusion: **take the skeleton from A** (card = own session, worktree isolation, watchdog), **the gate and review discipline from B**, and **build multi-project support ourselves** (A cannot do it, and B's way of doing it is too heavy for a single machine).

## 7. How to contribute

- Read the conventions at the repository root and in the plugin directory before touching code.
- Before changing anything, confirm which priority it belongs to; until P1 is done, new features queue behind it.
- Any change that performs a git write must go through the human approval gate; tests must not bypass it.
- Tests are maintained by a dedicated owner and are not self-certified; numbers come from an actual run, never from "it looks like it runs".
- **Any test that touches the data root injects a temporary `DSH_HOME`**: point it at a directory under `tmpdir()`, then restore the original value and delete it. Never write the real data root, and never sidestep with `skip` — the data-root lookup is lazy, so changing the environment variable inside the process takes effect immediately; the cases really run, which covers more than skipping them would.
