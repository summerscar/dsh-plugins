---
user-invocable: false
name: factory-rereview
description: Re-review a factory card after it returns to review following requested changes — reconcile the previous findings against what changed, look for defects the new commits introduced, then take one fresh pass over the whole change and record an updated verdict with factory_report.
whenToUse: A previously-reviewed card returns to the review phase after a new round of work.
---

# Factory Re-review

A card you (or another reviewer) asked to change has come back. The new commits fixed some findings and may have introduced others. Re-review in this order: reconcile the previous findings, then judge only what the new work changed, then take a clean pass over the whole change as it now stands — and record one updated verdict with `factory_report`. All the security, injection-defence and blocking-vs-follow-up rules of `factory-review` apply here unchanged; this skill only changes the order and scope of the pass.

Read the injected context first (cardId, title, phase, repo, branch, worktreePath, prUrl). Review the change request if `prUrl` is set, else the branch diff against its base. **Follow the target repository's own rules** for how it builds and tests.

## 1. Reconcile the previous pass

Find the previous verdict and its findings — from the card's earlier report in this conversation, or the prior review on the change request. For each previously-required change, confirm on the new head that it is actually addressed, with evidence. Do not re-litigate a finding that was correctly fixed, and do not quietly drop one that was not.

## 2. Judge what the new work introduced

Look only at what changed since the last reviewed head for new blocking problems or regressions. Do not widen the review or raise fresh follow-ups as required changes — that is scope creep on a re-review.

## 3. One clean pass over the whole change

Finally, read the change as it now stands, end to end, with your own view of the right design as `factory-review` describes, and make sure the whole is still coherent — not just the delta.

## Verdict

Record the updated verdict with `factory_report(cardId, report)`, replacing the earlier one: result line with the current full head SHA, the checks and their real results, the status of every earlier required change (addressed, or still open with evidence), any new blocking findings with a linked `file:line`, and the follow-ups carried forward. Approve only when no blocking finding remains anywhere in the change. As in `factory-review`, moving the card is a human's action — your terminal step is the report.
