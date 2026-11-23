---
name: dsh-git-write-gates
description: Fence an automated git write against stray heads, live sessions and hook-injected files; strip Git's hook environment from nested git commands and give a stalled delivery an explicit human retry. Use when an agent or CI writes git on a card's behalf, a commit hook runs tests that create their own git fixtures, unrelated files keep entering delivered commits, or a failed automated commit needs a safe recovery path; read-only git work does not need it.
---

# Git write gates

Treat an automated commit as a _fence_: the decision to write and the tree actually written must be the same tree, and anything unexpected stops the write.

## Steps

1. **Gate before the first git read/write.** Check the tier and state, the human take-over and needs-info flags, and whether any agent session is still live. A human returning a card to the engine does not prove its turn ended; committing mid-turn can capture half-written files. Done when a live-session case produces a refusal and no git command is executed.
2. **Prove the head belongs to this change.** When no commit has been recorded for the work, resolve the base ref to a full SHA and require the worktree HEAD to match it. A stray or fixture commit is not a delivery head. Refuse on an unreadable, missing or non-full SHA, and audit each refusal with its reason. Done when an unexpected HEAD is rejected before staging and the normal matching-HEAD path still commits.
3. **Freeze the path list at decision time.** Read the dirty paths once, then pass that explicit list to both staging and commit (path-limited add and commit). A file created later by a hook or a nested command cannot join the commit. Bound the deletion check too: a worktree that lost most of its tracked files is a fixture swap or a mistake, not a delivery change. Done when a file created during the hook is absent from the commit and a mass deletion is refused before staging.
4. **Isolate nested git commands from the hook environment.** A commit hook exports variables that point child processes at the repository being committed. Strip those variables in the hook before running the full suite, and in any release or test script that spawns its own git commands. Hide only genuinely known environment-only false positives so the full gate still runs. Done when a fixture's `git init` / `git commit` lands in the fixture repository and the hook's repository stays untouched.
5. **Give a latched failure a human door.** After a bounded number of failed commits, stop automatic retries and expose an explicit retry entry. Require an explicit human actor, refuse other tiers/states and live sessions, optionally accept a repair commit sha from the human, clear the failure state and re-arm the engine to re-evaluate the normal gate on the next tick. Done when a corrected worktree re-enters the pipeline only after that explicit action, and a direct retry request cannot bypass the state checks.
6. **Verify with mutation and a real command chain.** Cover the unexpected head, matching head, live session, mass deletion, path freezing, environment stripping and retry accept/refuse cases. Break each guard once and confirm its case goes red, then restore. Separately run one real hook-invoked command chain on a real host and inspect the resulting commit's file list and head. Done when the mutation results and the real commit contents are recorded as observed; injected ports alone are not evidence of the hook or git environment.

## Reference: what this replaces

- A single-point guard is not a flow fix: if the fixture commit came from the test environment, fix the environment as well as the delivery path.
- A hook-created file is untrusted input to the commit, even when the hook belongs to the same repository. Freeze paths rather than re-reading the worktree at commit time.
- Automatic re-arming after repeated failures turns a stop signal into a retry loop; an explicit human entry keeps control with the person who repaired the tree.
- A build bump is required when the git-write path itself changes in host-loaded code; display-only edits around it are not a bump.
