<div align="center">

# dsh-factory

<!-- release-state-note -->

**A multi-project development factory for DeepSeek Harness: every card runs in its own session and git worktree, and no commit, push or pull request happens without your explicit approval.**

English · [简体中文](docs/README.zh-CN.md)

</div>

---

## What it does

- **Kanban across projects.** Work is organised as project → board → card. A project is one absolute root path plus the repositories under it. A card's repository information is passed to its session as context only; the worktree a card runs in is always created from the project's root path, so a card never changes which directory it actually runs in.
- **A configurable worktrees root.** One global setting controls where new worktrees are created; leave it blank to use the HOME-resolved default `~/dsh-factory-worktrees`. It applies only to worktrees created from then on — existing projects and cards are unaffected. The root must stay outside the DSH data directory, with one narrow exception for the default home subtree.
- **One session and one worktree per card.** Dispatching a card creates a dedicated session and isolates it in a git worktree under a per-project directory, so two cards never share a working tree.
- **Stage continuation.** When a card moves to its next stage, the plugin carries on in the same worktree, trying in order: the session is still live and simply continues; the session ended but its history is on disk and is rebuilt onto; only when that history is unusable does it start a fresh session and record the fallback on the card. A continuation never creates a new worktree.
- **Stops after repeated failures.** A card that fails three times in a row is marked stalled and is no longer retried automatically, so it cannot spin forever.
- **Approval-gated delivery.** The plugin may draft the commit message and the pull request body, but commit, push and pull request happen only after you press the dedicated approval control on the card. It never commits, pushes, merges or escalates permissions on its own.
- **Issue intake.** Open GitHub issues become cards, deduplicated by repository and number, so polling never produces duplicate cards.
- **Bundled process skills.** Six phase skills ship with the package (triage / plan / build / self-review / review / rereview) and register on install, telling the session working a card what that phase requires. A further skill teaches the agent how to inspect a repository and register it as a project.

## Install

```sh
dsh plugin --profile web add @summerscar/dsh-factory
```

Refresh after installing, open **Settings** (the gear, bottom-left), then choose “Project Factory” in the left nav to open the board.

## Use

1. Create a project with its absolute root path.
2. Create a board under it, then cards — or pull issues in through intake.
3. Dispatch a card; it runs in its own session and worktree.
4. When the card moves to its next stage it continues: same worktree, same branch, only the session is re-obtained (still live → continue; ended but history on disk → rebuild onto it; no usable history → fresh session with the fallback recorded).
5. Inspect the change at review, press **Commit**, then **Push branch and create PR** — both are your actions, never the plugin's.
6. The card stays at review once the pull request is open; you decide whether to mark it done or send it back.

## Commands

Register a project from the conversation with `/factory`:

- `/factory add` — register this session's working directory as a project.
- `/factory add <absolute-path> [project name]` — register that repository; the directory name is used when no name is given.
- `/factory inspect <absolute-path>` — read-only listing of the repository's raw facts: root file and directory names, entries of each ignore file, manifests worth reading, and the package manager declared in `package.json`. It declares no project type and creates nothing.

`add` does not create the project itself: it hands the request to the session's agent, which follows the bundled `factory-add-project` skill to call `factory_inspect_repo` for the repository's raw facts, then read the files that matter to judge the real toolchain, propose `copyFiles` and `postCreate`, and create the project once you agree. The setup command and the local files to copy come from the **target repository's own** `AGENTS.md` / `CONTRIBUTING`; the plugin presets neither.

## GitHub access

Each project works out its own GitHub identity, and the project's **identity card** shows the result in plain terms: which account is in use, where it came from, whether your local checkout is bound to the right remote repository, and a permission check you can run on demand. Connect once and it is available across your projects.

There are three kinds of source, and the scope is fixed by the kind:

- **A GitHub OAuth App** — you connect once through the device flow and the connection is shared across all projects (there is no per-project switch for it). To use one you create your own [OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) with the device flow enabled, put its client ID (not a secret) into the plugin, then enter the eight-character code GitHub gives you at [github.com/login/device](https://github.com/login/device).
- **Your `gh` login** — if you already ran `gh auth login` on the machine, the plugin uses it as-is and stores nothing. The account manager shows whether `gh` is logged in as an account, and, when it is not, tells you how to log in.
- **A personal access token** — the only kind where you choose the scope: keep it **shared across all projects**, or store it **for one repository only**.

The plugin takes the first source that can actually reach the repository — a shared connection, then your `gh` login, then a token set in the deployment environment, then a token you stored (shared, or for that one repository). When none of them can reach it, the card says "not connected" and points you to what to do next.

All tokens live in DSH credentials, never in configuration, logs or state files, and they are never shown back to you. The plugin ships no OAuth credentials of its own. In the global settings area you can **connect**, **reconnect** (a fresh connection that replaces the old one) or **disconnect** the shared OAuth connection, and you can see the `gh` login status there too.

References: [authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) · [create an app](https://github.com/settings/applications/new) · [enter a device code](https://github.com/login/device)

## Limitations

- **No automatic git.** Without a person pressing the approval control on a card, the plugin never commits, pushes, opens a pull request or merges.
- **A pause does not stop running sessions.** Global and per-project pause/resume and per-card takeover now have controls in the settings interface; a pause blocks only later ticks, so sessions already running keep going. The endpoints remain `POST /api/dsh-factory/engine/pause` / `.../resume` and `POST /api/dsh-factory/cards/<card id>/takeover` (`takeover`, not `take-over`).
- **Remote status is suggestion-only.** `POST /api/dsh-factory/cards/<card id>/remote-sync` accepts a remote PR snapshot and only records a suggestion for a human: it never changes the card's column or approves its plan for you.
- **No webhooks.** It uses `gh` and polling, so issue changes are not live; freshness follows the poll interval.
- **GitHub only.** The GitLab review flow is not implemented.
- **Single machine.** Built for a DSH running locally; it provides no multi-replica coordination.
- **The OAuth connection is a live device flow.** It runs in your browser and is kept only for that page session: refreshing the page while it is in progress cancels it, and if the code is not finished before the flow's time window closes you start the connection again.
- **Reconnecting is a local sign-out.** The plugin clears the stored connection and links you to GitHub's settings page to revoke it, but it cannot revoke the token on GitHub itself (it holds no client secret for your OAuth App); revoking remotely is your action on GitHub's site.
- **A per-repository token only helps that repository.** A token stored to share across projects applies to all of them; a token stored for one repository applies only there.
