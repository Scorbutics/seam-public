// Byte-identical harness — Rust project_consumer_set / project_dependency_set / gather_refactor_facts vs TS.
import { createRequire } from "node:module";
import { projectConsumerSet, projectDependencySet } from "../../ts/src/codebase/grow/project_set.js";
import { gatherRefactorFacts } from "../../ts/src/codebase/grow/refactor_facts.js";
import { build_footprint } from "../../ts/src/codebase/scan/footprint.js";
import { EngineCtx } from "../../ts/src/codebase/engine_ctx.js";
import { couplingOtherSides } from "../../ts/src/codebase/coupling/index.js";
process.env.SEAM_GRAPH_CACHE = "0"; // TS cache conflates same-name symbols — compare pure compute
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxAnchors = parseInt(process.argv[3] ?? "60", 10);
const glob = process.argv[4] ?? "*.java";

// Anchors = a sample of method/function/class defs across the repo (the realistic query targets).
const defs = (addon.enumerateDefs(repo, 200000, undefined, false) as any[])
  .filter((d) => d.file.endsWith(glob.replace("*", "")) && ["method", "function", "class"].includes(d.kind) && d.name);
const step = Math.max(1, Math.floor(defs.length / maxAnchors));
const anchors = defs.filter((_, i) => i % step === 0).slice(0, maxAnchors);

const serMember = (m: any) => `${m.symbol}|${m.file}|${m.line}|${m.kind}|${m.enclosing}|${m.edgeKind}|${m.provenance}`;
const serSet = (s: any) =>
  [`shape=${s.shape}`, `anchor=${s.anchor?.symbol ?? s.anchorSymbol}#${s.anchor?.file ?? s.anchorFile}`,
   `noStructure=${s.noStructure ?? false}`, `reason=${s.reason ?? ""}`, `rq=${s.resolutionQuality}`,
   `members[${(s.members ?? []).length}]:`, ...(s.members ?? []).map(serMember),
   `unresolved[${(s.unresolved ?? []).length}]:`, ...(s.unresolved ?? []).map((u: any) => `${u.mechanism}|${u.evidence}|${(u.candidates ?? []).join(",")}`),
   `recalled[${(s.recalled ?? []).length}]:`, ...(s.recalled ?? []).map(serMember)].join("\n");

const ctx = new EngineCtx();
let ok = 0, bad = 0; const fails: string[] = [];
const cmp = (tag: string, rel: string, sym: string, a: string, b: string) => {
  if (a === b) { ok++; return; }
  bad++;
  if (fails.length < 8) {
    const al = a.split("\n"), bl = b.split("\n");
    const k = al.findIndex((l, j) => l !== bl[j]);
    fails.push(`✗ ${tag} ${rel}#${sym}\n  ts:   ${al[k] ?? "<none>"}\n  rust: ${bl[k] ?? "<none>"}`);
  }
};

// CROSS-STACK OVERLAY — the shapes' data-coupling half, compared the way the CLI composes it: the STRUCTURAL
// set is coupling-free by contract (see queries.ts — running per-node coupling there disabled the footprint
// cache and bought nothing), and the overlay is a SEPARATE targeted pass whose crossings are deduped against
// the structural members. So `data_coupling` is exercised where it actually lives, on the bridge, and both
// halves are compared per anchor: the set with the flag ON and OFF (it must not perturb the structural answer)
// and the overlay's crossings + its stated truncations.
const serSides = (xs: any[]) =>
  xs.map((s) => `${s.kind}|${s.value}|${s.file}|${s.symbol}|${s.edgeKind ?? s.edge_kind}|${s.provenance}`).join("\n");
const serTrunc = (xs: any[]) =>
  xs.map((t) => `${t.kind}|${t.value}|${t.scanned}|${t.total}|${t.reason}`).join("\n");

for (const d of anchors) {
  const { file, name } = d;
  // consumers (up)
  const upG = await build_footprint(repo, file, name, { direction: "up", dataCoupling: false, llm: false, ctx });
  const tsUp = serSet(projectConsumerSet(upG as any));
  cmp("consumers", file, name, tsUp, serSet(addon.projectConsumerSet(repo, file, name, false)));
  // dependencies (down)
  const downG = await build_footprint(repo, file, name, { direction: "down", dataCoupling: false, llm: false, ctx });
  cmp("deps", file, name, serSet(projectDependencySet(downG as any)), serSet(addon.projectDependencySet(repo, file, name, false)));
  // the same flag on BOTH engines. NOT "the flag changes nothing": it genuinely does — a dataCoupling
  // footprint takes the whole-file/overlay path, and on
  // organization-attributes.repository.ts#createOrganizationAttribute the one RESOLVED structural member
  // disappears (1 member → noStructure) on TS and Rust ALIKE. That is why the consumers shape is structural by
  // contract in queries.ts. What this pins is that the two engines answer the flag IDENTICALLY.
  const upDcG = await build_footprint(repo, file, name, { direction: "up", dataCoupling: true, llm: false, ctx });
  cmp("consumers[dc]", file, name, serSet(projectConsumerSet(upDcG as any)), serSet(addon.projectConsumerSet(repo, file, name, true)));
  // the OVERLAY itself: crossings, and the bounds that bit while finding them.
  const bctx = new EngineCtx();
  const tsSides = await couplingOtherSides(repo, file, name, { llm: false }, bctx);
  const rsSides = addon.couplingOtherSides(repo, file, name);
  cmp("crossStack", file, name, serSides(tsSides), serSides(rsSides.sides));
  cmp("crossStack.trunc", file, name, serTrunc(bctx.couplingTruncations), serTrunc(rsSides.truncations));
}

// refactor_facts — heavier (impact+contract); sample a smaller subset
const rfSer = (rf: any) =>
  [`shape=${rf.shape}`, `anchor=${rf.anchor?.symbol ?? rf.anchorSymbol}#${rf.anchor?.file ?? rf.anchorFile}`,
   `impact.total=${rf.impact.total}`, `impact.fileCount=${rf.impact.fileCount}`, `impact.hops=${rf.impact.hops}`,
   `impact.noStructure=${rf.impact.noStructure ?? false}`, `impact.gaps=${rf.impact.gaps.length}`,
   `deps:`, serSet(rf.dependencies),
   `contract.module=${rf.contract.module}`, `contract.provides=${rf.contract.provides.length}`,
   `contract.afferent=${rf.contract.afferent}`, `contract.efferent=${rf.contract.efferent}`,
   `contract.unused=${rf.contract.unusedExports.length}`].join("\n");
for (const d of anchors.filter((_, i) => i % 3 === 0)) {
  const { file, name } = d;
  const tsRf = await gatherRefactorFacts(repo, file, name, {});
  const rustRf = addon.gatherRefactorFacts(repo, file, name);
  cmp("refactor", file, name, rfSer(tsRf), rfSer(rustRf));
}

console.log(`\nshapes-set parity over ${glob}: ${ok} ok / ${bad} bad (anchors ${anchors.length})`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
