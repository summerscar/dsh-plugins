# Documentation compass

This is the map of this repository's documentation: where each plugin stands, what comes next, and which document answers which question. It is a table of contents with context, **not** a copy of the documents it points to. When a detail is settled in a specific document, that document is the source of truth; this file only tells you where to look.

## Current state

Lifecycle stages come from `scripts/plugin-release-states.json`, the single source of truth. A stage moves forward only: `draft` → `testing` → `published`. The meaning of each stage and the release rules live in [RELEASING.md](RELEASING.md).

| Plugin | Lifecycle | Where it stands |
| --- | --- | --- |
| [`@summerscar/dsh-mnemon-sync`](plugins/dsh-mnemon-sync/README.md) | `published` | Released and in maintenance; later changes follow the normal update flow. Its capabilities and limits are described in its own README. |
| [`@summerscar/dsh-connect-agentscope-platform`](plugins/dsh-connect-agentscope-platform/README.md) | `published` | Released and in maintenance; same update flow. See its README for account handling, the optional model provider and the credits panel. |
| [`@summerscar/dsh-factory`](plugins/dsh-factory/README.md) | `draft` | Under active development; the source is in the repository but it has not been released. P1 add chain, P2 the autonomy engine, P3 machine plan approval, the P4 autonomy-level interface, P5/P6 UI and whole-page work (including project-level GitHub identity configuration) and P7 (card-body injection plus per-card return) are implemented; autonomy now runs on three semantic levels (manual / you-approve / machine-approve) with a single autoDispatch switch, replacing the old L0/L1/L2 ids and two switches (old archives are migrated once on load); "Cancel card" soft delete is also available (moves to the `canceled` terminal state, keeps the card and its `source` to prevent recreation, no backend change); cancelled cards are viewable read-only in a footer disclosure strip, and the task-card count excludes cancelled cards while keeping done ones. State persists in SQLite. A GitHub identity-settings increment adds the four-layer identity ladder (OAuth App → gh CLI → global Token → repo-only Token), moves the Client ID into the ① OAuth App block, and makes global token state read-only with masked fingerprints. A later display-only increment adds one single-line, priority-ordered flow hint per card below its meta (auto vs manual by tier, with overlays for pause / capacity / takeover / needs-info / stalled / stopped session that never stack on existing L4 review notices), and the resupply modal now shows the last triage-return reason read-only above an unfilled input. Delivery copy is drafted through the host's lightweight model call: manual commit / first PR open an editable draft after the same gates and write only on confirm, L4 drafting is best-effort with the former defaults, and an explicitly empty PR body stays empty. Review sessions follow the project's workMode while keeping the independent session and verdict gates; in tabs view the project strip stays pinned below the header. |

The factory is the only plugin currently being developed. Its roadmap is the place to read both what it can do today and what is still open: [§2 of the roadmap](plugins/dsh-factory/docs/ROADMAP.md) describes current behaviour, and [§5](plugins/dsh-factory/docs/ROADMAP.md) lists known gaps. Do not read the gap list as a complete registry of verified behaviour: verify against the source and the host. The permission boundary on dispatched sessions and the write/receipt window (factory side) are both fixed and verified. The body is treated as untrusted data injected ahead of the phase skill; per-card takeover now has a matching, idempotent return route; non-terminal cards can be cancelled in one click (soft delete), with no per-card hard delete; cancelled cards can be inspected read-only in a footer disclosure strip, and the task-card count excludes cancelled cards but still counts completed ones.

## Future work

The phases below are the global view only. Detail, decisions and acceptance criteria are in [§4 of the factory roadmap](plugins/dsh-factory/docs/ROADMAP.md); gaps and unmet prerequisites are in [§5](plugins/dsh-factory/docs/ROADMAP.md).

| Phase | Goal | Status | Where to read |
| --- | --- | --- | --- |
| P1 | Verify the full add chain on a real host | Done | Roadmap §4 P1 — acceptance groups and the round-by-round ledger |
| P2 | Autonomy engine, three semantic levels | Implemented; real automatic dispatch verified end to end on a real machine, stopping at plan-review | Roadmap §4 P2 and §5 |
| P3 | machine-approve: the machine approves plans (explicit level choice, per project) | Implemented and verified on a real machine — the machine takes `plan-review -> build` only, reads no switch; delivery authorization stays with a person | Roadmap §4 P3 |
| P4 | Interface for autonomy levels, status, pause / takeover and concurrency settings | Implemented and accepted; interface re-tested on a live machine and the P4-7a/7b global-cap proof verified against a backend concurrency fixture | Roadmap §4 P4 and §5 |
| P5 | UI/UX, copy and one-board-per-project | Implemented; QA reported the full package green | Roadmap §4 P5 |
| P6 | Whole-page view, one-shot GitHub binding and identity display | Implemented; QA reported the full package green; a later increment covers the four-layer identity ladder, Client ID placement and read-only token state | Roadmap §4 P6 |
| P7 | Card-body injection (task description) and per-card return | Implemented; Review had no blocking issue, Design UI review passed, QA reported all green; the real-machine end-to-end re-read path is an explicitly unclosed residual risk | Roadmap §4 P7 and §5 |
| P8 | Structured review verdict, independent review session and gated L4 delivery | Complete; the iteration's own P0–P3 sub-phases and the later L4 hardening are all done | Roadmap §4 P8 |
| P9 | One-line card flow hints and resupply context | Complete; flow hints checked on a real machine with DOM evidence, resupply modal covered by offline tests and mutation only | Roadmap §4 P9 and §2.14 |
| P10 | AI-drafted delivery copy, review workMode and UI regressions | Complete; manual-commit draft states and all three entry points checked on a real machine, L4 generated copy observed; PR dual-field QA conclusion and duplicate-request count still open | Roadmap §4 P10, §2.15 and §5.1 |

**Next step:** The per-card takeover/return pair, card-body injection, the P8 review/auto-delivery iteration and the P9 flow-hint increment are delivered. What remains: the end-to-end real-machine check for body freshness (change a remote issue → redispatch → the report reflects it) was deliberately not run because it needs authorization for binding a repo and editing a remote issue; the Work/Review card split in [RESEARCH.md](plugins/dsh-factory/docs/RESEARCH.md) is a structural follow-up that still needs an explicit decision; the other known gaps stay listed in roadmap §5. For the GitHub identity-settings increment, the failure-state repair block, saving a Client ID, token save/clear writes and the English UI still need real-machine checks. For P10, a formal QA note on the PR title/body editor and on duplicate draft requests is still owed; the L4 failure/timeout fallback has offline evidence only.

## Where to look

| To understand | Read | What it owns |
| --- | --- | --- |
| What this repository is, how to install plugins, the plugin list and lifecycle table | [README.md](README.md) / [README.zh-CN.md](README.zh-CN.md) | User-facing entry point. The lifecycle table between its markers is generated — do not hand-edit it. |
| What one plugin does, how to install and use it, and its limits | `plugins/<name>/README.md` and `plugins/<name>/docs/README.zh-CN.md` | One file per plugin, in both languages. Feature-level truth for users. |
| Global repository rules: documentation, verification, commits, runtime contract strings | [AGENTS.md](AGENTS.md) | Applies everywhere; directory-specific rules take precedence. |
| Rules for developing code under `plugins/` | [plugins/AGENTS.md](plugins/AGENTS.md) | Host peer dependencies, event scope, client UI primitives, what this repository ships today. |
| Rules for the plugin site and the market index | [site/AGENTS.md](site/AGENTS.md) | `catalog.json`, rendering and build, `index.json`, deployment. |
| Lifecycle stages, promotion, npm release flow | [RELEASING.md](RELEASING.md) / [RELEASING.zh-CN.md](RELEASING.zh-CN.md) | `draft` → `testing` → `published`, first release, Trusted Publishing, release holds. |
| The factory's goals, settled decisions, phases, known gaps and research basis | [ROADMAP.md](plugins/dsh-factory/docs/ROADMAP.md) / [ROADMAP.zh-CN.md](plugins/dsh-factory/docs/ROADMAP.zh-CN.md) | Design rationale and the reason behind each decision. Implementation detail stays in source. |
| Competitor comparison: feature strengths and weaknesses, the Mastra UI anchor, and what later phases should take or skip | [RESEARCH.md](plugins/dsh-factory/docs/RESEARCH.md) / [RESEARCH.zh-CN.md](plugins/dsh-factory/docs/RESEARCH.zh-CN.md) | The multi-project comparison and its decisions; points back to the roadmap phases that consume them. |
| How to release a plugin to the two community markets | [`.agents/skills/dsh-plugin-market-release/SKILL.md`](.agents/skills/dsh-plugin-market-release/SKILL.md) | Market submission shapes, field rules, review-and-resubmit flow. |
| How to publish to npm and advance the lifecycle | [`.agents/skills/npm-plugin-release/SKILL.md`](.agents/skills/npm-plugin-release/SKILL.md) | Release workflow, OIDC, synchronization before commit and push. |
| How to verify a plugin on a real host | [`.agents/skills/dsh-plugin-live-verification/SKILL.md`](.agents/skills/dsh-plugin-live-verification/SKILL.md) | Host contracts, silent degradation, environment-driven paths, evidence discipline. |
| How to build auto-dispatched agent sessions: context injection, sandbox pinning, write prechecks, autonomy edges | [`.agents/skills/dsh-dispatch-session-mechanics/SKILL.md`](.agents/skills/dsh-dispatch-session-mechanics/SKILL.md) | Host-side mechanisms behind dispatched sessions: when each pitfall shows up and how to judge it. |
| How to support several credential sources and show their precedence, active layer and read-only token state | [`.agents/skills/dsh-credential-identity-ladder/SKILL.md`](.agents/skills/dsh-credential-identity-ladder/SKILL.md) | Multi-source credential precedence, environment values as defaults, masked read-only state, failure-only repair entries. |
| How to design one priority-ordered status line per card, judge whether a display-only change needs a `BUILD` bump, and test it with injected state plus mutation | [`.agents/skills/dsh-card-flow-hint/SKILL.md`](.agents/skills/dsh-card-flow-hint/SKILL.md) | Pure-function priority design, display-layer boundaries, mutation checks and honest real-machine evidence. |
| How to draft delivery copy with the host's lightweight model call, keep generation read-only until a person confirms, and fall back without blocking writes | [`.agents/skills/dsh-ai-delivery-copy/SKILL.md`](.agents/skills/dsh-ai-delivery-copy/SKILL.md) | Draft-then-confirm boundary, bounded one-shot generation, four-state editor, best-effort automation and request-order evidence. |

## Maintenance

- Keep the two languages structurally identical; change both together.
- Do not write test counts, version numbers, dates or "verified on version X" here. Point to the document that can carry them.
- When the plugin set, a lifecycle stage or a roadmap phase changes, update this file along with the source of truth — never from memory.
