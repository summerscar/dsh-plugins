<div align="center">

# dsh-factory

<!-- release-state-note -->

**A multi-project development factory for DeepSeek Harness: every card runs in its own session and git worktree. The build session commits and pushes its branch, an independent self-reviewer opens the one draft pull request, a PR reviewer records a verdict, and you merge; the card completes only when the remote PR reports merged.**

English · [简体中文](docs/README.zh-CN.md)

</div>

---

## What it does

- **One board per project.** Work is organised as project → one board → card. Creating a project also creates its single board in the same transaction, and asking for another board on that project returns the existing one. Older multi-board data is converged when state loads: the first active board is kept, cards from the others are moved into it, intake targets are repointed, and the extra boards are archived rather than deleted. A project is one absolute root path plus the repositories under it. A card's repository information is passed to its session as context only; the worktree a card runs in is always created from the project's root path, so a card never changes which directory it actually runs in.
- **Session and reports on the card.** A dispatched card shows the live DSH session title; clicking it opens that session in the host UI. Every report written on the card — by an agent or by a person — is available from a **View reports** button, showing author, time and full text rendered as Markdown (raw HTML is not executed). The viewer's sort is a browser preference (newest first by default); report numbers stay chronological within this card. Agent replies and stage reports follow the display language selected in DSH.
- **Delivery state and live work.** Every card carries its commit/PR state, with a clickable PR link when one exists. While the host reports that session as running, the whole card sweeps a blue bar and breathes a halo — no extra banner text.
- **A configurable worktrees root.** One global setting controls where new worktrees are created; leave it blank to use the HOME-resolved default `~/dsh-factory-worktrees`. It applies only to worktrees created from then on — existing projects and cards are unaffected. The root must stay outside the DSH data directory, with one narrow exception for the default home subtree.
- **One session and one worktree per card.** Dispatching a card creates a dedicated session and isolates it in a git worktree under a per-project directory, so two cards never share a working tree.
- **Stage continuation.** When a card moves to its next stage, the plugin carries on in the same worktree, trying in order: the session is still live and simply continues; the session ended but its history is on disk and is rebuilt onto; only when that history is unusable does it start a fresh session and record the fallback on the card. A continuation never creates a new worktree.
- **Stops after repeated failures.** A card that fails three times in a row is marked stalled and is no longer retried automatically, so it cannot spin forever.
- **A pipeline with two independent reviews.** The build session commits and pushes its branch without opening a PR. A separate self-review session checks that pushed branch and, on approval, opens the single **draft** PR from the exact head the backend re-read. A third, read-only PR-review session records a verdict on the opened PR. You merge the PR; the card reaches `done` only from that remote merge fact. No path merges, closes issues or force-pushes.
- **Issue intake.** Open GitHub issues become cards, deduplicated by repository and number, so polling never produces duplicate cards.
- **Bundled process skills.** Six phase skills ship with the package (triage / plan / build / self-review / review / rereview) and register on install, telling the session working a card what that phase requires. A further skill teaches the agent how to inspect a repository and register it as a project.
- **One-shot GitHub binding when you create a project.** Creation reads the local git `origin` read-only; only a github.com HTTPS or SSH URL becomes an `owner/repo` binding, written with the project's default board in the same transaction. No remote, a non-GitHub or non-git root, or several origin URLs never block creation — each records a reason code. Detection happens once, at creation; the engine never guesses a repository at runtime. You can change or clear the binding in project settings.
- **A project management page.** The view is designed as a whole page, with a sticky in-page header and two ways to browse projects — a sidebar or a top tab strip, picked with the **View** control and remembered across reloads. The selected project is remembered too, and the board refreshes on its own as sessions and stages change. Each entry shows the project's card count; project settings expose stage rules that can only narrow the default full-auto pipeline.

## Install

```sh
dsh plugin --profile web add @summerscar/dsh-factory
```

Refresh after installing, open **Settings** (the gear, bottom-left), then choose “Project Factory” in the left nav to open the board.

## Use

1. Create a project with its absolute root path. If the root is a git checkout whose `origin` is a github.com HTTPS or SSH URL, the repository is filled in automatically; otherwise the project is still created and the reason shows in its settings. The page header shows the current binding — click it to open that project's binding field.
2. Add cards to the project's board (created automatically with the project) — or pull issues in through intake.
3. Dispatch a card; it runs in its own session and worktree.
4. Plans are approved automatically by default: the card moves from `plan` to `build` and its session continues in the same worktree. In project settings you can narrow `plan` (or any other stage) to stop for a person; pausing the project or taking over a card also blocks later automatic steps.
5. At later stages the card continues: same worktree, same branch, only the session is re-obtained (still live → continue; ended but history on disk → rebuild onto it; no usable history → fresh session with the fallback recorded). The build session verifies the change, commits only the paths it froze at decision time and pushes the card branch — it does not open a PR. The card shows the linked session's title — click it to jump to that conversation — and **View reports** opens every stage report written on the card.
6. An independent self-review session checks the pushed branch. On approval it opens one **draft** PR from the exact head the backend re-read, then moves the card to `pr-review`. A separate read-only PR-review session records a verdict there; it never merges or moves the card. You can still take over a card to make a manual git write, but the normal path needs no commit/PR buttons.
7. Merge the draft PR yourself when you are satisfied. When the host observes the PR as merged, `syncRule` moves the card to `done` automatically; a PR closed without merging only produces a suggestion to return to `build`.
8. Opening settings from a project lands on that project's settings; the **Global settings** tab (or the "Global settings ›" link on the project pane) holds the worktrees root, GitHub connection, global concurrency and the engine switch. With no project selected, the drawer opens on global settings.
9. Switch between the sidebar and the top tab strip with the **View** control; the choice survives a reload. The GitHub button on a project card only navigates to the global connection settings — connecting is done there, never from the project. Project settings use a stage-rules grid: `triage`, `plan`, `build`, `self-review` and `pr-review` each have auto-start and auto-approval checkboxes, all on by default. They can only turn a stage **off** to make it stop for a person; the section says "Full auto by default; uncheck a stage to pause it for a human." Saves show a short-lived toast.

## Commands

Register a project from the conversation with `/factory`:

- `/factory add` — register this session's working directory as a project.
- `/factory add <absolute-path> [project name]` — register that repository; the directory name is used when no name is given.
- `/factory inspect <absolute-path>` — read-only listing of the repository's raw facts: root file and directory names, entries of each ignore file, manifests worth reading, and the package manager declared in `package.json`. It declares no project type and creates nothing.

`add` does not create the project itself: it hands the request to the session's agent, which follows the bundled `factory-add-project` skill to call `factory_inspect_repo` for the repository's raw facts, then read the files that matter to judge the real toolchain, propose `copyFiles` and `postCreate`, and create the project once you agree. The setup command and the local files to copy come from the **target repository's own** `AGENTS.md` / `CONTRIBUTING`; the plugin presets neither.

## GitHub access

Each project works out its own GitHub identity, and the project's **identity card** shows the result in plain terms: which account is in use (resolved read-only from your `gh` login when needed), where it came from, whether your local checkout is bound to the right remote repository, and a permission check you can run on demand. The card lists the four identity layers in priority order with the active layer marked; a successful check names the layer that passed. When a connected source's account name cannot be read, the card shows the source instead of an "unknown account" placeholder. A global source, once connected, is available across your projects.

Repository binding (`owner/repo`) is separate from identity: it is detected once when you create the project from a github.com `origin`, and can be edited or cleared in project settings (leave the field empty to unbind). Connections and OAuth stay in global settings; a GitHub button on a project only takes you there.

There are three kinds of source, and the scope is fixed by the kind (a token's scope is why the card shows four identity layers rather than three):

- **A GitHub OAuth App** — you connect once through the device flow and the connection is shared across all projects (there is no per-project switch for it). To use one you create your own [OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) with the device flow enabled, put its client ID (not a secret; one value covers every project) into the plugin, then enter the eight-character code GitHub gives you at [github.com/login/device](https://github.com/login/device). GitHub's creation form also requires a Homepage URL and an Authorization callback URL; the device flow never uses the callback, so any URL is fine.
- **Your `gh` login** — if you already ran `gh auth login` on the machine, the plugin uses it as-is and stores nothing. The account manager shows whether `gh` is logged in as an account, and, when it is not, tells you how to log in.
- **A personal access token** — the only kind where you choose the scope: keep it **shared across all projects**, or store it **for one repository only**.

The plugin takes the first source that can actually reach the repository: the shared OAuth App, then your `gh` login, then the global Token, then the Token stored for this repo only as the last fallback. The `GH_TOKEN` / `GITHUB_TOKEN` environment variable is the **default value** of the global Token tier. You can save a separate global Token in the UI that is preferred in use; the environment variable itself is never changed. When an identity is connected but the permission check fails, the card offers two fixes: the global GitHub settings, and a Token that applies **only to this repo**. These repair entries appear only after a failed check. The card's standing entry row (jump to global GitHub settings; add this repo's Token) renders only while the repository is bound and no check result is in yet; it is hidden when the check passed and when no repository is bound, so a failed check leaves exactly one set of entries — the repair block — with no duplicate.

Manually saved tokens live in DSH credentials, never in configuration, logs or state files. The plugin ships no OAuth credentials of its own. The global GitHub settings list the three global layers in priority order: ① the shared OAuth App — **connect**, **reconnect** (a fresh connection that replaces the old one) or **disconnect**; ② `gh` CLI sign-in status; ③ a **global GitHub Token** you can save, clear or recheck. The Client ID sits inside the ① block, below its status line and above the connect buttons; one value is shared by all projects. When the environment variable is configured, the settings show that fact plus a masked fingerprint (first four and last four characters; a value of eight characters or fewer is masked entirely) so you can tell which token it is; a separately saved token is shown alongside it as the one preferred in use. Full token values are never echoed.

A read-only `GET /api/dsh-factory/auth/token/state` backs that status display: it reports whether a global token is configured, whether it comes from the environment or a separately saved token, whether it is valid, its login, and a masked fingerprint. It never returns a full token.

References: [authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) · [create an app](https://github.com/settings/applications/new) · [enter a device code](https://github.com/login/device)

## Limitations

- **Automatic git is built into the pipeline, with a fixed boundary.** The build session commits and pushes its own branch; the self-reviewer opens one draft PR from the approved head. No path merges, closes issues, force-pushes or writes another branch. Stage rules can only stop a stage, never widen this boundary. You merge the PR, and `syncRule` completes the card from the remote merge fact.
- **A pause does not stop running sessions.** Global and per-project pause/resume and per-card takeover now have controls in the settings interface; a pause stops all engine automation (dispatch, plan approval, self-review, delivery), sessions already running keep going, and cards skipped during a pause are not caught up after resuming. The endpoints remain `POST /api/dsh-factory/engine/pause` / `.../resume` and `POST /api/dsh-factory/cards/<card id>/takeover` (`takeover`, not `take-over`).
- **The manual remote-sync route is suggestion-only.** `POST /api/dsh-factory/cards/<card id>/remote-sync` accepts a remote PR snapshot and only records a suggestion: it never changes the card's column or approves its plan. The engine's separate PR-status poll records `done` only on a real merged fact.
- **No webhooks.** It uses `gh` and polling, so issue changes are not live; freshness follows the poll interval.
- **GitHub only.** The GitLab review flow is not implemented.
- **Single machine.** Built for a DSH running locally; it provides no multi-replica coordination.
- **The OAuth connection is a live device flow.** It runs in your browser and is kept only for that page session: refreshing the page while it is in progress cancels it, and if the code is not finished before the flow's time window closes you start the connection again.
- **Reconnecting is a local sign-out.** The plugin clears the stored connection and links you to GitHub's settings page to revoke it, but it cannot revoke the token on GitHub itself (it holds no client secret for your OAuth App); revoking remotely is your action on GitHub's site.
- **A per-repository token only helps that repository.** A token stored to share across projects applies to all of them; a token stored for one repository applies only there.
