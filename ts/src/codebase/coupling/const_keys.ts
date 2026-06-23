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
import { emit } from "../../core/progress.js";
import type { EngineCtx } from "../engine_ctx.js";
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

// Build the repo-wide CONSTANT→VALUE map, then resolve every getParameter/addParameter key through it →
// a GroundingIndex (key value → producers/consumers). Two passes; texts cached between them.
export function resolveParamKeys(repo: string, skipDirs: Set<string> = SKIP_DIRS): GroundingIndex {
  const constMap = new Map<string, string>();
  const files: { rel: string; text: string }[] = [];
  for (const { rel, text } of walkFiles(repo, skipDirs, endsWithSourceExt)) {
    if (COUPLING.maxScanBytes && text.length > COUPLING.maxScanBytes) continue;   // skip minified/generated bundles (same floor guard as scan_file_keys)
    const t = maskComments(text);                // a constant or call inside a comment is not real
    files.push({ rel, text: t });
    let m: RegExpExecArray | null; CONST_DECL.lastIndex = 0;
    while ((m = CONST_DECL.exec(t)) !== null) if (!constMap.has(m[1])) constMap.set(m[1], m[2]);
  }

  const idx: GroundingIndex = new Map();
  const add = (value: string, file: string, line: number, produces: boolean) => {
    if (!plausibleKeyValue(value)) return;       // reuse the floor guard — no "the"/generic/prose keys
    const k = `key ${value}`;
    if (!idx.has(k)) idx.set(k, { producers: [], consumers: [] });
    (produces ? idx.get(k)!.producers : idx.get(k)!.consumers).push({ file, line });
  };
  for (const { rel, text } of files) {
    for (const [re, produces] of [[CONSUME, false], [PRODUCE, true]] as const) {
      re.lastIndex = 0; let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const value = resolveArg(m[1], constMap);
        if (value) add(value, rel, lineOf(text, m.index), produces);
      }
    }
  }
  return idx;
}

// CACHED repo wrapper (mirrors shared_key_index): build the const-resolved param grounding ONCE per repo
// per run. Part of the deterministic FLOOR, so it honours the global adapter kill-switch — `SEAM_NO_ADAPTERS=1`
// (the recall harness sets this) yields an empty index, identical to the floor being off.
export function param_key_index(repo: string, skipDirs: Set<string>, ctx: EngineCtx): GroundingIndex {
  if (ctx.paramKeys.has(repo)) return ctx.paramKeys.get(repo)!;
  if (process.env.SEAM_NO_ADAPTERS === "1") { const e = new Map() as GroundingIndex; ctx.paramKeys.set(repo, e); return e; }
  emit("Building constant-resolved param-key index…");
  const idx = resolveParamKeys(repo, skipDirs);
  ctx.paramKeys.set(repo, idx);
  return idx;
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
