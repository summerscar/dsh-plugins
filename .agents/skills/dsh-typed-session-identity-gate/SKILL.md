---
name: dsh-typed-session-identity-gate
description: Design and verify a verdict identity gate when several reviewer roles share one card — bind each verdict source to its own session field, refuse cross-role and builder submissions without an `||` fallback, and make the live-session write gate cover every role. Use when adding a second or third review session, introducing a new verdict source, seeing fields combined with `a || b`, or checking whether a git write can race a reviewer; single-session flows and pure UI copy edits do not need it.
---

# Typed session identity gate

Treat a verdict as **evidence from a named role**, not as free text any live session may attach. The identity check belongs next to the write, before any store or git mutation.

## Steps

1. **Give each role its own field.** Enumerate builder and every reviewer role; assign one persisted session id per role and never let one assignment overwrite another. Record assignment/reuse in history so a later reader can see which role owned which session. Done when every role has an independent id and the builder id survives all review transitions.
2. **Bind verdict source to exactly one field.** Make the accepted source set explicit. A self-review source is accepted only from the self-review field; a PR-review source only from the PR-review field; the builder field is accepted for no structured verdict. Never write `selfId || prId` — that is an impersonation path, not a fallback. Done when a wrong-type submission is refused before the verdict is normalized, with no report or verdict persisted.
3. **Test both refusal directions directly.** Assert self-review → PR rejection and PR → self rejection, plus builder → any rejection. Mutation the typed check to a permissive fallback and confirm every case goes red, then restore. Done when the two cross directions each have a named assertion and no test passes merely because the card was in the wrong status.
4. **Keep one mirror, no stage tag.** Store one current structured verdict object; if rounds or an approved head need separate tracking, use dedicated fields with clear names rather than adding a `stage` discriminator to the verdict. Make idempotency depend on the certified head plus the owning session, so a genuine second reviewer can land a new conclusion. Done when a duplicate submission from the same role/head is a no-op and a different role/head lands exactly one new mirror entry.
5. **Extend the live-session fence to every role.** A write must refuse while any builder, self-reviewer or PR-reviewer field is live. Add every new session field to the liveness helper at the same time the field is introduced, and call the check before staging, git writes or consuming a one-shot authorization. Done when a running reviewer of each role blocks the write and the refusal is retryable after the turn ends.
6. **Park an idle reviewer explicitly.** A reviewer that ends without evidence gets one audit record and a human-visible state; do not auto-redispatch it forever. A manual redispatch route clears the idle mark first and still passes the normal gates. Done when repeated ticks do not re-arm the idle reviewer and a person can recover with one explicit action.
7. **Keep prompts, skills and tool schema on the same source name.** If the injected context says `pr-review`, the skill body and tool schema must say `pr-review` too, and must name the correct verdict tool. Generic review labels are acceptable for shared UI nouns, not for verdict submission instructions. Done when a reviewer following only the skill text submits the source/type the gate accepts.

## Reference: failure modes

- `reviewSessionId || prReviewSessionId` quietly lets one reviewer certify the other's work.
- A `stage` field on the verdict mirror creates two truths; one field plus typed ownership is enough.
- A live-session gate that only checks the builder still races the newest reviewer.
- Generic "review" copy in a skill body leads the model to the wrong verdict tool even when the backend gate is correct.
- Testing only "wrong status is refused" misses the case where both roles are on the correct status but the wrong session submits.
