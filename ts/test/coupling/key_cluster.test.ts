// STRUCTURAL pre-clustering of floor-blind files (key_cluster.ts) — the upfront, deterministic half of the
// flywheel: files sharing a data-access SHAPE (`prisma.<x>.<verb>()`) collapse into ONE cluster so the LLM
// reads a single representative, and the rest of the cluster grounds via the learned rule. This is what cuts
// the LLM INPUT (30 near-identical Prisma files → 1) rather than just caching it.
//
// Guards on tree-sitter: the signature is AST-derived, so without `available()` the clusterer degrades to
// one-cluster-per-file (no collapse). The test early-returns in that case so it stays green on the offline
// .vsix — exactly as the engine degrades.
import { describe, expect, test } from "bun:test";
import { clusterBlindFiles } from "../../src/codebase/coupling/key_cluster.js";
import { available } from "../../src/codebase/atoms.js";

describe("structural pre-clustering of floor-blind files", () => {
  // same receiver-member shape, DIFFERENT models/verbs — these must collapse to ONE cluster
  const prismaA = { file: "a.ts", text: `export async function a() { return prisma.eventType.findMany(); }` };
  const prismaB = { file: "b.ts", text: `export async function b(x) { await prisma.user.update({ data: x }); }` };
  const prismaC = { file: "c.ts", text: `export async function c() { return prisma.booking.create({ data: {} }); }` };
  // a DIFFERENT distinctive shape (a string-keyed bus channel) — its own cluster
  const bus = { file: "bus.ts", text: `export function emit() { bus.publish("sync.done", {}); }` };
  // no recognised data-access shape — a singleton, never collapsed
  const plain = { file: "plain.ts", text: `export function add(a, b) { return a + b; }` };

  test("collapses same-shape files to ONE representative, keeps distinct shapes + shapeless separate", async () => {
    if (!available()) return;   // tree-sitter absent → degrades to no-collapse; nothing to assert
    const clusters = await clusterBlindFiles([prismaA, prismaB, prismaC, bus, plain]);

    // 3 prisma → 1, bus → 1, plain → 1  ⇒  3 clusters total (collapsed 2 of 5 files)
    expect(clusters.length).toBe(3);

    // clustered by the RECEIVER (the data object): prisma.eventType.findMany / prisma.user.update /
    // prisma.booking.create all collapse to recv:prisma regardless of model or verb
    const prismaCluster = clusters.find((c) => c.signature === "recv:prisma");
    expect(prismaCluster).toBeDefined();
    expect(prismaCluster!.members.map((m) => m.file).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(["a.ts", "b.ts", "c.ts"]).toContain(prismaCluster!.rep.file);   // the rep is one of the cluster's files

    // the bus channel clusters on its receiver, the plain file is its own shapeless singleton
    expect(clusters.some((c) => c.signature === "recv:bus" && c.members.length === 1)).toBe(true);
    expect(clusters.some((c) => c.signature === "" && c.members[0].file === "plain.ts")).toBe(true);
  });

  test("clusters a channel's read AND write by receiver (so one rep teaches the producer+consumer pair)", async () => {
    if (!available()) return;
    const reader = { file: "r.ts", text: `export function load() { return JSON.parse(localStorage.getItem("draft")); }` };
    const writer = { file: "w.ts", text: `export function save(v) { localStorage.setItem("draft", JSON.stringify(v)); }` };
    const clusters = await clusterBlindFiles([reader, writer]);
    // getItem (consumes) and setItem (produces) share receiver localStorage → ONE cluster (was two by method)
    expect(clusters.length).toBe(1);
    expect(clusters[0].signature).toBe("recv:localStorage");
    expect(clusters[0].members.map((m) => m.file).sort()).toEqual(["r.ts", "w.ts"]);
  });

  test("a `this.*` chain is NOT a distinctive signature (no over-merge of unrelated files)", async () => {
    if (!available()) return;
    const x = { file: "x.ts", text: `class X { run() { return this.svc.repo.load(); } }` };
    const y = { file: "y.ts", text: `class Y { go() { return this.api.client.fetch(); } }` };
    const clusters = await clusterBlindFiles([x, y]);
    // both are `this.*.*()` but on unrelated receivers → must NOT collapse into one cluster
    expect(clusters.length).toBe(2);
  });

  test("degrades safely: a single file is one cluster (no work)", async () => {
    const clusters = await clusterBlindFiles([prismaA]);
    expect(clusters.length).toBe(1);
    expect(clusters[0].members.length).toBe(1);
  });
});
