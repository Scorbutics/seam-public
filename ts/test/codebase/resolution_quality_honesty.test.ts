// `resolution: FULL` IS A CLAIM, AND IT MUST NOT BE MADE OVER AN EMPTY SET.
//
// `resolutionQuality` was hardcoded to "FULL" on every path in project_set.rs, so a shape that resolved NOTHING
// still rendered `resolution: FULL | resolved: 0 consumer edges`. That sentence reads as "I scanned exhaustively
// and there is genuinely nothing" — the most expensive thing this tool can say, because a reader acts on it by
// stopping.
//
// It was not hypothetical. Benchmark run 4 (bench/grep-vs-seam) hit
// `{"noStructure":true,"resolutionQuality":"FULL","members":[]}` for `cn`, a symbol with 247 resolved consumer
// edges across 81 files, from a surface whose own documentation told the caller "don't retry; grep". The engine
// answering there was a stale build — but the LABEL is what turned a wrong answer into an authoritative one, and
// the label comes from the shared projection, not from that surface.
//
// The distinction now carried:
//   FULL  — something resolved; the tiers describe how much.
//   NONE  — in-edges exist but none resolve statically (opaque dispatch) → grep is the right next tool.
//   EMPTY — nothing found at all: possibly true, possibly a blind spot, NOT a verified negative.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { loadAddon } from "../../src/codebase/rust_core.js";
import { rustSetToModel } from "../../src/cli/queries.js";

// The SAME wiring `--query consumers` runs, so this asserts what the product actually emits.
const projectConsumerSet = (repo: string, file: string, symbol: string): any =>
  rustSetToModel((loadAddon() as any).projectConsumerSet(repo, file, symbol, false, false));

let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "seam-resq-"));
  // `used` has a real consumer; `orphan` has none at all.
  w("src/lib.ts", ["export function used() { return 1 }", "export function orphan() { return 2 }"].join("\n"));
  w("src/caller.ts", ['import { used } from "./lib"', "export function callsIt() { return used() }"].join("\n"));
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("resolutionQuality never overstates an empty answer", () => {
  test("a symbol with real consumers is FULL", () => {
    const s: any = projectConsumerSet(REPO, "src/lib.ts", "used");
    expect(s.members.length).toBeGreaterThan(0);
    expect(s.resolutionQuality).toBe("FULL");
    expect(s.noStructure).toBeFalsy();
  });

  test("a symbol with NO consumers is EMPTY, not FULL", () => {
    // THE ASSERTION THIS FILE EXISTS FOR. Before the fix this returned FULL with zero members — a verified
    // negative that was not verified.
    const s: any = projectConsumerSet(REPO, "src/lib.ts", "orphan");
    expect(s.members.length).toBe(0);
    expect(s.noStructure).toBe(true);
    expect(s.resolutionQuality).not.toBe("FULL");
    expect(s.resolutionQuality).toBe("EMPTY");
  });

  test("the two cases are distinguishable — an empty answer is never labelled like a resolved one", () => {
    const resolved: any = projectConsumerSet(REPO, "src/lib.ts", "used");
    const empty: any = projectConsumerSet(REPO, "src/lib.ts", "orphan");
    expect(resolved.resolutionQuality).not.toBe(empty.resolutionQuality);
  });
});
