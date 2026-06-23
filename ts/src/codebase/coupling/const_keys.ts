// PROTOTYPE — CONSTANT-RESOLVING shared-key floor. Frameworks like Dubbo key their couplings with a
// NAMED CONSTANT, not a string literal: `url.getParameter(TOKEN_KEY)` (consume) ⇄ `url.addParameter(
// TOKEN_KEY, …)` (produce), where `String TOKEN_KEY = "token"` lives in a constants interface. The LLM
// flywheel mis-handles this (it spells the same key two ways — `TOKEN_KEY` here, `token` there — so the
// two sides never co-occur and never ground). The deterministic fix: build a repo-wide CONSTANT→VALUE map,
// then resolve each getParameter/addParameter arg through it so both sides land on ONE value ("token").
//
// Repo-wide by necessity (the constant is DEFINED in one file, USED in another) — so it is NOT a per-file
// `scan(file,text)` adapter; it is a repo pass like the carrier channel / llmKeyIndex, returning a
// GroundingIndex the coupling engine merges. Deterministic, no LLM. Cross-language-ish (the const/getter
// shapes are Java/TS-flavoured here; this is a prototype to validate the APPROACH before generalizing).
import { walkFiles, normpath } from "../../core/resolve/walk.js";
import { SKIP_DIRS, endsWithSourceExt } from "../../core/resolve/languages/index.js";
import { lineOf, maskComments } from "./adapters/util.js";
import { plausibleKeyValue } from "./key_ir.js";
import { COUPLING } from "./config.js";
import type { GroundingIndex, KeyHit } from "./types.js";

// A NAMED string constant: `static final String NAME = "value"`, or a Java interface field `String NAME =
// "value"` (implicitly static final). Require an UPPER_SNAKE name so a local `String x = "y"` isn't a
// "constant". The value is the literal text between the quotes (concatenations are skipped — no quote-close).
const CONST_DECL = /(?:static\s+final\s+|final\s+static\s+)?String\s+([A-Z][A-Z0-9_]{1,})\s*=\s*"([^"]*)"/g;
// CONSUME / PRODUCE the key via a getter/setter whose FIRST arg is the key (literal or constant). The arg
// is captured up to the first comma or close-paren.
const CONSUME = /\.(?:getParameter|getAttachment|getMethodParameter|getServiceParameter)\s*\(\s*([^,)\n]+?)\s*[,)]/g;
const PRODUCE = /\.(?:setParameter|addParameter|addParameterIfAbsent|setAttachment|putAttachment)\s*\(\s*([^,)\n]+?)\s*[,)]/g;

// Resolve a call arg to a key VALUE: a "string literal" → its content; a CONSTANT (or Class.CONSTANT) →
// its mapped value; anything else (a variable, a computed expr) → null (unresolvable, skipped).
function resolveArg(raw: string, constMap: Map<string, string>): string | null {
  const v = raw.trim();
  const lit = v.match(/^["'`]([^"'`]+)["'`]$/);
  if (lit) return lit[1];
  const id = v.split(".").pop() ?? v;            // CommonConstants.TOKEN_KEY → TOKEN_KEY
  if (/^[A-Z][A-Z0-9_]+$/.test(id) && constMap.has(id)) return constMap.get(id)!;
  return null;
}

// One unresolved getParameter/addParameter call-site — the raw arg + where it sits. Collected during the
// (single, fused) repo walk, then resolved against the COMPLETE const map afterward (a constant defined in
// file Z used in file A only resolves once every file's decls are in the map).
export type ParamSite = { rel: string; raw: string; line: number; produces: boolean };

// --- the three reusable pieces of the param pass (so the engine's FUSED single walk and the standalone
// resolveParamKeys below share ONE implementation; all operate on COMMENT-MASKED text) ---

// Collect NAMED string-constant declarations into constMap (first declaration wins).
export function scanConstDecls(maskedText: string, constMap: Map<string, string>): void {
  let m: RegExpExecArray | null; CONST_DECL.lastIndex = 0;
  while ((m = CONST_DECL.exec(maskedText)) !== null) if (!constMap.has(m[1])) constMap.set(m[1], m[2]);
}
// Collect raw getParameter/addParameter call-sites (arg left UNRESOLVED — resolved later vs the full map).
export function scanParamSites(maskedText: string, rel: string, out: ParamSite[]): void {
  for (const [re, produces] of [[CONSUME, false], [PRODUCE, true]] as const) {
    re.lastIndex = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(maskedText)) !== null) out.push({ rel, raw: m[1], line: lineOf(maskedText, m.index), produces });
  }
}
// Resolve collected sites against the final const map → GroundingIndex (literal or constant → value),
// dropping implausible values with the shared floor guard.
export function resolveParamSites(sites: ParamSite[], constMap: Map<string, string>): GroundingIndex {
  const idx: GroundingIndex = new Map();
  for (const s of sites) {
    const value = resolveArg(s.raw, constMap);
    if (!value || !plausibleKeyValue(value)) continue;   // no "the"/generic/prose keys; unresolvable args dropped
    const k = `key ${value}`;
    if (!idx.has(k)) idx.set(k, { producers: [], consumers: [] });
    (s.produces ? idx.get(k)!.producers : idx.get(k)!.consumers).push({ file: s.rel, line: s.line });
  }
  return idx;
}

// STANDALONE (own repo walk) — kept for tests and non-fused callers. The ENGINE path uses the fused
// single-pass builder (build_floor_indices in index.ts) so this const/use scan shares ONE walk with the
// shared-key scan. Behaviour-identical: collect every file's decls + sites, then resolve.
export function resolveParamKeys(repo: string, skipDirs: Set<string> = SKIP_DIRS): GroundingIndex {
  const constMap = new Map<string, string>();
  const sites: ParamSite[] = [];
  for (const { rel, text } of walkFiles(repo, skipDirs, endsWithSourceExt, { maxBytes: COUPLING.maxScanBytes })) {
    const t = maskComments(text);                // a constant or call inside a comment is not real
    scanConstDecls(t, constMap);
    scanParamSites(t, rel, sites);
  }
  return resolveParamSites(sites, constMap);
}

// The const-resolved param keys a single span [file, lo..hi] touches — read back OUT of the repo index so a
// pipeline node SURFACES its own getParameter/addParameter keys (the per-file scan in collectAnchorKeys does
// NOT const-resolve, so without this the anchor's TOKEN_KEY access never becomes the "token" key the other
// side grounds on). Emits KeyHit{kind:"key"} so the coupling engine treats it as a generic resource key.
export function paramKeysForSpan(paramIndex: GroundingIndex, file: string, lo: number, hi: number): KeyHit[] {
  const want = normpath(file);
  const out: KeyHit[] = [];
  for (const [k, v] of paramIndex) {
    const value = k.slice(k.indexOf(" ") + 1);   // "key <value>" → <value>
    for (const [accesses, produces] of [[v.producers, true], [v.consumers, false]] as const)
      for (const a of accesses)
        if (normpath(a.file) === want && a.line >= lo && a.line <= hi)
          out.push({ kind: "key", value, line: a.line, produces });
  }
  return out;
}
