#!/usr/bin/env bun
// seam-adapters — inspect & promote the LLM-LEARNED data-coupling adapters in `.seam/`. Keeps the
// product simple/transparent (the anti-Augment angle): the learned adapters are plain, named, reviewable
// records you can list, then PROMOTE into your shared ~/.seam store — and from there review + hand-port
// the good ones into the Seam repo as deterministic adapters.
//
//   bun ts/src/cli/adapters.ts list [--repo .]            # learned adapters (repo .seam + shared ~/.seam)
//   bun ts/src/cli/adapters.ts promote <name> [--repo .]  # copy a repo adapter up into shared ~/.seam
//   bun ts/src/cli/adapters.ts where                       # print the repo + shared .seam locations
import { listLearnedAdapters, promoteSignature } from "../codebase/coupling/carrier/cache.js";
import { listKeyAdapters, promoteKeyAdapter } from "../codebase/coupling/key_cache.js";
import { builtinAdapters } from "../codebase/coupling/adapters/index.js";
import { sharedSeamDir } from "../codebase/coupling/seam_dir.js";
import { join } from "node:path";

function arg(flag: string, dflt: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const hasFlag = (flag: string): boolean => process.argv.includes(flag);

// Machine-readable adapter inventory for the VS Code extension / any client: the THREE statuses —
// `builtin` (deterministic, code-level, from the registry), `learnt` (repo-local `.seam/`, LLM-deduced,
// not yet shared) and `promoted` (copied into the shared store for reuse). Dedup by name: a name present
// in the shared store is `promoted` (it also lingers in repo); repo-only names are `learnt`.
function listJson(repo: string): void {
  const carriers = listLearnedAdapters(repo);
  const keys = listKeyAdapters(repo);
  const sharedNames = new Set([...carriers, ...keys].filter((a) => a.scope === "shared")
    .map((a) => "sig" in a ? a.sig.name : a.adapter.name));
  const item = (name: string, type: "key" | "carrier", description: string, detail: string) => ({ name, type, description, detail });
  const learnt: ReturnType<typeof item>[] = [];
  const promoted: ReturnType<typeof item>[] = [];
  for (const { adapter, scope } of keys) {
    const it = item(adapter.name, "key", adapter.description ?? "", `${adapter.keys.length} key(s)`);
    (scope === "shared" ? promoted : sharedNames.has(adapter.name) ? promoted : learnt).push(it);
  }
  for (const { sig, scope } of carriers) {
    const it = item(sig.name, "carrier", sig.description ?? "", `${sig.direction}/${sig.medium}`);
    (scope === "shared" ? promoted : sharedNames.has(sig.name) ? promoted : learnt).push(it);
  }
  // a name can appear in both stores (promote copies repo→shared) → keep one entry per (name) per bucket.
  const dedup = (xs: ReturnType<typeof item>[]) => [...new Map(xs.map((x) => [x.name, x])).values()];
  console.log(JSON.stringify({
    builtin: builtinAdapters(),
    learnt: dedup(learnt.filter((l) => !promoted.some((p) => p.name === l.name))),
    promoted: dedup(promoted),
    locations: { repo: join(repo, ".seam"), shared: sharedSeamDir() },
  }));
}

function list(repo: string): void {
  const carriers = listLearnedAdapters(repo);
  const keys = listKeyAdapters(repo);
  if (!carriers.length && !keys.length) { console.log(`no learned adapters yet (run a footprint with --data-coupling llm).\n  repo:   ${join(repo, ".seam")}\n  shared: ${sharedSeamDir()}`); return; }
  for (const scope of ["repo", "shared"] as const) {
    const cs = carriers.filter((a) => a.scope === scope);
    const ks = keys.filter((a) => a.scope === scope);
    if (!cs.length && !ks.length) continue;
    console.log(`\n${scope === "repo" ? "REPO" : "SHARED"}:`);
    for (const { key, sig } of cs) {
      console.log(`  carrier  ${sig.name}  [${sig.direction}/${sig.medium}]  ${key.split(" ")[0]}`);   // drop content hash
      if (sig.description) console.log(`             ${sig.description}`);
    }
    for (const { key, adapter } of ks) {
      console.log(`  key      ${adapter.name}  ${key.split(" ")[0]}`);
      if (adapter.description) console.log(`             ${adapter.description}`);
    }
  }
  console.log(`\npromote one with:  seam-adapters promote <name>   (→ ${sharedSeamDir()})`);
}

function main(): void {
  const cmd = process.argv[2];
  const repo = arg("--repo", ".");
  if (cmd === "list") return hasFlag("--json") ? listJson(repo) : list(repo);
  if (cmd === "where") { console.log(`repo:   ${join(repo, ".seam")}\nshared: ${sharedSeamDir()}`); return; }
  if (cmd === "promote") {
    const name = process.argv[3];
    if (!name || name.startsWith("--")) { console.error("usage: seam-adapters promote <name> [--repo .]"); process.exit(2); }
    const c = promoteSignature(repo, name);
    if (c.ok) { console.log(`promoted carrier '${name}' → ${sharedSeamDir()}\n  ${c.sig!.direction}/${c.sig!.medium} — ${c.sig!.description}`); return; }
    const k = promoteKeyAdapter(repo, name);
    if (k.ok) { console.log(`promoted key adapter '${name}' → ${sharedSeamDir()}\n  ${k.adapter!.description}`); return; }
    console.error(`no repo adapter named '${name}' (try: seam-adapters list)`); process.exit(1);
    return;
  }
  console.error("usage: seam-adapters <list|promote <name>|where> [--repo .]");
  process.exit(2);
}

main();
