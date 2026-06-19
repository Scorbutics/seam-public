// CARRIER PROVIDER — the LANGUAGE seam of the carrier-channel axis. The engine (engine.ts) is
// framework- and language-agnostic: it owns the walk, the opaque→cache→LLM classifier ladder, the
// glob grounding and the repo-wide index. Everything that needs to read SOURCE — extracting the channel
// key from a call's string arg (teacher 2), resolving the callee, and tracing it to an I/O sink
// (teacher 1) — lives behind this interface, one implementation per language (Ruby is the first).
//
// The seam is drawn at OBSERVATIONS, not at the trace algorithm: a provider yields, per call site, the
// channel key + the callee + a traced direction (or null = OPAQUE, "ask teacher 3"). The engine never
// looks at an AST. So a second language plugs in by implementing `scanFile`/`methodSource` over its own
// dispatch + sink registry — without touching the ladder, cache, or grounding. Whether the trace WALK
// itself is later hoisted into the engine is an evidence-driven call for when language #2 arrives.

// One carrier call site the provider observed in a file. `direction === null` means the callee is an
// OPAQUE carrier candidate (delegates externally, no traceable sink) — the engine runs teacher 3 on it.
// A call that resolves to a NON-carrier (pure computation, networking, code-load) yields NO observation.
export interface CarrierObservation {
  value: string;                       // the channel key — a literal path, or a glob family pattern (teacher 2)
  partial: boolean;                    // true = a glob pattern (recovered from an interpolated string)
  line: number;                        // 0-based call row
  callee: { className: string; method: string };   // the carrier method (for teacher-3 synthesis keying)
  direction: "read" | "write" | null;  // traced I/O direction, or null = opaque → defer to teacher 3
}

// A resolved carrier-channel access (post-ladder): the unit the engine indexes under `data-file <value>`.
export interface CarrierHit { value: string; line: number; produces: boolean; partial: boolean }

// A language's carrier front-end. `Idx` is the provider's own repo index (opaque to the engine; built
// once by `buildIndex` and threaded back into `scanFile`/`methodSource`).
export interface CarrierProvider<Idx = unknown> {
  name: string;                                            // language id (also names the medium in the LLM prompt)
  handles(file: string): boolean;                          // does this provider own the file? (by extension)
  buildIndex(repo: string): Promise<Idx>;                  // build the per-repo dispatch/class index (lazy, cached by engine)
  scanFile(repo: string, index: Idx, file: string, text: string): Promise<CarrierObservation[]>;   // teacher 2 + teacher 1
  methodSource(repo: string, index: Idx, className: string, method: string): Promise<string | null>;  // for teacher 3
}

// Does a family pattern (`*` = a within-segment hole) match a concrete path? `Data/Text/*.dat` ⊇
// `Data/Text/en.dat`. Language-agnostic (teacher-2 grounding) — the key is just a path string by now.
export function globMatch(pattern: string, concrete: string): boolean {
  if (!pattern.includes("*")) return false;
  const re = "^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$";
  return new RegExp(re).test(concrete);
}
