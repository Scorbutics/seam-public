// JAVA carrier-tracing — thin bindings of the generic walk (coupling/carrier/lang) to the Java adapter.
// The tracing ALGORITHM is language-agnostic; the Java specifics live in the JAVA_LANG adapter (carrier.ts).
import { traceCarrierWith, methodSourceWith } from "../../codebase/coupling/carrier/lang.js";
import type { CarrierEffect } from "../../codebase/coupling/carrier/trace.js";
import { JAVA_LANG } from "./carrier.js";
import type { JavaIndex } from "./dispatch.js";

export { resetParseCache as _resetParseCache } from "../../core/treesitter.js";

export const traceCarrier = (repo: string, index: JavaIndex, className: string, method: string): Promise<CarrierEffect> =>
  traceCarrierWith(JAVA_LANG, repo, index, className, method);
export const methodSource = (repo: string, index: JavaIndex, className: string, method: string): Promise<string | null> =>
  methodSourceWith(JAVA_LANG, repo, index, className, method);
