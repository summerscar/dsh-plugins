<div align="center">

# dsh-factory

<!-- release-state-note -->

**A multi-project development factory for DeepSeek Harness: every card runs in its own session and git worktree, and no commit, push or pull request happens without your explicit approval.**

English · [简体中文](docs/README.zh-CN.md)

</div>

---

## What it does

- **Kanban across projects.** Work is organised as project → board → card. A project is one absolute root path plus the repositories under it; a card can override the repository it runs against, so projects scattered across different directories live on the same board.
- **One session and one worktree per card.** Dispatching a card creates a dedicated session and isolates it in a git worktree under a per-project directory, so two cards never share a working tree.
- **Approval-gated delivery.** The plugin may draft the commit message and the pull request body, but commit, push and pull request happen only after you press the dedicated approval control on the card. It never commits, pushes, merges or escalates permissions on its own.
- **Issue intake.** Open GitHub issues become cards, deduplicated by repository and number, so polling never produces duplicate cards.
- **Bundled process skills.** Six phase skills ship with the package (triage / plan / build / self-review / review / rereview) and register on install, telling the session working a card what that phase requires.

## Install

```sh
dsh plugin --profile web add @summerscar/dsh-factory
```

Refresh after installing, open **Settings** (the gear, bottom-left), then choose “Project Factory” in the left nav to open the board.

## Use

1. Create a project with its absolute root path.
2. Create a board under it, then cards — or pull issues in through intake.
3. Dispatch a card; it runs in its own session and worktree.
4. Inspect the change at review, press **Commit**, then **Push branch and create PR** — both are your actions, never the plugin's.
5. The card stays at review once the pull request is open; you decide whether to mark it done or send it back.

## GitHub access

Chosen automatically from what your machine already has, in this order:

1. **Reuse the `gh` login** — if you have run `gh auth login`, it works with no setup.
2. **Your own OAuth App with the device flow** — [create an OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) and **enable the device flow**; the callback URL is unused by that flow, so `http://127.0.0.1` is fine as a placeholder. Put the Client ID (not a secret) into the plugin, then enter the eight-character code at [github.com/login/device](https://github.com/login/device).
3. **A personal access token** — stored in DSH credentials, the fallback when neither of the above is available.

Access tokens always live in DSH credentials, never in configuration, logs or state files. The plugin ships no OAuth credentials of its own.

References: [authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) · [create an app](https://github.com/settings/applications/new) · [enter a device code](https://github.com/login/device)

## Limitations

- **No automatic git.** Without a person pressing the approval control on a card, the plugin never commits, pushes, opens a pull request or merges.
- **No webhooks.** It uses `gh` and polling, so issue changes are not live; freshness follows the poll interval.
- **GitHub only.** The GitLab review flow is not implemented.
- **Single machine.** Built for a DSH running locally; it provides no multi-replica coordination.
