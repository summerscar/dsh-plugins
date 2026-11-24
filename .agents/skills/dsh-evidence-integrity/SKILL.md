---
name: dsh-evidence-integrity
description: Report verification honestly when a real-machine path cannot be triggered, or when a teammate says a change is landed but the source has not been checked. Use when an integration test, session resume or prompt-injection defence prevents a wrong-tool trace from being produced; when a report must separate unit, mutation, source-audit and live evidence; or when a promised edit must be confirmed before it is treated as done; do not use for ordinary documentation with no verification claim.
---

# Evidence integrity

A result is only as strong as the evidence behind it. The two expensive mistakes are promoting a lower evidence tier to a live proof, and treating a promise as a landed change.

## Steps

1. **Verify claims against the current source.** After any reported change, re-read the exact files and compare the stated values. A reply of "I will change it" or "it is changed" is a promise, not a result; only the current file or a real command output is a result. Done when each claim in your report can point to an observed value, and any mismatch is surfaced instead of smoothed over.
2. **Name the evidence tier for every claim.** Keep four tiers separate: injected/unit logic, mutation that makes a case go red, source or trace audit, and real-machine observation. Never write "verified on a real machine" for a path that only has injected tests. Done when each verification sentence names its tier and no claim outruns its evidence.
3. **Try the real path, then stop honestly.** List the plausible routes to the evidence, attempt each once within a bounded budget, and capture the exact refusal or error. If there is no tool/result trace to collect, say the live evidence was not obtained and give the reason; do not manufacture a log or downgrade the claim to "passed". Done when the report records what was tried, what blocked it and that the boundary remains open.
4. **Use compensating evidence without pretending it is live.** For a cross-role or wrong-tool path that cannot be triggered, use bidirectional negative tests, mutation and a source audit. State plainly what each proves: the gate rejects in code, not that a live model was seen attempting it. Done when the unit/mutation/audit conclusions are listed separately from the unavailable live proof.
5. **Attribute numbers and keep them durable.** Report counts as the runner's actual output, with the context that produced them. Map-style documents should point to the source of truth instead of freezing a total that grows each iteration. Done when no number is presented as independently re-run if you only read someone else's report.
6. **Close the evidence loop.** Remove temporary fixtures, close tabs you opened, and confirm no scratch output entered the worktree or delivery. Done when the tree contains only intended changes and the report states any residual evidence gap.

## Reference: why live traces may be impossible

- There is no HTTP route that invokes the tool being tested, so the wrong call cannot be issued through the API.
- Resuming a session may fail with an active write handle; that is an environment refusal, not a product verdict.
- A model following injection defence may refuse to call a wrong tool and explain why; the absence of a bad tool/call is then the observation, not a missing test.
- A teammate can report a change twice before reading the source. Re-check the file every time before treating the work as landed.
