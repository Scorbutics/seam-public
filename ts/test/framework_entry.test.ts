// is_framework_entry — GENERALIZED, framework-agnostic detection of framework/external entry points
// (the methods a container invokes: REST/scheduled/lifecycle handlers, message listeners). Signal:
// a METHOD-LEVEL annotation/decorator (ANY — no per-framework list) OR the enclosing class implements
// an interface NOT declared in-repo (external → its overrides are callbacks). Hermetic Java fixtures;
// the annotations are made-up names on purpose — presence is the signal, not which annotation.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { is_framework_entry } from "../src/codebase/import_scan.js";

const REPO = join(tmpdir(), "seam-fwentry-" + process.pid);
const w = (rel: string, t: string) => { const p = join(REPO, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  rmSync(REPO, { recursive: true, force: true });
  w("src/main/java/app/Handler.java",
    "package app;\npublic class Handler {\n  @Whatever public void handle(){}\n  @Route(\"/x\") public String route(){return null;}\n  public void helper(){}\n}\n");
  // implements an interface NOT declared in this repo (external) → onEvent is a framework callback
  w("src/main/java/app/Listener.java",
    "package app;\nimport ext.Bus;\npublic class Listener implements Bus {\n  public void onEvent(){}\n}\n");
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("framework-entry detection (agnostic)", () => {
  test("method with a marker annotation → entry", async () => {
    expect(await is_framework_entry(REPO, "src/main/java/app/Handler.java", "handle")).toBe(true);
  });
  test("method with an annotation that has args → entry", async () => {
    expect(await is_framework_entry(REPO, "src/main/java/app/Handler.java", "route")).toBe(true);
  });
  test("plain method (no annotation, class implements nothing external) → not an entry", async () => {
    expect(await is_framework_entry(REPO, "src/main/java/app/Handler.java", "helper")).toBe(false);
  });
  test("method of a class implementing an EXTERNAL interface → entry (framework callback)", async () => {
    expect(await is_framework_entry(REPO, "src/main/java/app/Listener.java", "onEvent")).toBe(true);
  });
});
