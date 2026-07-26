// Byte-identical harness — Rust `sub_resources` / `locators` vs the TS `subResources` / `locators`
// (route_composer.ts), over a real JAX-RS corpus.
//
// These two are the DETECTION half of the composed-route axis: which classes are mount-blind sub-resources,
// and which methods mount them under which segment. They decide what the composer is even asked to compose,
// so a drift here is invisible in the output — the model is simply never asked about a class, and a
// cross-stack route crossing silently fails to ground. The composition itself needs a model and is therefore
// not compared here; its parse/guard logic is pinned by the Rust unit tests.
//
//   bun rust/parity/composeroutes.ts [repo] [maxFiles]
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { subResources, locators } from "../../ts/src/codebase/coupling/route_composer.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "4000", 10);

// Only annotated files can mount or be mounted — the same cheap pre-filter both engines apply.
const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "*.java"], { maxBuffer: 512 * 1024 * 1024 })
  .toString().split("\0").filter(Boolean).slice(0, maxFiles);

const serSubs = (subs: any[]) =>
  subs.map((s) => `${s.className ?? s.class_name}[${(s.handlers ?? []).map((h: any) => `${h.verb} ${h.name}@${h.line}${h.own ? `/${h.own}` : ""}`).join(",")}]`).join(";");
const serLocs = (ls: any[]) =>
  ls.map((l: any) => Array.isArray(l) ? `${l[0]}=${l[1]}` : `${l.returnType}=${l.seg}`).join(";");

let ok = 0, bad = 0, withSub = 0, withLoc = 0;
const fails: string[] = [];
for (const f of files) {
  let text = "";
  try { text = readFileSync(`${repo}/${f}`, "utf-8"); } catch { continue; }
  if (!text.includes("@")) continue;
  const tsSubs = serSubs(subResources(text)), rsSubs = serSubs(addon.subResources(text));
  const tsLocs = serLocs(locators(text)), rsLocs = serLocs(addon.routeLocators(text));
  if (tsSubs) withSub++;
  if (tsLocs) withLoc++;
  for (const [tag, a, b] of [["subResources", tsSubs, rsSubs], ["locators", tsLocs, rsLocs]] as [string, string, string][]) {
    if (a === b) { ok++; continue; }
    bad++;
    if (fails.length < 8) fails.push(`✗ ${tag} ${f}\n  ts:   ${a.slice(0, 160)}\n  rust: ${b.slice(0, 160)}`);
  }
}

console.log(`\nroute-composer detection parity over ${repo}`);
console.log(`  files compared: ${files.length}   with a sub-resource: ${withSub}   with a locator: ${withLoc}`);
console.log(`  byte-identical: ${ok}   mismatches: ${bad}`);
for (const f of fails) console.log(f);
// A corpus with NO sub-resource and NO locator would compare only empties — green while proving nothing.
if (!withSub && !withLoc) { console.log("  REFUSING to pass: the corpus exercised neither detector."); process.exit(2); }
process.exit(bad ? 1 : 0);
