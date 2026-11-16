#!/usr/bin/env node
// Wait until the npm registry's packument CDN has caught up with the versions
// the publish flow just shipped, so the site build reads the freshest
// `dist-tags.latest` instead of a stale CDN replica.
//
//   node site/fresh.mjs [--timeout 300] [--poll 15]
//
// The truth source is index.json: the market index the publish flow rewrites
// with `pnpm site:market` right before it commits. Each entry records the
// version the publish just put on npm, so "the registry now reports that
// version as latest" is exactly "npm publish is done and visible". A plain
// code-only push leaves index.json equal to the current registry state, so
// the first poll passes with no added latency.
//
// On timeout the script warns and exits 0 rather than failing the run:
// `deploy-pages` always serves the most recent `github-pages` artifact and the
// next publish re-triggers this flow, so a transient CDN lag self-heals,
// whereas a hard red run would skip the deploy and keep the old page up —
// the very symptom this step exists to fix.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  if (!value) throw new Error(`${name} needs a value`);
  return value;
};
const timeoutMs = Number(option("--timeout") ?? 300_000);
const pollMs = Number(option("--poll") ?? 15_000);
const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

const indexPath = resolve(join(here, "..", "index.json"));
const index = JSON.parse(readFileSync(indexPath, "utf8"));
const expected = new Map(index.plugins.map((p) => [p.name, p.versions?.at(0)?.version]));

function missing() {
  // A plugin with no recorded version cannot be verified; skip it.
  return [...expected.entries()].filter(([, version]) => typeof version === "string" && version);
}

const wanted = missing();
if (!wanted.length) {
  console.log("fresh: index.json records no versions; nothing to wait for.");
  process.exit(0);
}

async function latest(name) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return null; // Not published yet; the next trigger will pick it up.
  if (!response.ok) throw new Error(`npm registry ${name}: HTTP ${response.status}`);
  return (await response.json())["dist-tags"]?.latest ?? null;
}

async function check() {
  const now = await Promise.all(wanted.map(async ([name]) => {
    try { const got = await latest(name); return { name, got, error: null }; }
    catch (error) { return { name, got: null, error: error.message }; }
  }));
  // Block only while the registry is strictly BEHIND the version the publish
  // flow recorded. If the registry is ahead (a newer publish landed first),
  // the site will show the newer version — that is fine, so do not wait.
  const unsatisfied = now.filter((row) => row.error || (row.got !== null && !isAtOrAhead(row.name, row.got)));
  return { now, unsatisfied };
}

// index.json records plain `latest` dist-tag versions only (the market index
// is derived from `dist-tags.latest`), so a numeric major.minor.patch compare
// is enough. Block only while the registry's latest is strictly behind the
// recorded version; equal or ahead both pass (ahead = a newer publish landed,
// and the site showing it is the desired outcome).
// Block only while the registry's latest is strictly BEHIND the recorded
// version. `isBehind(candidate, recorded)` is true when the registry's
// candidate is numerically older than what the publish flow recorded.
function isAtOrAhead(name, got) {
  return !isBehind(got, expected.get(name));
}
function isBehind(candidate, recorded) {
  const a = parse(candidate), b = parse(recorded);
  if (!a || !b) return false; // Unknown shape: do not block the build.
  for (const i of [0, 1, 2]) if (a[i] !== b[i]) return a[i] < b[i];
  return false; // numerically equal -> not behind
}
function parse(version) {
  const numeric = String(version ?? "").split("-")[0].split(".").map((part) => Number(part));
  return numeric.length === 3 && numeric.every(Number.isInteger) ? numeric : null;
}

const deadline = Date.now() + timeoutMs;
let attempt = 0;
for (;;) {
  attempt += 1;
  const { now, unsatisfied } = await check();
  if (!unsatisfied.length) {
    for (const row of now) console.log(`fresh: ${row.name} latest=${row.got ?? "absent"} (recorded ${expected.get(row.name)})`);
    console.log(`fresh: npm registry is up to date after ${attempt} check(s).`);
    process.exit(0);
  }
  const detail = unsatisfied.map((row) => row.error ? `${row.name}: ${row.error}` : `${row.name}: latest=${row.got ?? "absent"} (recorded ${expected.get(row.name)})`).join("; ");
  if (Date.now() + pollMs > deadline) {
    console.warn(`fresh: npm registry still behind after ${Math.round(timeoutMs / 1000)}s; building with the latest available version. ${detail}`);
    process.exit(0);
  }
  console.log(`fresh: waiting for npm registry (poll ${attempt}): ${detail}`);
  await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
}
