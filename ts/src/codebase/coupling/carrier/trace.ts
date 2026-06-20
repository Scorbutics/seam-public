// CARRIER-TRACING — the language-agnostic mechanism (teacher 1). Given a method, follow each call it
// makes (resolved by the language's dispatch) until it reaches a KNOWN I/O SINK, learning the method's
// effect: direction (read/write) + medium (file/serialized/…). This is what turns a homemade-framework
// wrapper (`Yuki::VD#write_data`) into a classified carrier deterministically.
//
// The WALK lives here — depth cap, cycle guard, union-of-directions over followed candidates, honest
// blindspots. What's irreducibly per-language — reading the AST, the dispatch resolution, and the
// stdlib SINK REGISTRY (Ruby's Marshal/File, Java's Files/ObjectOutputStream, …) — lives behind the
// `CallGraph` seam: the language CLASSIFIES each call site into a generic `TraceCall`, and this walk
// only routes them. So a second language plugs in by implementing `CallGraph` over its own dispatch +
// sinks, without touching the walk. (Over-approximation via the direction union is safe — we union
// sink directions across followed candidates; unresolved/dynamic calls are recorded as blindspots.)
import type { MethodCandidate } from "../../../core/dispatch.js";

export type Direction = "read" | "write";
// One known terminal I/O effect — a direction + the medium reached. The registry mapping a call to a
// Sink is the language's (stdlib knowledge); this is just the shape.
export interface Sink { direction: Direction; medium: string }

export interface CarrierEffect {
  className: string;
  method: string;
  directions: Direction[];                              // [] = no sink reached
  media: string[];
  reached: { className: string; method: string }[];    // in-repo hops followed
  blindspots: string[];                                // dynamic / unresolved calls met on the way
  codeLoad: boolean;                                    // reaches a code-execution sink → loads CODE, not data
  external: boolean;                                    // delegates to a call we couldn't resolve to a sink or in-repo method (opaque → teacher-3 candidate)
}

// A method-body call, ALREADY classified by the language front-end (it read the AST; the walk never
// sees a node). The closed set of things a call can be on the way to a sink:
//  - sink        a known terminal I/O op → contributes its direction + medium
//  - codeLoad    loads/runs CODE not data (require/eval) → the carrier is a code-loader, not a channel
//  - dynamic     truly-dynamic dispatch (send/method_missing) → an honest blindspot, NOT external
//  - unresolved  delegates to a call we couldn't pin (external=true → opaque teacher-3 candidate);
//                `blindspot` set when the unresolved name is one the repo DOES define (a recall loss)
//  - follow      resolved to PINNED in-repo def(s) → recurse into each
//  - ignore      a builtin / non-carrier op (or a typed receiver whose method isn't a sink) → nothing
export type TraceCall =
  | { kind: "sink"; direction: Direction; medium: string }
  | { kind: "codeLoad" }
  | { kind: "dynamic"; label: string }
  | { kind: "unresolved"; external: boolean; blindspot?: string }
  | { kind: "follow"; targets: MethodCandidate[] }
  | { kind: "ignore" };

// The language front-end the generic tracer drives. `callsOf` returns the classified calls in a
// method's body, or null when the def isn't in this language's index. Built once per repo index.
export interface CallGraph {
  callsOf(className: string, method: string): Promise<TraceCall[] | null>;
}

const _DEPTH_CAP = 12;

// Trace a method's body to its I/O sinks via the language `CallGraph`. Pure routing + accumulation —
// no AST, no language knowledge.
export async function traceToSinks(graph: CallGraph, className: string, method: string): Promise<CarrierEffect> {
  const eff: CarrierEffect = { className, method, directions: [], media: [], reached: [], blindspots: [], codeLoad: false, external: false };
  const dirs = new Set<Direction>(), media = new Set<string>(), blind = new Set<string>();
  let codeLoad = false, external = false;
  const seen = new Set<string>();

  const visit = async (cls: string, meth: string, depth: number): Promise<void> => {
    const key = `${cls}#${meth}`;
    if (seen.has(key) || depth > _DEPTH_CAP) return;
    seen.add(key);
    const calls = await graph.callsOf(cls, meth);
    if (!calls) return;
    for (const c of calls) {
      switch (c.kind) {
        case "sink": dirs.add(c.direction); media.add(c.medium); break;
        case "codeLoad": codeLoad = true; break;
        case "dynamic": blind.add(c.label); break;
        case "unresolved": if (c.external) external = true; if (c.blindspot) blind.add(c.blindspot); break;
        case "follow": for (const t of c.targets) { eff.reached.push({ className: t.className, method: t.method }); await visit(t.className, t.method, depth + 1); } break;
        case "ignore": break;
      }
    }
  };

  await visit(className, method, 0);
  eff.directions = [...dirs]; eff.media = [...media]; eff.blindspots = [...blind]; eff.codeLoad = codeLoad; eff.external = external;
  return eff;
}
