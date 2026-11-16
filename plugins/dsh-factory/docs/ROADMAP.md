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
- **L1 takes exactly one automatic edge**: `inbox -> triage`, through `dispatchCard`, recorded as `autoRule` with `tier` / `rule` / `channel`. Stage advancement still belongs to the in-session skills acting as `agent` — **the engine never moves a card itself**; the chain stops at `plan-review`. **This is intent, with two implementation preconditions**: ① the dispatch message must name the current stage's skill (fixed and committed); ② a started session must actually load that skill and call factory tools to advance. Step ② is **not verified on a real machine** — the session starts but stalls at `triage`. Four real-machine runs ruled out caching, skill guidance, preset / `skill` tool, and inlined skill body one by one; the cause is no longer in the prompt layer but points to "the dispatched session itself does not execute" (model routing / execution mechanism to be investigated), see §5. Until that is fixed and verified on a real machine, "advancement by in-session skills" remains an expectation, not a verified fact.
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
| **【SECURITY】Dispatched sessions get `danger-full-access` by default; the worktree sandbox does not apply (found on a real machine)** | During real-machine verification the user observed the dispatched agent "could not find its worktree" and browse the **filesystem visible on the host**. Mechanism (Dev traced through the source): `meta.cwd` is written by `sessions.prepare` into `header.cwd`, which **is exactly the `workspaceRoot` of the `workspace-write` sandbox** (`sessionWorkspaceRoot()` in `dsh-sandbox-policy`); bash resolves that policy from the calling session and `confine()`s with it. So **cwd really is the boundary** — not "only a starting directory" — and bash runs as a child of the harness process **inside the container** (bubblewrap file isolation), not on the other side of the mount. The only switch that removes the boundary is the mode: under `danger-full-access`, `dsh-bash-sandbox` calls `super.execute()` with **no sandbox at all**. This profile sets `permission-presets.defaultPreset: danger-full-access` (`approval: never`), and `dsh-permission-presets` pins that preset onto **every new session** in the `agent/created` event via `pinInitialPermission` — that is where the mode comes from, taking precedence over base patch's `defaultMode: workspace-write`. The factory's `project.defaultPermission` is `workspace-write` by default (`store.js`) but, **like `model`, is dropped in `createSession` and never passed to `agents.create`**, so dispatched sessions are pinned to the profile default and run unsandboxed | **A security gap, higher priority than functionality**. The host was checked: the workspace volume's `git status` is clean, HEAD unchanged, only `.git/COMMIT_EDITMSG` and `.git/index` changed (our own commits), nothing pushed; **this proves it looked at paths, not that it wrote anything**. Actions: engine paused, test project removed, all counts zero; **no further real-machine auto-dispatch until fixed**. Fix (Chief's call, timing confirmed by Dev, no longer "to be determined"): ① **include a `sandbox/mode: workspace-write` event in `createSession`'s `seed`** — `agents.create` runs "seed → setup → announce (`pinInitialPermission`)" in that order, so once the seed is written `pinInitialPermission` sees `sandbox !== null` and skips `setSandboxMode`, **with no timing race**. **Why seed over pre-empting in `setup`**: seed is a construction argument whose semantics are "initial events"; it does not depend on "getting in before a callback", so a host reordering cannot break it (timing dependence is fragile). ② **Whichever path is used, read back the `sandboxMode` session projection after creation and verify it** (registered by `dsh-sandbox-policy` under key `sandboxMode`) — if it is not `workspace-write`, dispose the session and throw, going through `dispatchCard`'s failure rollback; this is the hard guarantee, avoiding "wrote the event so assume it took effect" and covering host version/config differences in folding logic. ③ **The permission ceiling for automatically dispatched sessions is `workspace-write`, even if the project is configured higher** (automated dispatch must never have full rights; `project.defaultPermission` is wired in but capped at this ceiling); ④ move the worktree root to `/workspace/.dsh-worktrees` (inside the sandbox and directly visible in the UI). ⑤ **Sessions created before the fix** (no `sandbox/mode` event, possibly pinned to the profile's full-access default) are **refused and rebuilt on fallback** — already implemented, not a to-do: both level 1 `followupSession` and level 2 `resumeSession` go through `assertSandboxMode`; a level 1 refusal no longer strands the card but falls through, and a level 2 refusal disposes the session and throws so `continueCard` drops to level 3, which rebuilds a fresh session through `createSession`'s seed gate with `workspace-write`, recording the fallback on the card. Old full-access sessions are therefore never reused and need no manual cleanup. Also recommended to the user: change the profile's `defaultPreset` to `workspace-write` — **this affects sandbox protection for every ordinary session in their UI**; must be confirmed with the user separately and is not bundled with the factory fix; do not change their permission config unilaterally |
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
| **The dispatch message used to name no stage skill (fixed)** | `session-context.js`'s `firstMessage` / `sectionText` originally contained no mention of `skill` — they only said "advance with `factory_transition_work_item`", never "follow the `factory-triage` skill". By contrast `/factory add`'s `buildAddIntent` names its skill explicitly | **Fixed**: both messages now name the current stage's skill (`inbox`/`triage→factory-triage`, `plan→factory-plan`, `build→factory-build`, `review→factory-review`; none for `plan-review`/`done`/`canceled`) and say to load it first; committed. **Note: fixing this did not make AE-2 pass** — the next row is a deeper, unresolved problem |
| **Automatically dispatched sessions start but never call factory tools (AE-2 not verified; root cause traced to source lines)** | Four real-machine runs; in each the host `build` was confirmed current and the first half of the chain worked (card created / dispatched / `inbox→triage` / auditable / no push or PR), yet the session stayed at `triage` with `sessionTurn=1` and `report=null`, never called `factory_transition_work_item` and never reached `plan-review`; the engine's `lastError:null` and no orphans | **Root cause (Dev traced to source lines; Chief accepted)**: `dispatch.js`'s `createSession` does not destructure or use `model` (`dispatch.js:334`, its own comment admits "not yet wired") → `agents.create` is given no `agentOptions`, and agent-loop fills in `{}` (`dsh-agent-loop:1706`) → `assertAgentOptions({})` only validates maxTokens and permits it (`1264-1266`), so the session is created without error → `preStep`'s `model.current()` returns undefined and throws (`684-685`), silently swallowed by `kick()`'s `catch(_error){}` (`667`) → the observable result is "turn=1, nothing done, no error reported". **Ruled out across four runs**: ESM caching, missing skill guidance, preset / `skill` tool, inlined skill body (`.26` still changed nothing). **User-defined model semantics (a product decision, not open)**: dispatched sessions default to the DSH default model (`agentDefaultModel.currentSelection()`); a project-level `defaultModel` is the override, and the UI will offer manual selection later. Fix = option **B** (Chief's call): the port reads `agentDefaultModel` via `ctx.get`, builds `agentOptions` in the host UI's getter form (**read fresh on every access, no caching** — to stay isomorphic with the host UI; `currentSelection()` has no side effects, and the extreme race of config changing between reads self-corrects next turn, so this is not a design flaw); a set `project.defaultModel` overrides the `model` part, otherwise the host default is used; `createSession` actually wires `model` through. **Fail-fast criterion**: probe `currentSelection()` once before building `agentOptions`; if `provider` or `model` is unavailable, **throw immediately**, go through `dispatchCard`'s failure rollback and record the reason on the card — turning "silently stalled at triage saying nothing" into "dispatch failed with a readable reason". Do not rely on the host's `kick()` `catch(_error){}`, which swallows in-session errors. **AE-2 stays "not verified"** until this is fixed and verified on a real machine |
| **Real sessions started by a dispatch cannot be terminated on demand (known, uncleanable)** | Four AE-2 real-machine runs each started a genuine agent session (ids: `d726dd75…`, `4d5d6911…`, `6ab382b7…`, `e8a6a538…`); after the test project is deleted the engine will not dispatch them again, but they may remain idle in the host's session list. The `sessions` API is unavailable, so the plugin cannot terminate them | **The actual cost of starting a real session**, not a bug. A real-machine verification's cleanup must honestly record "an idle session may remain" with its id — do not let it become a mystery next time, and do not claim the sessions were terminated just to make cleanup look clean |
| **【TEST FIXTURE】An empty fixture repo produced the false signals "agent does not report back" / "agent works outside the worktree"** | Real-machine verification once used a minimal repo containing only an empty README and a single init commit as the project root; the worktree was created from it and therefore had **no source matching the card's issue**, while the card described a real upstream issue. The agent reasonably cloned the real source under a temp dir to investigate, and that was misread as "ignoring the worktree" and "not reporting back" | **Not an agent behaviour defect — a mismatch between the test fixture and the task content.** Across several runs, every "the agent is broken" conclusion traced back to the environment or configuration: preset not mounted, workdir deleted too early, empty worktree. The skill body itself requires "work only inside worktreePath" and never points to a temp dir. **Consequence**: verifying "report back" or "stays in the worktree" with an empty fixture yields conclusions that do not hold; AE-2 is still not genuinely verified, partly for this reason. **The next real-machine run must use a repo whose content matches the task** (with the relevant source), see §7 |

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
- **For "a session does not respond", confirm the agent is actually reasoning before editing the prompt**: two of AE-2's four runs went into prompt changes (skill guidance, inlined skill body) with zero change in real-machine behaviour; the cause was further downstream (model routing / execution mechanism). Investigate in this order: confirm the new code is in memory (`build`) → whether the session produced another turn → whether any tool was called → whether model routing is wired → only then prompt content. Changing prompts before the first four checks is burning real sessions to guess.
- **Real-machine verification must use a repo whose content matches the task**: point the project root at a repo that actually contains the source the task concerns — never a minimal repo with only an empty README. The worktree is created from the project root; if the root has no code, the agent can only clone the real source elsewhere to investigate, and any conclusion about "stays in the worktree" or "reports back" is invalid — and gets misread as a product defect. Fix the fixture before drawing conclusions from a fixture/task mismatch.
- **Wait for `turn/end` to settle before cleaning up evidence**: the criterion is `turn/end.reason.kind` (`error` means aborted/interrupted), **not** the later `session/end` / `job/settled:completed` — those are post-crash cleanup events, not evidence of a normal finish. Deleting the worktree early removes the agent's cwd and prevents it from completing "write report + advance card"; it then looks like "no report back" when it was actually interrupted. Clean up only after the turn truly ends (or fails explicitly).
