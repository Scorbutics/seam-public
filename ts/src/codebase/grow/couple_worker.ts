// WORKER ENTRY for parallel COUPLING (the 2.4× win — docs: parallel-grow-plan). Unlike structural resolution,
// a coupling call (`_fileCouplingDelta` → resolveCoupling) is ~1.6s, so the worker dispatch + one-time index
// SHIP is negligible relative to the work — which is why coupling parallelizes profitably where the structural
// wave did not. Per-node budget (SEAM_PER_NODE_BUDGET, set in the init env BELOW before the module loads) makes
// each file's coupling ORDER-INDEPENDENT, so a partition of files resolves byte-identically to the sequential
// per-node baseline; the main thread merges the deltas in the original order.
//
// The worker holds the repo-wide ctx GROUNDING indices SHIPPED once at init (they don't structurally-clone-rebuild
// — validated byte-identical + fast, no 20s per-worker rebuild). It resolves whole files and may write its OWN
// per-file disk shards (coupling-delta-v1 / mp-index-v1) — safe because each file is dispatched once (the main
// thread's `coupled` set dedups), so distinct files touch distinct shards with no write race.

declare const self: {
  onmessage: ((e: { data: any }) => void) | null;
  postMessage: (m: any) => void;
};

let _fileCouplingDelta: any;
let ctx: any;

self.onmessage = async (e: { data: any }) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      // Set module-load-time config (SEAM_PER_NODE_BUDGET, SEAM_COPRODUCERS, …) BEFORE importing the coupling
      // module — its _PER_NODE_BUDGET is a load-time const. Then rehydrate the shipped repo-wide indices.
      if (m.env) for (const [k, v] of Object.entries(m.env)) process.env[k] = v as string;
      ({ _fileCouplingDelta } = await import("./orchestrate.js"));
      const { EngineCtx } = await import("../engine_ctx.js");
      ctx = new EngineCtx();
      for (const k of Object.keys(m.idx)) (ctx as any)[k] = m.idx[k];
      if (m.footprintFiles) ctx.footprintFiles = new Set(m.footprintFiles);
      ctx.stableFloor = !!m.stableFloor;   // the probe's floor-only _fanCouple bypasses the delta cache (must match main)
      self.postMessage({ type: "ready" });
      return;
    }
    const { id, task } = m;
    const d = await _fileCouplingDelta(task.repo, task.file, task.anchorId, task.srcRange, task.fileNodes, task.counter, task.opts, ctx);
    self.postMessage({ id, d });
  } catch (err: any) {
    self.postMessage({ id: m.id, err: String(err?.stack ?? err?.message ?? err) });
  }
};
