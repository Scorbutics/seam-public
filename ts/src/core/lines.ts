// THE LINE CONTRACT — the single place the engine's internal line convention meets the rendered one.
//
// EVERY line the codebase scan produces is 0-BASED: `GraphNode.range` comes from `Ctx.span`, `edge.line`
// from `Ctx.span(call)` / `_call_lines` / `_usage_lines`, and `Ctx.ln` returns the count of newlines before
// the offset. EVERY line a human/editor jumps to (`file:line`) is 1-BASED. Converting per-branch is what
// produced the systematic off-by-one every projected shape carried (`getUserAvailability.ts:341` for a symbol
// on 342): one branch added 1, the other passed the raw 0-based value through. Route EVERY line through this
// helper — a raw `range[0]` or `e.line` reaching a rendered model is the bug, by construction.
//
// Lives in `core/` (not in a shape module) because BOTH fronts convert here: the structural shapes
// (grow/project_set.ts re-exports `to1` for consumers/dependencies/impact/reaches/writers/coupling) and the
// SEAM MODEL front (seams/emit.ts, which converts node.start/end + edge.line on the way OUT of the graph IR,
// so the model's lines mean the same thing whatever produced them — diff-mode hunks are already 1-based
// new-side file lines). The graph IR itself stays 0-BASED: scan/detect.ts uses node.start/end as row INDICES
// into the file, so the conversion must happen at the model boundary, never in the IR or in a renderer.
//
// A converted line of 0 means "NO grounded line": the renderers (`at`/`atLine`) print no location at all
// rather than a fabricated `:1`, which would send the reader to an unrelated line.
export const to1 = (l: number | null | undefined): number => (l == null ? 0 : l + 1);

// The same conversion for a value that already uses 0 as its "no line" SENTINEL (a scan `edge.line`, an
// UNLOCATED node's [0,0] range): 0 in → 0 out (still "no line"), every real line shifted by one. Keeping the
// falsy test intact is the point — every `line > 0` guard downstream keeps meaning exactly what it meant.
export const to1OrNone = (l: number | null | undefined): number => (l ? Number(l) + 1 : 0);
