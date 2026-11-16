# Documentation compass

This is the map of this repository's documentation: where each plugin stands, what comes next, and which document answers which question. It is a table of contents with context, **not** a copy of the documents it points to. When a detail is settled in a specific document, that document is the source of truth; this file only tells you where to look.

## Current state

Lifecycle stages come from `scripts/plugin-release-states.json`, the single source of truth. A stage moves forward only: `draft` → `testing` → `published`. The meaning of each stage and the release rules live in [RELEASING.md](RELEASING.md).

| Plugin | Lifecycle | Where it stands |
| --- | --- | --- |
| [`@summerscar/dsh-mnemon-sync`](plugins/dsh-mnemon-sync/README.md) | `published` | Released and in maintenance; later changes follow the normal update flow. Its capabilities and limits are described in its own README. |
| [`@summerscar/dsh-connect-agentscope-platform`](plugins/dsh-connect-agentscope-platform/README.md) | `published` | Released and in maintenance; same update flow. See its README for account handling, the optional model provider and the credits panel. |
| [`@summerscar/dsh-factory`](plugins/dsh-factory/README.md) | `draft` | Under active development; the source is in the repository but it has not been released. The end-to-end add chain has been verified; the L1 autonomy engine is implemented. |

The factory is the only plugin currently being developed. Its roadmap is the place to read both what it can do today and what is still open: [§2 of the roadmap](plugins/dsh-factory/docs/ROADMAP.md) describes current behaviour, and [§5](plugins/dsh-factory/docs/ROADMAP.md) lists known gaps. Do not read the gap list as a complete registry of verified behaviour: verify against the source and the host. Two items once flagged as safety prerequisites for dispatch are no longer open — the permission boundary on dispatched sessions is fixed and verified, and the window between a write and its receipt is contained in L1, with only its structural fix left as a separate prerequisite for L2.

## Future work

The phases below are the global view only. Detail, decisions and acceptance criteria are in [§4 of the factory roadmap](plugins/dsh-factory/docs/ROADMAP.md); gaps and unmet prerequisites are in [§5](plugins/dsh-factory/docs/ROADMAP.md).

| Phase | Goal | Status | Where to read |
| --- | --- | --- | --- |
| P1 | Verify the full add chain on a real host | Done | Roadmap §4 P1 — acceptance groups and the round-by-round ledger |
| P2 | Autonomy engine, level L1 | Implemented; real automatic dispatch verified end to end on a real machine, stopping at plan-review | Roadmap §4 P2 and §5 |
| P3 | Level L2, automatic progression up to a draft pull request | Not started | Roadmap §4 P3 — a separate round because it changes where approval comes from |
| P4 | Interface for autonomy levels, status and pause / takeover | Not started | Roadmap §4 P4 — depends on engine behaviour being settled first |

**Next step:** P2's functional gaps are cleared and the automatic path is verified end to end. The structural transaction-boundary fix is a prerequisite for P3 / L2 and should be scoped as its own task rather than folded into a P2 close-out; P4's interface depends on engine behaviour being settled first. P3 is deliberately its own round because it moves the approval source.

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

## Maintenance

- Keep the two languages structurally identical; change both together.
- Do not write test counts, version numbers, dates or "verified on version X" here. Point to the document that can carry them.
- When the plugin set, a lifecycle stage or a roadmap phase changes, update this file along with the source of truth — never from memory.
