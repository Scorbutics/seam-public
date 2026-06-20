// TYPESCRIPT carrier-tracing — thin bindings of the generic walk (coupling/carrier/lang) to the TS adapter.
// The tracing ALGORITHM is language-agnostic; the TS specifics live in the TS_LANG adapter (carrier.ts).
import { traceCarrierWith, methodSourceWith } from "../../codebase/coupling/carrier/lang.js";
import type { CarrierEffect } from "../../codebase/coupling/carrier/trace.js";
import { TS_LANG } from "./carrier.js";
import type { TsIndex } from "./dispatch.js";

export { resetParseCache as _resetParseCache } from "../../core/treesitter.js";

export const traceCarrier = (repo: string, index: TsIndex, className: string, method: string): Promise<CarrierEffect> =>
  traceCarrierWith(TS_LANG, repo, index, className, method);
export const methodSource = (repo: string, index: TsIndex, className: string, method: string): Promise<string | null> =>
  methodSourceWith(TS_LANG, repo, index, className, method);
