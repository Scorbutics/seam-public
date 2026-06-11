// Tree-sitter facts producer (headless, full-file, AST-grounded) — the counterpart to the VS Code
// AST producer. Parses the post-image file, masks comments/strings via the parse tree, slices to
// the hunk's changed lines, and reuses the shared facts_from_texts assembly. Port of
// src/diff/facts_treesitter.py. Async (web-tree-sitter), so it runs as a PRE-PASS producing a
// facts payload that the sync classify pipeline consumes via ExternalFactsProvider.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { facts_for_hunk, factsToDict, FACTS_SCHEMA_VERSION, type FileSource, type HunkFacts } from "./facts.js";
import type { Hunk } from "./parser.js";
import { available, getParser, isCommentOrString, langForExt } from "../core/treesitter.js";

export { available };

// Reads the post-image from the working tree under `repo`.
export class RepoFileSource implements FileSource {
  constructor(private repo = ".") {}
  read(path: string): string | null {
    try { return readFileSync(join(this.repo, path), "utf-8"); } catch { return null; }
  }
}

// Blank comment/string spans using the parse tree, preserving newlines (line numbers stay aligned
// with the diff). Returns null if parsing is unavailable/fails. web-tree-sitter node indices are
// string offsets, so we mask the JS string directly.
async function astMask(content: string, grammar: string): Promise<string | null> {
  const parser = await getParser(grammar);
  if (!parser) return null;
  let root: any;
  try { root = parser.parse(content).rootNode; } catch { return null; }
  const buf = content.split("");                                 // mutable per-UTF16-unit copy (offsets are UTF-16 units)
  const stack: any[] = [root];
  while (stack.length) {
    const n = stack.pop();
    if (isCommentOrString(n.type)) {
      for (let i = n.startIndex; i < n.endIndex && i < buf.length; i++) if (buf[i] !== "\n") buf[i] = " ";
      continue;                                                  // don't descend into a masked node
    }
    for (let i = 0; i < n.childCount; i++) stack.push(n.child(i));
  }
  return buf.join("");
}

async function oneHunk(h: Hunk, source: FileSource, minAlignment: number): Promise<HunkFacts | null> {
  const content = source.read(h.file_path);
  if (content === null) return null;
  const dot = h.file_path.lastIndexOf(".");
  const ext = dot >= 0 ? h.file_path.slice(dot) : "";
  const grammar = langForExt(ext);
  if (!grammar) return null;
  const masked = await astMask(content, grammar);
  if (masked === null) return null;
  return facts_for_hunk(h, content, masked, minAlignment);
}

// Compute tree-sitter facts for the hunks → the wire payload (ExternalFactsProvider shape). Hunks
// the producer can't handle (no file / unsupported lang / parse fail / misaligned) are simply
// absent, so the consumer's regex fallback fills them — graceful degradation per hunk.
export async function computeTreeSitterFacts(hunks: Hunk[], source: FileSource, minAlignment = 0.8): Promise<any> {
  const out: Record<string, unknown> = {};
  for (const h of hunks) {
    const hf = await oneHunk(h, source, minAlignment);
    if (hf) out[h.id] = factsToDict(hf);
  }
  return { version: FACTS_SCHEMA_VERSION, hunks: out };
}
