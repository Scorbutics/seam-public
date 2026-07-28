#!/usr/bin/env bun
// seam-adapters — inspect & promote the LLM-LEARNED data-coupling adapters in `.seam/`. Keeps the
// product simple/transparent (the anti-Augment angle): the learned adapters are plain, named, reviewable
// records you can list, then PROMOTE into your shared ~/.seam store — and from there review + hand-port
// the good ones into the Seam repo as deterministic adapters.
//
//   bun ts/src/cli/adapters.ts list [--repo .]            # learned adapters (repo .seam + shared ~/.seam)
//   bun ts/src/cli/adapters.ts promote <name> [--repo .]  # copy a repo adapter up into shared ~/.seam
//   bun ts/src/cli/adapters.ts where                       # print the repo + shared .seam locations
//
// The STORES are the core's (`seam-couple`): the same `.seam/key-adapters.json` and
// `carrier-signatures.json` the engine learns into and replays from. This CLI reads them through the addon
// rather than through a second TypeScript reader — two readers of one store is how a promoted adapter shows
// up in the listing and not in the engine, or the reverse.
import { loadAddon } from "../codebase/rust_core.js";
import { join } from "node:path";

const core = () => {
  const a = loadAddon();
  if (!a) { console.error("the Seam core (Rust addon) is not available — build it with `cargo build --release` in rust/"); process.exit(3); }
  return a;
};

interface Learned { name: string; description: string; detail: string; type: "key" | "carrier" | "matcher"; shared: boolean }

// `[name, shape, kind, role, scope]` / `[name, description, key, count, scope]` / `[name, description,
// direction, medium, key, scope]` — the addon's flat rows, each carrying the SCOPE the reviewer decides about.
const learnedAdapters = (repo: string): Learned[] => {
  const a = core();
  const out: Learned[] = [];
  for (const [name, shape, kind, role, scope] of a.listMatchers(repo) as string[][])
    out.push({ name, description: "", detail: `${shape} → ${role} ${kind}`, type: "matcher", shared: scope === "shared" });
  for (const [name, description, key, count, scope] of a.listKeyAdapters(repo) as string[][])
    out.push({ name, description, detail: `${count} key(s) — ${key.split(" ")[0]}`, type: "key", shared: scope === "shared" });
  for (const [name, description, direction, medium, key, scope] of a.listLearnedCarriers(repo) as string[][])
    out.push({ name, description, detail: `${direction}/${medium} — ${key.split(" ")[0]}`, type: "carrier", shared: scope === "shared" });
  return out;
};

const sharedSeamDir = (): string => core().sharedSeamDir();
const builtinAdapters = () => (core().builtinAdapters() as string[][]).map(([name, kind, blurb]) => ({ name, kind, blurb }));
const couplingCapabilities = () => (core().couplingCapabilities() as string[][])
  .map(([kind, nodeKind, tier, ...detectedBy]) => ({ kind, nodeKind, tier: tier as "built-in" | "learned", detectedBy }));

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
  const all = learnedAdapters(repo);
  // A name in the SHARED store is `promoted` — it also lingers in the repo store, since promote COPIES.
  const sharedNames = new Set(all.filter((a) => a.shared).map((a) => a.name));
  const item = (a: Learned) => ({ name: a.name, type: a.type, description: a.description, detail: a.detail });
  const dedup = (xs: ReturnType<typeof item>[]) => [...new Map(xs.map((x) => [x.name, x])).values()];
  const promoted = dedup(all.filter((a) => a.shared || sharedNames.has(a.name)).map(item));
  const learnt = dedup(all.filter((a) => !a.shared && !sharedNames.has(a.name)).map(item));
  console.log(JSON.stringify({
    capabilities: couplingCapabilities(),   // every boundary archetype + tier (built-in det vs learned-on-review)
    builtin: builtinAdapters(),
    learnt,
    promoted,
    locations: { repo: join(repo, ".seam"), shared: sharedSeamDir() },
  }));
}

// The boundary archetypes Seam can couple across, by tier — so "does Seam handle events/queues?" is
// answerable WITHOUT having warmed a repo: built-in archetypes detect deterministically/offline; learned
// ones have the same kind semantics but their detection warms on the first LLM-enabled review.
function printCapabilities(): void {
  const caps = couplingCapabilities();
  console.log("COUPLING CAPABILITIES (boundary archetypes Seam grounds across):");
  for (const c of caps) {
    const how = c.tier === "built-in" ? `built-in (${c.detectedBy.join(", ")})` : "learned — warms on first --data-coupling llm review";
    console.log(`  ${c.tier === "built-in" ? "●" : "○"} ${c.kind.padEnd(11)} ${how}`);
  }
}

function list(repo: string): void {
  const all = learnedAdapters(repo);
  printCapabilities();
  if (!all.length) { console.log(`\nno learned adapters yet (run a footprint with --data-coupling llm).\n  repo:   ${join(repo, ".seam")}\n  shared: ${sharedSeamDir()}`); return; }
  for (const shared of [false, true]) {
    const here = all.filter((a) => a.shared === shared);
    if (!here.length) continue;
    console.log(`\n${shared ? "SHARED" : "REPO"}:`);
    // RULE adapters first — the reusable shared-key matchers, the real "adapters"; then carriers, then the
    // per-file keys (the least general, and the least likely to be worth promoting).
    for (const kind of ["matcher", "carrier", "key"] as const)
      for (const a of here.filter((x) => x.type === kind)) {
        console.log(`  ${kind.padEnd(8)} ${a.name}  ${a.detail}`);
        if (a.description) console.log(`             ${a.description}`);
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
    const kind = core().promoteAdapter(repo, name);   // "" = the name matched nothing
    if (kind) { console.log(`promoted ${kind} adapter '${name}' → ${sharedSeamDir()}`); return; }
    console.error(`no repo adapter named '${name}' (try: seam-adapters list)`); process.exit(1);
    return;
  }
  console.error("usage: seam-adapters <list|promote <name>|where> [--repo .]");
  process.exit(2);
}

main();
