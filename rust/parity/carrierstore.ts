// CROSS-ENGINE STORE COMPATIBILITY — the carrier signature cache written by RUST must be read by TS, and
// vice versa, byte-for-byte.
//
// This is not a nicety. `.seam/carrier-signatures.json` is a SHARED, COMMITTED cache: a team runs the learning
// pass once (often in CI) and every later run — either engine, fully offline — replays it. If the two engines
// disagree about the file's shape or its content-hash KEY, the warm run silently misses, re-learns, rewrites
// the store, and the flywheel never settles. That failure is invisible: nothing errors, the answer is just
// quietly weaker and the LLM bill quietly returns.
//
// So both directions are exercised: Rust writes → TS reads, then TS writes → Rust reads, plus the key each
// engine derives for the same (class, method, source).
//
//   bun rust/parity/carrierstore.ts
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cachedSignature, persistSignature, hasLearnedCarrier } from "../../ts/src/codebase/coupling/carrier/cache.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

let ok = 0, bad = 0;
const fails: string[] = [];
const cmp = (tag: string, a: unknown, b: unknown) => {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  if (x === y) { ok++; return; }
  bad++;
  fails.push(`✗ ${tag}\n  expected: ${x}\n  actual:   ${y}`);
};

const SRC = "public void save(String path, byte[] data) { fs.write(path, data); }";
const SIG = { direction: "write", medium: "file", keyArg: 0, name: "filestore-save", description: "writes file via FileStore#save" };

// 0. THE KEY — both engines must derive the same `Class#method <sha1(src)>`, or every lookup misses.
{
  const rustKey = addon.carrierContentKey("FileStore", "save", SRC);
  // the TS key is internal to synth.ts; reproduce its documented shape and compare
  const { createHash } = await import("node:crypto");
  const tsKey = `FileStore#save ${createHash("sha1").update(SRC).digest("hex")}`;
  cmp("content key", tsKey, rustKey);
}

// 1. RUST writes → TS reads.
{
  const repo = mkdtempSync(join(tmpdir(), "seam-carrier-r2t-"));
  try {
    const key = addon.carrierContentKey("FileStore", "save", SRC);
    addon.persistCarrierSignature(repo, key, { direction: SIG.direction, medium: SIG.medium, keyArg: SIG.keyArg, name: SIG.name, description: SIG.description });
    const back = cachedSignature(repo, key);
    cmp("rust→ts hit", true, back.hit);
    cmp("rust→ts signature", SIG, back.sig);
    cmp("rust→ts hasLearnedCarrier", true, hasLearnedCarrier(repo));
    // and the on-disk shape itself, so a schema drift is caught even if both readers are lenient
    const raw = JSON.parse(readFileSync(join(repo, ".seam", "carrier-signatures.json"), "utf-8"));
    cmp("rust→ts schema", 1, raw.schema);
    cmp("rust→ts stored keys", [key], Object.keys(raw.signatures));
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// 2. TS writes → RUST reads (including the NON-carrier `null`, which must read back as a HIT — a known
//    non-carrier that reads as a MISS would be re-asked on every single run).
{
  const repo = mkdtempSync(join(tmpdir(), "seam-carrier-t2r-"));
  try {
    const key = addon.carrierContentKey("FileStore", "save", SRC);
    const nullKey = addon.carrierContentKey("Util", "compute", "int compute() { return 1; }");
    persistSignature(repo, key, SIG as any);
    persistSignature(repo, nullKey, null);
    cmp("ts→rust signature", SIG, addon.resolveCarrierSignature(repo, "FileStore", "save", SRC));
    cmp("ts→rust non-carrier reads as null", null, addon.resolveCarrierSignature(repo, "Util", "compute", "int compute() { return 1; }"));
    cmp("ts→rust hasLearnedCarrier", true, addon.hasLearnedCarrier(repo));
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

console.log(`\ncarrier store cross-engine compat: ${ok} ok / ${bad} bad`);
for (const f of fails) console.log(f);
process.exit(bad ? 1 : 0);
