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
- A creation tool: registers a project directly. Creating one is local, reversible configuration — it performs no git write.
- The `/factory add [path]` command is only a **trigger**: it hands the intent to the agent, and the `factory-add-project` skill guides the agent to analyse the repository, propose a configuration, and then create the project. Without a path it uses the current session's working directory.

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

### P1 — End-to-end verification on a real machine (not done; blocks the release decision)

The full `/factory add` chain has only been verified offline: command → agent → skill → tools → the project appears on the board. **It has not been run once on a real machine.**

- Acceptance: a bare `add` produces a project whose root path equals that session's working directory; an `add` with a path equals the path given; you can see the agent actually calling the analysis tool and the creation tool (rather than the command creating the project itself); the proposed configuration is justified and contains no command baked into the plugin; the project appears on the board, and the repository files are still there after deleting it.
- Evidence: judge "it really got created" by the project count going from 0 to 1, not by the agent's own account; force-refresh before screenshotting so stale front-end assets cannot fool you.

### P2 — Autonomy engine (not implemented)

The `autonomy` / `autoStart` / `autoApprove` fields today have **storage and write validation only, and no code reads them to make a decision**: no scheduled scan, no automatic dispatch, no automatic approval. Flipping the switches has no effect at all.

- Start with L1: discover issues on a schedule → into the inbox → dispatch triage automatically → advance automatically up to "waiting for you to approve the plan", with delivery still left to a person.
- Acceptance: zero side effects with everything off by default; one L1 chain runs itself to plan approval and stops there; duplicate issues do not create duplicate cards; every automatic action is auditable and distinguishable from a human action; reaching the concurrency limit queues rather than drops; one pause stops new dispatches while letting running sessions finish.

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
| GitHub only | The GitLab skills are not implemented | Add them when there is a concrete need |
| No webhooks | Issues are discovered by polling | Good enough for a single machine |
| Single machine, no multi-replica coordination | The concurrency lock is only valid inside one process | Not a problem for the current use case |
| The session permission level does not actually apply | A permission is passed at dispatch, but the host side is not wired up yet | Write restriction in the worktree is currently by convention, not enforced |
| Branch names are bare identifiers | Harder to read during a human review | A pure improvement, not a blocker |
| Inbox discovery is manually triggered | Scheduling belongs to P2 | — |

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
