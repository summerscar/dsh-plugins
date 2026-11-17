# Competitor research: factory-style development agents

> Scope of this round: compare comparable products on **feature strengths and weaknesses**, not on how a task board looks. The UI reference anchor is **Mastra Factory**; the taskboard-style plugins below are compared for features only, not treated as UI models.
> This is a reusable record for whoever takes over: it explains where our design sits among peers, what we deliberately adopt or reject, and which conclusions feed later phases. It is a decision input, **not** a copy of the roadmap — for phases and acceptance criteria read [§4 of the roadmap](ROADMAP.md).

## 1. Who was compared and how

Five external projects plus this plugin. Two reference architectures from earlier research are summarised in [roadmap §6](ROADMAP.md); this document records the wider comparison that followed.

The comparison favours observable capability over presentation. A star in the matrix means the capability is present and worked out; a dash means absent. Popularity counters and version labels are intentionally left out — they go stale and do not change the engineering judgement.

## 2. Feature matrix

| Dimension | Mastra Factory | dsh-factory (ours) | shengsheng90 | cloader | maochiy | linglanxin |
|---|---|---|---|---|---|---|
| Issue intake sources | Strong — many sources: GitHub / Linear / Slack plus Jira / GitLab / incident.io, filtered per source | Medium — GitHub issue intake, with a per-project source and board | Weak — cards are created and approved mostly by hand | Strong — GitHub plus external sync (Zentao / TAPD) | None | None |
| Configurable stage gates | Strong — custom stages, outcomes and transition policy defined in code | Medium — fixed state machine with `assertTransition` and L0/L1/L2 levels | Strong — fixed states with separate approve / accept | Strong — fixed columns with a blocked state | Medium — fixed columns | None |
| Autonomy / manual levels | Strong — **per-stage manual/auto plus two board-level switches** | Strong — **project-level L0/L1/L2 plus `autoStart` / `autoApprove`** | Medium — automation rules with quota-based pauses | Medium — claim / scheduled / cron execution modes | None | None |
| Concurrency control | Strong — per-replica in-flight cap, queue indicator and health view | Medium — per-project and global ceilings, backend only, UI pending | Strong — two-tier project / global worker caps | Strong — configurable cap | None | None |
| Session and workspace isolation | Strong — independent session and sandbox per work item | Strong — one card = one session + one worktree + a task branch | Strong — per-item session and workspace cwd, goal-driven | Strong — worktree, task branch, multi-repo mirroring, non-git fallback | Medium — card/session linkage | None — read-only monitor |
| Approval and takeover | Strong — accept / accept-and-plan / approve-plan / merge kept separate, human transition policy, independent review card and session | Strong — review-only authorization gate, single pending authorization, takeover and pause | Strong — approve / accept / forced takeover / send-back | Strong — agent cannot reach done, one-click finish or send-back | None | None |
| Persistence and consistency | Strong — multiple backends, optimistic versions, encrypted credentials | Strong — whole state in one SQLite row with a schema version; engine swappable | Strong — embedded SQLite with write transactions and version locks | Medium — JSON with lock file and version checks | Medium — JSON temp file and rename | None — read-only event log |
| Integration ecosystem | Strong — many sources plus two-way Slack conversations | Weak — GitHub only | None | Medium — Zentao / TAPD | None | None |
| Extensibility / customisation | Strong — custom boards reuse the existing UI; agents, tools, UI, auth, storage and sandbox all configurable | Medium — skill system; zero-build plain-JS plugin | Strong — workflow editor | Medium — templates and branch-name presets | None | None |
| Activity and maturity | Strong — large, actively maintained open-source project, still beta | Under development, unreleased | Active | Active | Near-empty single commit | Near-empty single commit |

## 3. Strengths and weak points, judged

- **Mastra Factory** — strongest on **configurability**: gates, rules, integrations, sandbox and storage are all plug-in points. Splitting Work and Review into two independent cards, each with its own session, is a structural difference no other peer has. Costs: bound to its own platform (auth, database, cloud sandbox), board rules are written in code, and it is still beta.
- **shengsheng90** — real engineering in **two-tier concurrency** and SQLite consistency; approve/accept are separated and takeover is forced. Costs: no external issue source, heavy architecture, and its GUI was verified mainly for install/load on a few host versions.
- **cloader** — richest **worktree engineering** (multi-repo mirroring, non-git fallback, crash-lock recovery, read-failure protection) and the broadest external sources. Costs: a single global concurrency value, no notion of autonomy levels, and a JSON ledger that does not scale indefinitely.
- **dsh-factory (ours)** — strong on the combination of **one card = one session + one worktree, human approval gates, and multi-project**, plus the L0/L1/L2 levels, which are unique among these peers. Weak points: GitHub-only intake, fixed stages, no concurrency UI yet, and persistence was the weakest before the SQLite switch (now on par with the SQLite-based peers).
- **maochiy / linglanxin** — near-empty single-commit projects; one is a minimal CRUD board, the other a monitoring console rather than a task manager. No reference value.

## 4. UI anchor: Mastra Factory

Keep this as the **visual and interaction reference**; the taskboard plugins above are not UI models.

- **Page structure** — Intake / Work / Review / Overview / Settings. **Work and Review are two separate boards**; a pull request gets its own Review card and session.
- **Stage presentation** — the Work board is a **list grouped by workflow status** (section headers collapse and expand, counts and create stay available), not a classic drag-and-drop column board. Stages run Intake → Triage → Planning → Building → Review → Done (plus Canceled).
- **How manual/auto is expressed** — two board-level switches (auto-start runs / auto-approve plans); **per-stage manual/auto is code configuration**, not a UI toggle per stage. Plan approval uses a distinct submit action, separate from stage transitions.
- **"Needs my attention"** — Overview collects items awaiting a decision or reporting a problem; dismissed approval requests land in a Needs-attention view.
- **Session detail** — chat plus tool activity plus workspace files/changes; you can steer an open session in place instead of starting a new conversation.
- **Card actions** — Accept (with accept-and-plan / accept-and-build), Approve plan, Merge, Re-review.
- **Status feedback** — the favicon changes with session state (awaiting / error / initializing / working), and there is a run-queue indicator.
- **Mobile** — onboarding lays out four sections with a desktop preview beside them; **on mobile the preview is hidden and the primary action is pinned to the bottom**. Worth copying directly.
- **Images** — no stable product-screenshot URL was obtained (the site's social image is a dynamic title card, not a product shot). Available references are an [overview video](https://youtu.be/iMA-Xkhj7fU), a [workshop recording](https://www.youtube.com/live/LzZ_FptHWqs), and source-tree assets: a [review-status animation](https://github.com/mastra-ai/mastra/blob/main/mastracode/factory/assets/review-status/reviewing-light.gif) and [stage icons](https://github.com/mastra-ai/mastra/tree/main/mastracode/factory-ui/src/ui/public/factory-stage-icons). No screenshot URL was invented.

## 5. What to adopt, what not to

**Worth adopting**

1. Splitting Work and Review into two cards, each with its own session — a structural difference from our current "one card runs to the end", bigger than a UI change.
2. The board-level switches and the Needs-attention view as the vocabulary and home for autonomy state — directly useful for our L0/L1/L2 interface.
3. A source-events write-back loop (how a closed issue or merged PR advances a card) — useful for intake closure; see the roadmap input below.
4. Mobile onboarding layout and session-state favicon feedback.
5. Per-session sandbox isolation.

**Deliberately not adopted**

1. The code-defined board-rule engine — we are a zero-build plain-JS plugin; that approach is too heavy.
2. Platform-bound auth, database and cloud sandbox — we do not depend on a vendor runtime.
3. Goal-driven execution, observational memory and graph wiki — heavy infrastructure beyond this project's scale.

Note that per-stage manual/auto being **code configuration rather than a UI toggle** corroborates our own hard-won rule: the interface must read the autonomy level field, never the two booleans.

## 6. Input to later phases

The conclusion of this round is **not to add more features**. The core chain — issue to draft pull request with a person approving at the gates — is closed end to end. P4 is about turning existing capability into an interface and collecting real usage feedback, not filling feature gaps. Adding features now would mean reopening a machine that has just been tuned.

**Feeds into the roadmap** (see [§4 phases](ROADMAP.md) and [§5 gaps](ROADMAP.md)):

- **P4 interface** — now implemented and acceptance-passed: the autonomy-level UI landed with the Mastra UI anchor above — a three-choice level control (its status badge reads only `autonomy`), pause / take-over, a concurrency ceiling with a globally HTTP-writable cap, worktree-cleaning project deletion, global / project scope split, and mobile bottom-pinned primary actions. Both of its open items are now closed — the written global cap's fixture-level proof was verified against a backend concurrency fixture and the interface was re-tested on a live machine; the capability is documented in [§5](ROADMAP.md).
- **Later, structural** — the Work/Review split into two cards with separate sessions is a real structural difference. Recorded here, not started: it is larger than P4 and is not undertaken without an explicit decision.
- **Later, only if it becomes a real pain point** — source-events write-back (closed issue / merged PR advancing a card) is the one enhancement that completes the other half of an existing chain rather than copying a new feature. It is tied to webhooks and is **not** in scope this round.

**Explicitly not doing, with reasons**

- More issue sources (GitLab / Linear / Zentao) and configurable stages — genuine enhancements, but they expand the product boundary rather than complete the current goal; doing them now would dilute P4.
- Webhooks and source-events write-back this round — a single machine with polling is enough; the remote-snapshot injection entry already covers the manual side.
- The code-defined rule engine, platform-bound infrastructure and goal/memory/wiki stack — see "not adopted" above.

## 7. Sources

**Mastra Factory — official site and docs**

- [Factory](https://mastra.ai/factory) · [Get started](https://factory.mastra.ai/) · [What's Factory](https://factory.mastra.ai/what-is-factory)
- [Work and approvals](https://factory.mastra.ai/using/work-and-approvals) · [Sessions](https://factory.mastra.ai/using/sessions) · [Reviews](https://factory.mastra.ai/using/reviews)
- [Boards and rules](https://factory.mastra.ai/configure/boards-and-rules) · [Storage](https://factory.mastra.ai/configure/storage) · [Sandboxes](https://factory.mastra.ai/configure/sandboxes) · [Environment variables](https://factory.mastra.ai/reference/environment-variables)

**Mastra Factory — blog**

- [Beta announcement](https://mastra.ai/blog/announcing-mastra-factory-beta) · [Jira / GitLab / incident.io integrations](https://mastra.ai/blog/introducing-jira-gitlab-incident-integrations)

**Mastra Factory — source**

- [mastra-ai/mastra](https://github.com/mastra-ai/mastra), under `mastracode/` · templates [template-factory](https://github.com/mastra-ai/template-factory) and [softwarefactory-template](https://github.com/mastra-ai/softwarefactory-template)

**Other peers** — shengsheng90, cloader, maochiy and linglanxin were compared from their repository README files, `package.json` and public repository metadata. No stable product-document links were obtained for them in this round, so none are fabricated here.

---

Back to [roadmap phases §4](ROADMAP.md) and [research basis §6](ROADMAP.md).
