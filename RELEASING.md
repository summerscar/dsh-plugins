# Plugin lifecycle and releases
[简体中文](RELEASING.zh-CN.md) · [Current registry](README.md#plugin-lifecycle)

`scripts/plugin-release-states.json` records the lifecycle of every `plugins/*` package. It moves forward in one direction: **Draft → Testing → Published**.

| Stage | Meaning | Publication |
| --- | --- | --- |
| `draft` | Under development, before testing | Local development only |
| `testing` | Completing checks and acceptance for its first delivery | Published only when explicitly selected for first release |
| `published` | Has npm publication history, including prereleases | Maintained and updated through the standard release flow |

Fixes, README changes, new-feature testing, and version updates keep a published package in `published`; failed checks stop only that update.

## Current state

- `@summerscar/dsh-mnemon-sync` is `published` with version `0.1.11` on npm (published at `2026-11-09T11:21:23.618Z`, with a verified archive integrity). Its `publication` record is immutable historical proof: never edit or remove it. Subsequent versions follow the normal update workflow — no `first_release` selection is needed.
- `@summerscar/dsh-factory` is `published` with version `0.0.1` on npm (first release via the Trusted Publisher, published at `2026-11-23T17:51:05.734Z`). It was broken out of the first-release deadlock with a manually published placeholder version `0.0.0-stage` that exists only to allow the Trusted Publisher binding; the real archive has no `dshRelease` provenance fields and no `next` dist-tag. Subsequent versions follow the normal update workflow — no `first_release` selection is needed.
- `@summerscar/dsh-connect-agentscope-platform` is `published` with version `0.1.1` on npm (published at `2026-11-13T22:02:00.760Z`). Subsequent versions follow the normal update workflow — no `first_release` selection is needed.

## Normal maintenance

1. Edit source, configuration, dependencies, or packed documentation while keeping `published`.
2. Choose a version by compatibility, then run the relevant tests, builds, archive checks, and target-host acceptance checks.
3. The publisher compares current archive contents with npm, runs `pnpm check`, revalidates the saved plan, publishes, and verifies archive downloads; a failed run leaves the lifecycle stage unchanged. Edits to `README*.md`, `CHANGELOG*.md`, and `docs/` are packed into the archive and ship with the next code release.

Release holds live in `scripts/npm-release-holds.json` and are cleared once their stated conditions are resolved.

## First publication (for future packages)

Register a new package as `draft`, advance it manually to `testing` when ready, and sync documentation. Before its first release, inspect the final archive, license, dependencies, entrypoints, relevant tests, and target-host user scenarios.

The Trusted Publisher can only be configured on a package that already exists on npm, and this repository publishes through OIDC only, so a brand-new package needs a one-time break-out: publish a manual placeholder version (for example `0.0.0-stage`) with a logged-in npm CLI on the maintainer's machine, bind the Trusted Publisher, then trigger **Publish npm plugins** with `first_release` filled with the full package name within 2 days so the OIDC publish completes and the configuration survives. The placeholder stays in the npm history permanently; `selectRelease()` bumps the first real version above it, and any manual archive skips the `dshRelease` provenance fields, so the publisher's anonymous re-verification falls back to comparing published content instead of a provenance marker.

After the first release: verify the archive downloads anonymously with matching integrity, record the `publication` credentials in `scripts/plugin-release-states.json`, and run `pnpm release:docs` + `pnpm release:check`.

## Lifecycle validation

```sh
pnpm release:status # Lifecycle, private status and blockers
pnpm release:docs # Sync both root README tables
pnpm release:check # Lifecycle, documentation and publisher regressions
pnpm release:fingerprint @summerscar/dsh-mnemon-sync # Diagnostic contents; read-only
```

The registry uses `schemaVersion: 2`. Local checks compare the working tree with `HEAD`; publishing CI sets `RELEASE_STATE_BASE` to the pre-push commit. Validation requires forward stage progression through `testing` and preservation of `publication` records.

## Publishing with npm Trusted Publishing (OIDC)

npm is deprecating bypass-2FA granular tokens with direct-publish access (removed January 2027). This repository publishes through **Trusted Publishing** instead: GitHub Actions obtains a short-lived OIDC credential, so **no long-lived `NPM_TOKEN` secret is needed**.

One-time setup on npmjs.com (npm CLI >= 11.5.1, Node >= 22.14 — CI uses Node 24.21.0 and installs latest npm):

1. npmjs.com → package `@summerscar/dsh-mnemon-sync` → **Settings** → **Trusted Publisher** → GitHub Actions.
2. Fill in exactly: owner/user `summerscar`, repository `dsh-plugins`, workflow filename `npm-publish.yml` (case-sensitive, must include `.yml`). Optionally set **Allowed actions** to allow `npm publish` in addition to the default `npm stage publish`.
3. Complete one successful publish within **2 days**, or the configuration expires and must be recreated.
4. Optionally set **Publishing access → Require two-factor authentication and disallow tokens**, then revoke any old automation tokens.

`npm-publish.yml` already grants `id-token: write`, points `actions/setup-node` at the npm registry, and removes the empty `_authToken` placeholder that `setup-node` writes into `.npmrc` (an empty placeholder makes npm fall back to token auth and fail with `ENEEDAUTH` instead of using OIDC). The `repository` field in `package.json` must match the GitHub repository case-sensitively. Provenance attestations are generated automatically.

## Restoring automatic publishing after this refactor

The monorepo refactor changes the packed archive (new dual-language READMEs, LICENSE, meta). A push to `main` triggers `npm-publish.yml`, which plans and publishes changed packages automatically. **Before the first push after this refactor, get explicit user authorization** and confirm the Trusted Publisher is configured on npmjs.com; then verify `npm view @summerscar/dsh-mnemon-sync@latest` for `repository`, `homepage`, `license`, and `engines`. Commits, pushes, npm publication, and site deployment all require explicit user authorization.

## Per-plan content and dependencies

Plans capture `sourceHashes` for packages and their local dependency closure, recompute them before publishing, and require current source, dependencies, and archive contents to match the plan. A held dependency supplying an npm version must already have that exact version published.
