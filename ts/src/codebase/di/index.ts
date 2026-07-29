// DI-BINDING INDEX — the lookup surface over the core's binding index.
//
// The walk, the per-file cache, the tree-sitter parse and the ioctopus GRAMMAR all live in the core now
// (rust/crates/seam-lang/src/di_bindings.rs for the grammar, rust/crates/seam-scan/src/di_index.rs for the
// repo index; differential: rust/parity/di_bindings.ts). This was the LAST TypeScript tree-sitter engine
// reachable on a default-on user path — `--query dependencies` read and parsed every source file in the repo
// from JS, one readFileSync at a time, to answer a single lookup.
//
// The Rust/TS layering split is preserved on the other side: the grammar sits with the other language
// grammars and stays free of repo-scanning concerns, the walk that feeds it sits in the scan crate.
import { recordQuery, registerQueryRerun, hashSet } from "../../core/resolve/dep_recorder.js";
import { loadAddon as _loadAddon } from "../rust_core.js";

export type { DiBinding } from "../../languages/typescript/di_bindings.js";
import type { DiBinding } from "../../languages/typescript/di_bindings.js";

// Degrades to null rather than throwing: DI enrichment is an OPTIONAL annotation on a deps answer, and a
// missing addon must not turn a working `--query dependencies` into an error.
const _core = (): any => _loadAddon();
const _parse = (raw: string | null | undefined): DiBinding | null =>
  raw == null ? null : (JSON.parse(raw) as DiBinding);

// The DI binding that PRODUCES class `cls` (an interface-impl member) — so a deps answer can attach how that
// concrete impl is wired to its token + the runtime condition. null when the class isn't container-bound.
export async function diBindingForClass(repo: string, cls: string): Promise<DiBinding | null> {
  const a = _core();
  const b = a ? _parse(a.diBindingForClass(repo, cls)) : null;
  recordQuery("di-binding", [cls], b ? [`${b.token}|${b.kind}|${b.file}:${b.line}`] : []);
  return b;
}
registerQueryRerun("di-binding", async (repo, [cls]) => {
  const a = _core();
  const b = a ? _parse(a.diBindingForClass(repo, cls)) : null;
  return hashSet(b ? [`${b.token}|${b.kind}|${b.file}:${b.line}`] : []);
});

// The DI binding registered under a bare token name (e.g. "REDIS_CLIENT") — used to resolve a toClass dep map.
export async function diBindingForToken(repo: string, token: string): Promise<DiBinding | null> {
  const a = _core();
  return a ? _parse(a.diBindingForToken(repo, token)) : null;
}

// Test/CLI hook: drop the per-repo memo so a fresh run (or an edited fixture) rebuilds.
export function _resetDiIndex(): void { _core()?.diResetIndex(); }
