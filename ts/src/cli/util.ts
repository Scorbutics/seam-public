// Shared CLI helpers used by both decompose.ts (diff mode + runCodebase orchestration) and queries.ts
// (the --query shape handlers) — split out to avoid a circular import between the two.
import { ledgerSnapshot } from "../codebase/coupling/ledger.js";
import { stampSeamModel } from "../core/contract.js";

export function err(msg: string): never { process.stderr.write(`error: ${msg}\n`); process.exit(2); }

// Attach the learned-adapter LEDGER (which `.seam/` adapters this run consulted + newly learned) to the
// model before stamping, so every client surfaces the flywheel and can offer `seam-adapters promote`.
// No-op when nothing learned/used (a normal det run with no `.seam/`), so it never adds noise.
export function stamp<T extends Record<string, any>>(model: T): T {
  const led = ledgerSnapshot();
  if (led.used.length || led.learned.length) (model as any).adapters = led;
  return stampSeamModel(model);
}
