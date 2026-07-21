// COUPLING WORKER POOL (the 2.4× win). Spawned once (singleton), reused across grows. Before a batch, `ship()`
// sends the repo-wide ctx GROUNDING indices to every worker (once per grow — they're repo-specific and cheap to
// clone, ~tens of ms; re-shipped per grow so a reused pool never serves stale indices). `dispatch()` then fans a
// batch of per-file coupling tasks across the workers and returns the deltas IN INPUT ORDER, so the main thread
// merges them in the original `_fanCouple` file order → byte-identical to the per-node sequential baseline.
//
// Gated by getCouplePool(): active only when SEAM_PARALLEL_GROW is on AND `Worker` exists AND a per-node budget
// is set (SEAM_PER_NODE_BUDGET — coupling parallelism REQUIRES the order-independent per-node budget; without it
// the grow-wide budget is order-dependent and the parallel deltas would diverge). Otherwise null → sequential.

export type CoupleTask = {
  repo: string; file: string; anchorId: string; srcRange: [number, number] | undefined;
  fileNodes: { id: string; range: [number, number] }[]; counter: number; opts: any;
};

type Waiter = (r: { d?: any; err?: string }) => void;

// The env config workers must load BEFORE importing the coupling module (module-load-time consts).
const WORKER_ENV_KEYS = ["SEAM_PER_NODE_BUDGET", "SEAM_COPRODUCERS", "SEAM_METHOD_PRECISE", "SEAM_COUPLING_FILE_CACHE", "SEAM_JPA_WRAPPER"];
function workerEnv(): Record<string, string> {
  const e: Record<string, string> = {};
  for (const k of WORKER_ENV_KEYS) if (process.env[k] !== undefined) e[k] = process.env[k]!;
  return e;
}

export class CouplePool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { task: CoupleTask; resolve: Waiter }[] = [];
  private busy = new Map<Worker, Waiter>();
  private shipCbs = new Map<Worker, () => void>();
  private seq = 0;

  constructor(size: number) {
    const url = new URL("./couple_worker.ts", import.meta.url);
    for (let i = 0; i < size; i++) {
      const w = new Worker(url);
      w.onmessage = (e: any) => this._onmsg(w, e.data);
      w.onerror = (e: any) => this._onerr(w, String(e?.message ?? e));
      this.workers.push(w);
    }
  }

  private _onmsg(w: Worker, data: any): void {
    if (data?.type === "ready") { const cb = this.shipCbs.get(w); this.shipCbs.delete(w); cb?.(); return; }
    const cb = this.busy.get(w); this.busy.delete(w); this.idle.push(w);
    cb?.(data as { d?: any; err?: string }); this._pump();
  }
  private _onerr(w: Worker, err: string): void {
    // an error during ship or dispatch — resolve whichever is pending for this worker so nothing hangs
    const sc = this.shipCbs.get(w); if (sc) { this.shipCbs.delete(w); sc(); return; }
    const cb = this.busy.get(w); this.busy.delete(w); this.idle.push(w); cb?.({ err }); this._pump();
  }

  // Send the repo-wide indices to every worker; resolves once all have acked. Call before each dispatch batch
  // (re-ships per grow so a reused pool never serves stale indices / footprint scope / stableFloor mode).
  async ship(idx: Record<string, unknown>, footprintFiles?: string[], stableFloor?: boolean): Promise<void> {
    const env = workerEnv();
    await Promise.all(this.workers.map((w) => new Promise<void>((ready) => {
      this.shipCbs.set(w, ready);
      w.postMessage({ type: "init", idx, env, footprintFiles, stableFloor });
    })));
    this.idle = [...this.workers];
  }

  private _pump(): void {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const { task, resolve } = this.queue.shift()!;
      this.busy.set(w, resolve);
      w.postMessage({ id: this.seq++, task });
    }
  }
  private _run(task: CoupleTask): Promise<{ d?: any; err?: string }> {
    return new Promise((resolve) => { this.queue.push({ task, resolve }); this._pump(); });
  }

  // Resolve a batch of per-file coupling deltas off-thread. Results align with the INPUT order. A task that errors
  // resolves to null → the caller resolves that one file inline (byte-identical), so a worker failure never
  // changes the answer, only its latency.
  async dispatch(tasks: CoupleTask[]): Promise<(any | null)[]> {
    const rs = await Promise.all(tasks.map((t) => this._run(t)));
    return rs.map((r) => (r.err ? null : (r.d ?? null)));
  }

  terminate(): void { for (const w of this.workers) w.terminate(); this.workers = []; this.idle = []; this.queue = []; this.busy.clear(); }
}

let _pool: CouplePool | null = null;

// Lazy singleton coupling pool. Null unless SEAM_PARALLEL_GROW + Worker + a per-node budget (the parallelism
// invariant). Memory-capped size (coupling + shipped indices are heavier than structural — a big repo × many
// workers OOMs; cap conservatively, tune via SEAM_GROW_WORKERS).
export function getCouplePool(): CouplePool | null {
  const on = process.env.SEAM_PARALLEL_GROW === "1" || process.env.SEAM_PARALLEL_GROW === "true";
  const perNode = parseInt(process.env.SEAM_PER_NODE_BUDGET ?? "", 10) > 0;
  if (!on || !perNode || typeof Worker === "undefined") return null;
  if (_pool) return _pool;
  let size = parseInt(process.env.SEAM_GROW_WORKERS ?? "", 10);
  if (!Number.isFinite(size) || size <= 0) {
    const os = (() => { try { return require("node:os"); } catch { return null; } })();
    const cores = os ? os.cpus().length : 4;
    const freeGB = os ? os.freemem() / 2 ** 30 : 4;
    size = Math.max(2, Math.min(cores - 2, 4, Math.max(1, Math.floor(freeGB - 2))));
  }
  try { _pool = new CouplePool(size); } catch { _pool = null; }
  return _pool;
}

// The repo-wide ctx index maps a coupling worker needs (all pure-data GroundingIndex Maps → structured-clone).
export const COUPLE_SHIP_KEYS = ["sharedKey", "paramKeys", "floorBase", "floorContribs", "llmKey", "matcherIdx",
  "jpaManagers", "httpClients", "composedRoutes", "repoMatchers", "annotMatchers", "effectMatchers",
  "carrierChannel", "langIndex"];
export function serializeCtxIndices(ctx: any): Record<string, unknown> {
  const idx: Record<string, unknown> = {};
  for (const k of COUPLE_SHIP_KEYS) if (ctx[k] instanceof Map && ctx[k].size) idx[k] = ctx[k];
  return idx;
}
