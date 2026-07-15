// COMPOSED-ROUTE teacher — the CROSS-FILE mount-chain half of the annotation-route boundary. The in-file
// `composedRoutes` (adapters/annotation_route.ts) composes a class `@Path` + a method `@Path` within ONE
// file. But a resource class with NO class-level route annotation is a SUB-RESOURCE: its full HTTP path is
// composed from a chain of LOCATOR methods in OTHER files (JAX-RS `@Path("users") UsersResource users()` in a
// parent resource), and that class itself is mounted by yet another locator up the chain. The handler
// (`@POST createUser`) carries NO path literal at all — so no in-file pass, and no textual grep of the full
// URL, can reach it. That is the exact kc_3 wall (the admin-console create-user form's `/admin/realms/*/users`
// POST never links to `UsersResource.createUser`).
//
// This is a textbook FLYWHEEL case, not a hardcoded per-framework resolver (which would be JAX-RS-specific
// proliferation — the very thing the engine avoids):
//  • SEED on a GROUNDED, CLOSED fact — a method carrying a route-VERB annotation from the route-annotation
//    REGISTRY (`routeAnnotationMethod` → GET/POST/…) whose class has no class-level route. The registry says
//    it IS a route endpoint; the missing class route says its mount is EXTERNAL. Framework-agnostic: a Spring
//    `@RestController` carries a class `@RequestMapping`, so it never trips this — only the locator-mounted
//    sub-resource idiom does.
//  • GATHER the mount chain STRUCTURALLY — grep the class name (a locator returns/creates it), climb to the
//    locator's owner class, bounded depth. Deterministic, no LLM.
//  • Apply the LLM ONLY to the irreducible residue — compose the full path from the gathered evidence (the
//    base prefix, path-var normalisation, the varied mount idioms a deterministic composer would hardcode).
//  • VALIDATE by GROUNDING — the composed route is emitted as a PRODUCER key; the shared-key index couples it
//    only where a CONSUMER (a `fetch`/SDK call) independently names the same path. A wrong composition that
//    nothing calls grounds nothing.
//  • CACHE per handler-file (content-hashed) → replayed DETERMINISTICALLY forever (LLM once → det after),
//    exactly like the matcher flywheel. A warm `.seam/` needs no model.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run_pass_async, registerPass, ClassifierError as LLMError } from "../../core/llm.js";
import { emit, verbose } from "../../core/progress.js";
import { walkFiles } from "../../core/resolve/walk.js";
import { SKIP_DIRS, endsWithSourceExt } from "../../core/resolve/languages/index.js";
import { scannableForKeys } from "./adapters/index.js";
import { isRouteAnnotation, routeAnnotationMethod } from "./frameworks/route_annotations.js";
import { normPath, isBareWildcardRoute, routeSegs } from "./adapters/http_route.js";
import { grepFiles } from "./bridge.js";
import { persistFileKeys, cachedFileKeys, hasKeyCache } from "./key_store.js";
import { plausibleKeyValue } from "./key_ir.js";
import { COUPLING } from "./config.js";
import { EngineCtx } from "../engine_ctx.js";
import type { GroundingIndex, KeyHit } from "./types.js";

const PASS = registerPass({ tag: "compose-subresource-route", tier: "strong", note: "compose a sub-resource handler's full HTTP path from its cross-file mount chain (learn-once → .seam)" });

interface ComposeOpts { llm?: boolean; model?: string; claudeBin?: string | null }

// The DEMAND GATE (a consumer route must name a class's mount segment) is the real cost bound; this cap is a
// safety net for a pathological repo. Keep it well ABOVE the demanded set so it never truncates a genuinely
// consumed handler by arbitrary walk order (the kc_3 miss) — the compositions are cached + reused across grows.
const MAX_CLASSES = Math.max(COUPLING.keyBudget, Number(process.env.SEAM_COMPOSE_CAP) || 250);
const CHAIN_DEPTH = 5;                     // how many locator hops to climb (handler → parent → … → root)
const MAX_SNIPPETS = 12;                   // total mount-evidence windows fed to the LLM per class
const FILES_PER_CLASS = 24;               // non-test grep hits read per class hop (the real mount often ranks last behind tests)
// TEST files reference a resource class but never MOUNT it — and they dominate a grep (40/49 hits for keycloak's
// UsersResource), starving the real locator. Drop them (dir- and suffix-based; language-general).
const _isTest = (f: string): boolean => /(?:^|\/)(?:tests?|testsuite|it|spec|__tests__|e2e)(?:\/|$)|(?:Test|Tests|IT|Spec|_test|\.spec|\.test)\.[a-z]+$/i.test(f);

const _isRouteName = (n: string): boolean => isRouteAnnotation(n) || routeAnnotationMethod(n) !== undefined;
// a literal that already gives the handler its OWN groundable path (absolute or with a path variable) —
// then it is NOT mount-blind and the in-file floor already keys it.
const _hasOwnPath = (lit?: string): boolean => !!lit && (lit.startsWith("/") || /[{}<>:]/.test(lit));
const _maskStr = (s: string): string => s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');   // blank string bodies so their ()/{} don't skew the brace balance
const _delta = (s: string): number => { const t = _maskStr(s); let d = 0; for (const c of t) { if (c === "(" || c === "{") d++; else if (c === ")" || c === "}") d--; } return d; };
const _annotOf = (line: string): { name: string; lit?: string } | null => { const m = /^@(\w[\w.]*)\s*(?:\(\s*(?:\w+\s*=\s*)?["'`]([^"'`]+)["'`])?/.exec(line.trim()); return m ? { name: m[1].split(".").pop()!, lit: m[2] } : null; };

interface Handler { name: string; verb: string; line: number; own?: string }   // own = a relative sub-segment the handler declares (@Path("count")), composed ONTO the mounted prefix
interface SubResource { className: string; handlers: Handler[] }

// The route annotations DIRECTLY attached to the decl at `declIdx` — scan UPWARD over the contiguous
// annotation/comment block, skipping the INTERIOR lines of a multi-line annotation argument (`@APIResponses(
// value = { … })`) by tracking brace/paren balance, and stopping at the previous member (a `}`/`;` boundary
// or a blank gap). Language-general (any `@annotation` syntax), robust to nested annotation bodies.
function attachedAnnots(lines: string[], declIdx: number): { name: string; lit?: string }[] {
  const annots: { name: string; lit?: string }[] = [];
  let bal = 0;   // brace balance of the multi-line annotation we may be INSIDE (scanning up: closers open, openers close)
  for (let i = declIdx - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (bal > 0) { bal -= _delta(t); continue; }                 // inside a multi-line annotation arg → climbing UP, an opener REDUCES the unmatched-closer count to its start
    if (t === "" || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("*/")) continue;   // javadoc/blank within the block
    if (t.startsWith("@")) { const a = _annotOf(t); if (a && _isRouteName(a.name)) annots.push(a); continue; }
    if (t.endsWith(")") && !t.startsWith("@")) { const d = _delta(t); if (d < 0) { bal = -d; continue; } }   // the CLOSING line of a multi-line annotation (e.g. `})`) — enter it
    break;   // a real code line (previous member / class body) → the annotation block ended
  }
  return annots;
}

// STRUCTURAL detection: classes in `text` that expose route-VERB handlers but carry NO class-level route
// annotation → sub-resources whose path is mounted externally. Returns the mount-blind handlers (bare verb,
// no own path). Regex + brace-balance (mirrors annotation_route.ts) so it's language-general, tree-sitter-free.
export function subResources(text: string): SubResource[] {
  const lines = text.split("\n");
  let hasRoutedClass = false;                            // a class WITH a class-level route → normal controller, skip the file
  const classNames: string[] = [];
  const handlers: Handler[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || l.startsWith("@") || l.startsWith("//") || l.startsWith("*")) continue;   // only DECL lines drive detection; annotations are read via attachedAnnots
    const cls = /\b(?:class|interface|record)\s+(\w+)/.exec(l);
    if (cls) {
      classNames.push(cls[1]);
      if (attachedAnnots(lines, i).some((a) => _isRouteName(a.name))) hasRoutedClass = true;   // class carries a route → controller
      continue;
    }
    const mm = /(?:^|\s)(\w+)\s*\(/.exec(l);   // a method-like decl: `<ret> name(` (control keywords are filtered below)
    if (!mm || /\b(?:if|for|while|switch|catch|return|new)\b/.test(l.slice(0, l.indexOf(mm[1]) + mm[1].length))) continue;
    const annots = attachedAnnots(lines, i);
    const verb = annots.find((a) => routeAnnotationMethod(a.name) !== undefined);
    if (verb && !annots.some((a) => _hasOwnPath(a.lit))) {
      const own = annots.find((a) => isRouteAnnotation(a.name) && a.lit)?.lit;   // a relative own segment (@Path("count")) — the floor can't key it, so compose it too
      handlers.push({ name: mm[1], verb: routeAnnotationMethod(verb.name)!, line: i, ...(own ? { own } : {}) });
    }
  }
  if (hasRoutedClass || !handlers.length || !classNames.length) return [];   // routed class present, or nothing mount-blind → floor covers it
  // Attribute the mount-blind handlers to the file's primary resource class (the last class declared, usually
  // the public one). Files with one resource class are the norm for this idiom.
  return [{ className: classNames[classNames.length - 1], handlers }];
}

// SUB-RESOURCE LOCATORS declared in `text`: `@Path("seg") <ReturnType> method(…)` — a route-annotated method
// whose return type is a resource class → that class is MOUNTED at `seg`. Returns [ReturnType, seg] pairs.
// Used to build the demand gate (a class is worth composing only if a consumer route names its mount segment)
// — grounded and cheap (one pass in the same walk), no per-class grep.
export function locators(text: string): { returnType: string; seg: string }[] {
  const lines = text.split("\n");
  const out: { returnType: string; seg: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const decl = /^\s*(?:public\s+|protected\s+|final\s+|abstract\s+)*([A-Z]\w+)\s+\w+\s*\(/.exec(lines[i]);   // `<UpperCaseReturnType> method(`
    if (!decl) continue;
    for (const a of attachedAnnots(lines, i)) if (isRouteAnnotation(a.name) && a.lit) { for (const seg of routeSegs(normPath(a.lit))) if (seg !== "*") out.push({ returnType: decl[1], seg }); }
  }
  return out;
}

// STRUCTURAL mount-chain gather: grep the class name → locator sites (a method returning/creating it near a
// route annotation) → their surrounding window; climb to each locator file's OWN resource class and recurse.
// Bounded by depth, files-per-class, and a global snippet cap. No LLM.
export function gatherMountChain(repo: string, className: string, depth: number, visited: Set<string>, snippets: { file: string; snippet: string }[]): void {
  if (depth <= 0 || visited.has(className) || snippets.length >= MAX_SNIPPETS) return;
  visited.add(className);
  let files: string[];
  try { files = grepFiles(repo, className).filter((f) => !_isTest(f)); } catch { return; }
  const climb: string[] = [];
  const push = (f: string, lines: string[], i: number) => { const lo = Math.max(0, i - 3), hi = Math.min(lines.length - 1, i + 2); snippets.push({ file: f, snippet: `… (line ${lo + 1})\n` + lines.slice(lo, hi + 1).join("\n") }); };
  const ownerRe = /\b(?:public\s+|abstract\s+|final\s+)*(?:class|interface)\s+(\w+)/;
  const locatorRe = new RegExp(`\\b${className}\\b\\s+\\w+\\s*\\(`);   // a LOCATOR: `UsersResource users(` — className as a method's RETURN TYPE
  const defRe = new RegExp(`\\b(?:class|interface)\\s+${className}\\b`);   // the class DEFINITION line (for its own class-level @Path)
  for (const f of files.slice(0, FILES_PER_CLASS)) {
    if (snippets.length >= MAX_SNIPPETS || !endsWithSourceExt(f)) continue;
    let text: string; try { text = readFileSync(join(repo, f), "utf-8"); } catch { continue; }
    const lines = text.split("\n");
    const owner = ownerRe.exec(text)?.[1] ?? null;   // the resource class that OWNS the locators in this file
    let isLocatorFile = false;
    for (let i = 0; i < lines.length && snippets.length < MAX_SNIPPETS; i++) {
      // (a) a locator method returning className, carrying a route annotation → the mount hop
      if (locatorRe.test(lines[i]) && attachedAnnots(lines, i).some((a) => isRouteAnnotation(a.name) && a.lit)) { push(f, lines, i); isLocatorFile = true; }
      // (b) className's OWN class definition with an ABSOLUTE class-level route (`@Path("/admin") class AdminRoot`)
      //     → the ROOT prefix of the whole chain (no locator mounts a root resource; its base is the class @Path)
      else if (defRe.test(lines[i])) { const own = attachedAnnots(lines, i).find((a) => isRouteAnnotation(a.name) && _hasOwnPath(a.lit)); if (own) push(f, lines, i); }
    }
    if (isLocatorFile && owner && owner !== className) climb.push(owner);   // climb to each locator's owner class
  }
  for (const owner of climb) gatherMountChain(repo, owner, depth - 1, visited, snippets);
}

function _composePrompt(sr: SubResource, snippets: { file: string; snippet: string }[]): string {
  const handlers = sr.handlers.map((h) => `  - ${h.verb} ${h.name}${h.own ? ` (own sub-path "${h.own}")` : ""}`).join("\n");
  const evidence = snippets.map((s) => `=== ${s.file} ===\n${s.snippet}`).join("\n\n");
  return `A REST HANDLER class is MOUNTED as a SUB-RESOURCE: it has NO class-level route annotation, so its
full HTTP path is composed from a chain of LOCATOR methods in PARENT classes (a route-annotated method that
returns/creates this class), not declared locally. Determine the FULL path each handler serves.

HANDLER CLASS: ${sr.className}
MOUNT-BLIND HANDLERS (each is <HTTP-VERB> <method>; its path prefix comes ENTIRELY from the mount chain):
${handlers}

MOUNT EVIDENCE (locator methods + parent resources that mount this class and its ancestors, gathered from the repo):
${evidence}

Compose each handler's FULL path by concatenating the mounted prefix (walk the locator chain up to the root)
with the handler's own segment. Use * for every path VARIABLE (\`{realm}\`/\`{id}\`/\`:id\` → *). Output a handler
ONLY if the evidence DETERMINES its mounted prefix — omit it otherwise (silence beats a guess; a wrong path
grounds nothing but a right one links the whole cross-stack flow). Do NOT invent segments not in the evidence.

Return a JSON array (empty if the mount can't be determined); every object needs a unique "id":
[{"id":"h1","method":"POST","name":"createUser","path":"/admin/realms/*/users"}]`;
}

function _parseComposed(out: Map<string, any>, sr: SubResource): KeyHit[] {
  const lineByName = new Map(sr.handlers.map((h) => [h.name, { line: h.line, verb: h.verb }]));
  const keys: KeyHit[] = [];
  const seen = new Set<string>();
  for (const obj of out.values()) {
    if (!obj || typeof obj !== "object") continue;
    const name = String(obj.name ?? "").trim();
    const path = normPath(String(obj.path ?? "").trim());
    const h = lineByName.get(name);
    if (!h || !path || path === "/") continue;
    if (!plausibleKeyValue(path) || isBareWildcardRoute(path)) continue;   // a bare `/*` couples to everything → not a real key
    const method = String(obj.method ?? "").trim().toUpperCase() || h.verb;
    const id = `${path} ${method}`;
    if (seen.has(id)) continue; seen.add(id);
    keys.push({ kind: "http-route", value: path, line: h.line, produces: true, method });
  }
  return keys;
}

// COMPOSE cross-file sub-resource routes repo-wide → a grounding index of PRODUCER keys at the handler
// locations. LLM-composes (cold) OR replays the per-handler cache (warm/det); memoised per repo on the ctx.
// No-op (empty) on a det run with no `.seam/` key cache — a cold det run pays nothing.
export async function composeRoutes(repo: string, opts: ComposeOpts, ctx: EngineCtx = new EngineCtx()): Promise<GroundingIndex> {
  // memo per (repo, footprint-scope): the demand set — and thus the composed idx — depends on which route
  // consumers are in-footprint, so a repo-only key would leak one grow's demand into another's.
  const memoKey = `${repo}::${ctx.footprintFiles ? "fp" + ctx.footprintFiles.size : "repo"}`;
  const memo = ctx.composedRoutes.get(memoKey);
  if (memo) return memo;
  const idx: GroundingIndex = new Map();
  // DEFAULT ON under `--data-coupling llm` (opt out with SEAM_COMPOSE_ROUTES=0); zero-cost when a det run has no
  // `.seam/` cache (the guard below). Composition + grounding are verified (a server sub-resource's
  // `/admin/realms/*/users` composes and grounds against the front-end fetch), reliability is bounded (pool of 3
  // + one retry + empties not cached → self-heal), and the DEMAND GATE keeps it lazy (only footprint-consumed
  // sub-resources). See test/coupling/route_composer.test.ts + test/grow/resource_route_crossing.test.ts.
  if (process.env.SEAM_COMPOSE_ROUTES === "0") { ctx.composedRoutes.set(memoKey, idx); return idx; }
  if (!opts.llm && !hasKeyCache(repo)) { ctx.composedRoutes.set(memoKey, idx); return idx; }
  const learn = opts.llm;   // synthesise new compositions (else replay the cache only)
  const add = (h: KeyHit, file: string) => {
    const k = `${h.kind} ${h.value}`;
    if (!idx.has(k)) idx.set(k, { producers: [], consumers: [] });
    idx.get(k)!.producers.push({ file, line: h.line });
  };
  // DEMAND GATE (grounded): a sub-resource is worth composing only if some route CONSUMER (a `fetch`/SDK call
  // the floor already keyed) names the segment that MOUNTS it. So collect the consumer route segments, and the
  // repo's locator table (class → its mount segments), and compose only the classes a consumer actually reaches.
  // This both CUTS the cold cost (58 arbitrary → the consumed few) and stops the cap from starving the relevant
  // class (server UsersResource ranked past the cap in walk order, so it was never composed) — the whole kc_3 gap.
  // FOOTPRINT-SCOPED demand: the segments of route consumers IN THIS GROW'S footprint (ctx.footprintFiles).
  // So a grow only composes the handful of sub-resources ITS flow actually calls (kc_3 → just `users`), and an
  // intent with no route consumers in-footprint composes NOTHING — the composer is lazy, not a repo-wide tax.
  // Falls back to repo-wide when no footprint is set (a whole-repo warm-up).
  const { floor_base_index } = await import("./index.js");
  const floor = floor_base_index(repo, SKIP_DIRS, ctx);
  const fp = ctx.footprintFiles;
  const demandSegs = new Set<string>();
  for (const [k, v] of floor) {
    if (!k.startsWith("http-route ")) continue;
    if (!v.consumers.some((c) => !fp || fp.has(c.file))) continue;   // a route consumed IN-FOOTPRINT = demand for its handler
    for (const seg of routeSegs(k.slice("http-route ".length))) if (seg !== "*") demandSegs.add(seg);
  }
  // PASS 1 — walk once: detect sub-resource classes (split CACHED vs TO-COMPOSE) AND build the locator table.
  const detected: { rel: string; ck: string; sr: SubResource }[] = [];
  const classToSegs = new Map<string, Set<string>>();
  for (const { rel, text } of walkFiles(repo, SKIP_DIRS, scannableForKeys)) {
    if (_isTest(rel) || !/@\w/.test(text)) continue;                   // tests never mount a live route; no annotations → cheap skip
    for (const { returnType, seg } of locators(text)) { if (!classToSegs.has(returnType)) classToSegs.set(returnType, new Set()); classToSegs.get(returnType)!.add(seg); }
    for (const sr of subResources(text)) {
      const ck = `route-composed::${rel} ${createHash("sha1").update(text).digest("hex")}`;
      const disk = cachedFileKeys(repo, ck);
      if (disk.hit) { for (const h of disk.keys) add(h, rel); continue; }   // warm: replay the cached composition, no LLM
      if (learn) detected.push({ rel, ck, sr });
    }
  }
  // gate: keep a class if a consumer route names one of its mount segments (or a handler's own segment). If
  // there are NO route consumers at all (demandSegs empty), there is nothing to ground → compose nothing.
  const demanded = detected.filter((c) => {
    const segs = classToSegs.get(c.sr.className);
    return (segs && [...segs].some((s) => demandSegs.has(s))) || c.sr.handlers.some((h) => h.own && demandSegs.has(h.own));
  });
  const toCompose = demanded.slice(0, MAX_CLASSES);
  if (verbose()) process.stderr.write(`[coupling] route-composer: ${detected.length} sub-resource class(es) detected → ${demanded.length} demanded by a consumer route → ${toCompose.length} to compose\n`);
  // PASS 2 — compose the demanded classes CONCURRENTLY (each is one independent LLM call; run_pass_async
  // overlaps the subprocesses on the claude/copilot path). Evidence-gather (grep+read) is sync per class.
  let composed = 0;
  const compose1 = async (c: typeof toCompose[number], snippets: { file: string; snippet: string }[]): Promise<KeyHit[]> => {
    let parsed = new Map<string, any>();
    try { parsed = await run_pass_async(_composePrompt(c.sr, snippets), { model: opts.model, claudeBin: opts.claudeBin, tag: PASS.tag }); }
    catch (e) { if (!(e instanceof LLMError)) throw e; }   // a transient subprocess failure → empty; retried by the caller
    return _parseComposed(parsed, c.sr);
  };
  const work = toCompose.map((c) => async () => {
    const snippets: { file: string; snippet: string }[] = [];
    gatherMountChain(repo, c.sr.className, CHAIN_DEPTH, new Set(), snippets);
    if (!snippets.length) { persistFileKeys(repo, c.ck, { name: `${c.sr.className}-routes`, description: "no mount evidence found", keys: [] }); return; }
    // ONE retry on an empty result: with mount evidence present, empty is almost always a transient concurrency
    // failure (a `claude -p` subprocess erroring under load), not a genuine "can't determine" — a re-ask recovers
    // it (the same self-correction the matcher flywheel uses). Only the DERIVED empty is persisted, never a flake.
    let keys = await compose1(c, snippets);
    if (!keys.length) keys = await compose1(c, snippets);
    if (verbose() && keys.length) process.stderr.write(`[coupling] composed ${keys.length} sub-resource route(s) for ${c.sr.className}: ${keys.map((k) => `${k.method} ${k.value}`).join(", ")}\n`);
    // Persist ONLY a non-empty composition (→ deterministic warm replay). An empty result WITH evidence is a
    // suspected transient failure that survived the retry — do NOT cache it, so the next grow re-attempts it and
    // the flywheel self-heals (a genuinely-uncomposable class just re-tries cheaply, bounded by demand).
    if (keys.length) { persistFileKeys(repo, c.ck, { name: `${c.sr.className}-routes`, description: keys.map((k) => `serves ${k.method} ${k.value}`).join("; "), keys }); for (const h of keys) add(h, c.rel); composed++; }
  });
  if (work.length) { emit(`Composing cross-file mount routes for ${work.length} sub-resource class(es) via LLM…`); await _pool(work, 3); }
  ctx.composedRoutes.set(memoKey, idx);
  return idx;
}

// bounded-concurrency runner (N at a time) — the flywheel's other passes use Promise.all over a fixed set;
// here the set is repo-sized, so cap the in-flight LLM calls.
async function _pool(tasks: (() => Promise<void>)[], n: number): Promise<void> {
  let i = 0;
  const worker = async () => { while (i < tasks.length) { const j = i++; await tasks[j](); } };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
}
