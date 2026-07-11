// CONSTRAINED KEY-ADAPTER IR — the executable form of a LEARNED shared-key adapter. Where the per-file
// LLM key index (llm_key_index.ts) emits literal keys for ONE file, a KeyMatcher is a reusable RULE the
// LLM synthesizes once and the engine then runs DETERMINISTICALLY over every file, forever (cached to
// `.seam/`). This is the "LLM picks the SHAPE, the engine EXECUTES it" split: the model never writes a
// regex (a ReDoS / correctness hazard run repo-wide) — it fills a small, closed structural template, and a
// safe matcher does the scanning. Four CLOSED shapes cover the framework long tail — call (a string-literal
// key arg: `$emit('sync')`, `from('table')`), assign (`$scope.x = fn`), method (a class method def), and
// attr (a template directive: `@sync`, `ng-click="x()"`). This is what lets a learned rule replace what used
// to be hand-written framework adapters (ng_scope, event_binding) — no per-framework code in the engine.
import type { KeyHit } from "./types.js";
import { lineOf, maskComments } from "./adapters/util.js";
import { makeCtx, lang_for, available } from "../atoms.js";
import { field } from "../../core/treesitter.js";

// LLM free-text kind vocab → registered adapter kinds. Exported so llm_key_index.ts's per-file key
// extraction canonicalizes through the SAME map — a learned matcher's kind and a per-file LLM key both
// land on the SAME boundary node + edge kinds as the deterministic floor (was two hand-kept copies).
export const _KIND_ALIASES: Record<string, string> = { route: "http-route", endpoint: "http-route", http: "http-route", url: "http-route", path: "http-route" };
export const _canonKind = (k: string): string => { const t = k.toLowerCase().trim(); return _KIND_ALIASES[t] ?? (t || "key"); };

export type MatcherRole = "produces" | "consumes";

// One learned, executable detection rule — a CLOSED structural SHAPE the engine runs deterministically (the
// LLM fills the template, never writes code/regex). Three shapes cover the framework long tail:
//   • call   — `token('key')`           : a call whose string-literal arg IS the key (db table, event, topic,
//                                          route, cache). Regex-executed → works with NO tree-sitter (floor).
//                                          Optional `strip`: the arg is a DIRECTIVE-named string and the key
//                                          is its suffix — `setAttribute('v-on:open', …)` strip "v-on:" → open
//                                          (the dynamic/metawidget listener; the computed handler is residual).
//   • assign — `token.KEY = <function>`  : a method DEFINED on a receiver, the key being the member NAME —
//                                          e.g. AngularJS `$scope.refreshSection = function`. AST (js/ts).
//   • attr   — a TEMPLATE directive      : `<directive><NAME>="<expr>"` / `{{ expr }}` — the key is the
//                                          directive NAME (an event listener) or a CALLEE in its expression
//                                          (a scope-method call). AST (html/vue).
// `token`/`directive` are validated to safe identifiers/prefixes; the kind stays the structural archetype so
// a learned producer + consumer ground on the SAME boundary as the floor.
//   • method — a CLASS METHOD definition, the key being the method NAME — e.g. an Angular2+/React component
//                method `refreshSection() { … }` that the template then calls. AST (js/ts). Liberal (every
//                method) → grounding keeps only those a template/other side actually names.
//   • annotation — a DECORATOR/ANNOTATION whose string-literal argument is the key — `@JmsListener(destination
//                  ="export.queue")`, `@KafkaListener(topics="orders")`, `@EventListener("user.created")`. The
//                  CONSUMER (handler) side of a queue/event whose producer is a `call` (`convertAndSend('q')`):
//                  the annotation marks a method as the listener for a topic/queue NAME. Regex-executed (no
//                  parser ⇒ offline/.vsix). `annotation` = the bare annotation name; optional `element` = the
//                  named member to read (`destination`/`topics`) — omitted ⇒ the first positional literal
//                  (`@KafkaListener("orders")`). This generalises the path-only annotation_route floor to ANY
//                  annotation-carried key, so the flywheel learns the JMS/Kafka/Spring listener side it couldn't.
export type KeyMatcher =
  | { via: "call"; token: string; argIndex: number; strip?: string; kind: string; role: MatcherRole; name?: string; description?: string }
  | { via: "assign"; token: string; kind: string; role: MatcherRole; name?: string; description?: string }
  | { via: "method"; kind: string; role: MatcherRole; name?: string; description?: string }
  | { via: "attr"; directive: string; keyFrom: "name" | "call"; kind: string; role: MatcherRole; name?: string; description?: string }
  | { via: "annotation"; annotation: string; element?: string; kind: string; role: MatcherRole; name?: string; description?: string }
  // member — `<token>.<KEY>.<verb>(…)`: the KEY is a MEMBER of a known receiver, accessed via one of `verbs`.
  // The single most common data shape (an ORM/repo layer: prisma.eventType.findMany / db.user.update /
  // repo.<entity>.save) — Prisma/Drizzle/TypeORM AND a project's own layer. role fixed per rule (read verbs
  // → consumes, write verbs → produces), so a layer needs two rules. This is what lets the flywheel FACTOR a
  // repeated receiver-member layer into ONE rule instead of an LLM call per file.
  | { via: "member"; token: string; verbs: string[]; kind: string; role: MatcherRole; name?: string; description?: string }
  // repository — `<token>.<verb>(…)` where the RECEIVER ITSELF is the table/entity (a single-entity
  // repository: `users.create()`, `featuresRepository.setTeamFeatureState()`). The 2-part counterpart of
  // `member`: there the key is the member between receiver and verb; here the receiver IS the key. Synthesised
  // by the receiver-CLASSIFIER (idiom/embedding) for a `database`-classified 2-part receiver — the layer
  // member_access (3-part) can't see. role fixed per rule (read verbs → consumes, write → produces).
  | { via: "repository"; token: string; verbs: string[]; kind: string; role: MatcherRole; name?: string; description?: string }
  // channel — `<token>.<verb>('key')` where the RECEIVER is a classified event/store/cache channel and the
  // STRING-LITERAL arg is the key (`bus.emit('orders.sync')`, `store.set('draft')`). Receiver-SCOPED (unlike
  // the method-scoped `call` shape) so a classified `bus`/`store` is matched, NOT every generic `.get('x')` —
  // that scoping is the precision the cheap `call` shape lacked. Synthesised by the receiver-CLASSIFIER for an
  // event/store-classified receiver; role fixed per rule (emit/set → produces, on/get → consumes).
  | { via: "channel"; token: string; verbs: string[]; kind: string; role: MatcherRole; name?: string; description?: string };

// One-line human summary of a rule's executable SHAPE (for `seam-adapters`): how it detects the key.
export function matcherShape(m: KeyMatcher): string {
  if (m.via === "call") return `${m.token}(arg${m.argIndex})${m.strip ? ` strip "${m.strip}"` : ""}`;
  if (m.via === "assign") return `${m.token}.<member> = fn`;
  if (m.via === "method") return `class method def`;
  if (m.via === "annotation") return `@${m.annotation}(${m.element ? `${m.element}="…"` : `"…"`})`;
  if (m.via === "member") return `${m.token}.<member>.{${m.verbs.join("|")}}()`;
  if (m.via === "repository") return `${m.token}.{${m.verbs.join("|")}}() → table ${m.token}`;
  if (m.via === "channel") return `${m.token}.{${m.verbs.join("|")}}('<key>')`;
  return `${m.directive}<name> (key from ${m.keyFrom})`;
}

// Stable identity for dedup/caching: the shape + the fields that distinguish two rules of that shape.
export function matcherKey(m: KeyMatcher): string {
  const base = `${m.via}:${m.kind}:${m.role}`;
  if (m.via === "call") return `${base}:${m.token}:${m.argIndex}:${m.strip ?? ""}`;
  if (m.via === "assign") return `${base}:${m.token}`;
  if (m.via === "method") return base;
  if (m.via === "annotation") return `${base}:${m.annotation}:${m.element ?? ""}`;
  if (m.via === "member") return `${base}:${m.token}:${m.verbs.slice().sort().join(",")}`;
  if (m.via === "repository") return `${base}:${m.token}:${m.verbs.slice().sort().join(",")}`;
  if (m.via === "channel") return `${base}:${m.token}:${m.verbs.slice().sort().join(",")}`;
  return `${base}:${m.directive}:${m.keyFrom}`;
}

// A rule's required LITERAL — a substring that MUST appear in any file the rule can match (the callee/
// receiver token, the directive prefix, the annotation name). A cheap `text.includes()` pre-filter: a file
// lacking it can never match, so skip the (expensive, tree-sitter) runMatcher. `method` matches any class
// method definition → no discriminating literal → null (must still be parsed). Never causes a false miss:
// if the rule matches, the literal is present by construction.
export function matcherLiteral(m: KeyMatcher): string | null {
  if (m.via === "call" || m.via === "assign" || m.via === "member" || m.via === "repository" || m.via === "channel") return m.token;
  if (m.via === "attr") return m.directive;
  if (m.via === "annotation") return m.annotation;
  return null;   // method
}

const _TOKEN_OK = /^[A-Za-z_$][\w$]*$/;   // a single identifier (member chains/metachars rejected → safe to embed)
const _RECEIVER_OK = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;   // an identifier or a dotted receiver path (no metachars)
const _slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

// Generic tokens that can never be a real coupling key. A bare common word ("the") carries no
// producer/consumer IDENTITY, so it grounds by COINCIDENCE and fans out to unrelated files (the observed
// `"the"` false-coupling). This is a STRUCTURAL identifier-plausibility filter — shape, not meaning: a key
// is a NAME / identifier / path / topic, never prose or a stopword. The LLM still JUDGES which keys exist;
// this only drops values that cannot be identifiers at all (so it also cleans pre-existing junk in `.seam/`
// at apply-time, with no re-warm). Domain-plausible words (data, value, order, user…) are deliberately NOT
// here — only function words / literals that are never identifiers.
const _GENERIC_KEY = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "it", "as", "at", "by", "be",
  "this", "that", "with", "from", "not", "but", "if", "else", "true", "false", "null", "none", "undefined",
]);

// True if a string is plausibly a shared-key IDENTIFIER (a table/event/topic/route/cache name), not prose
// or a generic token. Applied at BOTH synthesis (don't cache junk) and application (filter junk already
// cached). Paths (`/api/x`) are allowed even without a letter run; everything else needs a letter.
export function plausibleKeyValue(value: string): boolean {
  const v = (value ?? "").trim();
  if (v.length < 2) return false;                                   // 0-1 chars: not a key
  if (/\s/.test(v)) return false;                                   // whitespace ⇒ prose, not an identifier
  if (!/[A-Za-z]/.test(v) && !v.includes("/")) return false;        // pure number/punctuation (but allow paths)
  if (_GENERIC_KEY.has(v.toLowerCase())) return false;              // a bare function word grounds by coincidence
  return true;
}

// Validate ONE LLM object → a KeyMatcher, or null (malformed / unsupported shape). The gate that keeps a
// free-text model answer from becoming an executable rule unless it fits the closed template exactly.
// A directive prefix is matched by String.startsWith (NEVER embedded in a regex), so a permissive but safe
// charset is fine: `ng-` / `@` / `v-on:` / `on-` / `data-ng-`, plus Angular2+ binding sigils `(event)` /
// `[prop]` / `*ngIf`. Bounded length keeps a pathological value out.
const _DIRECTIVE_OK = /^[-\w@:()[\]*]{1,24}$/;

export function validateMatcher(obj: any): KeyMatcher | null {
  if (!obj || typeof obj !== "object") return null;
  const via = String(obj.via ?? "call").toLowerCase();
  const role: MatcherRole = String(obj.role ?? "").toLowerCase().startsWith("produc") ? "produces" : "consumes";
  const kind = _canonKind(String(obj.kind ?? "key"));
  const nm = (fallback: string) => _slug(String(obj.name ?? "")) || fallback;
  const dsc = (fallback: string) => String(obj.description ?? "").trim().slice(0, 200) || fallback;
  if (via === "call") {
    // the CALLEE may be written qualified (`bus.publish`, `this.$emit`, `cache.get`) — keep the last segment,
    // the bare method name. runMatcher matches member forms anyway (`.` is allowed before the token).
    const token = (String(obj.token ?? "").trim().split(".").pop() ?? "").trim();
    if (!_TOKEN_OK.test(token)) return null;                                 // not a bare identifier → reject (no regex injection)
    const argIndex = Number.isInteger(obj.argIndex) && obj.argIndex >= 0 ? obj.argIndex : 0;
    const stripRaw = String(obj.strip ?? "").trim();                         // optional directive-name prefix on the arg
    const strip = stripRaw && _DIRECTIVE_OK.test(stripRaw) ? stripRaw : undefined;
    return { via: "call", token, argIndex, ...(strip ? { strip } : {}), kind, role, name: nm(`${_slug(token)}-${kind}`), description: dsc(`${role} ${kind} via ${token}(arg ${argIndex})${strip ? ` strip "${strip}"` : ""}`) };
  }
  if (via === "assign") {
    const token = String(obj.token ?? "").trim();
    if (!_TOKEN_OK.test(token)) return null;                                 // the receiver must be a bare identifier ($scope, this, vm)
    return { via: "assign", token, kind, role, name: nm(`${_slug(token)}-assign-${kind}`), description: dsc(`${role} ${kind} via ${token}.<member> = function`) };
  }
  if (via === "method") {
    return { via: "method", kind, role, name: nm(`class-method-${kind}`), description: dsc(`${role} ${kind} via a class method definition`) };
  }
  if (via === "attr") {
    const directive = String(obj.directive ?? "").trim();
    if (!_DIRECTIVE_OK.test(directive)) return null;
    const keyFrom: "name" | "call" = String(obj.keyFrom ?? "name").toLowerCase() === "call" ? "call" : "name";
    return { via: "attr", directive, keyFrom, kind, role, name: nm(`${_slug(directive)}-attr-${kind}`), description: dsc(`${role} ${kind} via template ${directive}<name> (key from ${keyFrom})`) };
  }
  if (via === "annotation") {
    const annotation = String(obj.annotation ?? "").trim().replace(/^@/, "");   // `@JmsListener` or `JmsListener` → bare name
    if (!_TOKEN_OK.test(annotation)) return null;                              // a bare identifier (no dots/metachars) → safe to embed
    const elementRaw = String(obj.element ?? "").trim();                       // optional named member (destination/topics)
    const element = elementRaw && _TOKEN_OK.test(elementRaw) ? elementRaw : undefined;
    return { via: "annotation", annotation, ...(element ? { element } : {}), kind, role, name: nm(`${_slug(annotation)}-annot-${kind}`), description: dsc(`${role} ${kind} via @${annotation}(${element ? `${element}="…"` : `"…"`})`) };
  }
  if (via === "member") {
    const token = String(obj.token ?? "").trim();
    if (!_TOKEN_OK.test(token)) return null;                                  // the receiver must be a bare identifier (prisma/db/repo)
    const verbs = [...new Set<string>((Array.isArray(obj.verbs) ? obj.verbs : []).map((v: any) => String(v).trim()).filter((v: string) => _TOKEN_OK.test(v)))];
    if (!verbs.length) return null;                                          // need ≥1 access verb to bound the match (else it'd match any member)
    return { via: "member", token, verbs, kind, role, name: nm(`${_slug(token)}-member-${kind}`), description: dsc(`${role} ${kind} via ${token}.<member>.{${verbs.join("|")}}()`) };
  }
  if (via === "repository") {
    const token = String(obj.token ?? "").trim();
    if (!_TOKEN_OK.test(token)) return null;                                  // the receiver (= the table) must be a bare identifier
    const verbs = [...new Set<string>((Array.isArray(obj.verbs) ? obj.verbs : []).map((v: any) => String(v).trim()).filter((v: string) => _TOKEN_OK.test(v)))];
    if (!verbs.length) return null;                                          // need ≥1 access verb (else it'd match any call on the receiver)
    return { via: "repository", token, verbs, kind, role, name: nm(`${_slug(token)}-repo-${kind}`), description: dsc(`${role} ${kind} via ${token}.{${verbs.join("|")}}() (receiver = table)`) };
  }
  if (via === "channel") {
    const token = String(obj.token ?? "").trim();
    // the receiver is a bare identifier (bus/store) OR a dotted RECEIVER PATH (`MyFramework.http`) — the latter
    // for effect-inferred custom clients. Dots are escaped in runChannel's regex, so still injection-safe.
    if (!_RECEIVER_OK.test(token)) return null;
    const verbs = [...new Set<string>((Array.isArray(obj.verbs) ? obj.verbs : []).map((v: any) => String(v).trim()).filter((v: string) => _TOKEN_OK.test(v)))];
    if (!verbs.length) return null;                                          // need ≥1 verb (else it'd match any call on the receiver)
    return { via: "channel", token, verbs, kind, role, name: nm(`${_slug(token)}-channel-${kind}`), description: dsc(`${role} ${kind} via ${token}.{${verbs.join("|")}}('<key>')`) };
  }
  return null;                                                               // unknown shape → not executable
}

// The content of the `n`-th (0-based) call argument IF it is a pure string literal, else null. `start` is
// the index JUST AFTER the opening `(`. Tracks nesting + string state so commas inside nested calls/objects
// or strings don't split args; a concatenated/computed arg (`'a' + x`) returns null (it can't ground anyway).
function nthStringArg(text: string, start: number, n: number): string | null {
  const lit = (raw: string): string | null => {
    const s = raw.trim();
    if (s.length >= 2 && (s[0] === '"' || s[0] === "'" || s[0] === "`") && s[s.length - 1] === s[0]) {
      const inner = s.slice(1, -1);
      return /[`'"]/.test(inner) ? null : inner;   // a nested quote ⇒ concatenation/template ⇒ not a clean literal
    }
    return null;
  };
  let depth = 0, arg = 0, argStart = start, i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {                              // skip a string literal whole
      const q = c; i++;
      while (i < text.length && text[i] !== q) { if (text[i] === "\\") i++; i++; }
      i++; continue;
    }
    if (c === "(" || c === "[" || c === "{") { depth++; i++; continue; }
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return arg === n ? lit(text.slice(argStart, i)) : null;   // end of the call's args
      depth--; i++; continue;
    }
    if (c === "," && depth === 0) {
      if (arg === n) return lit(text.slice(argStart, i));
      arg++; argStart = i + 1; i++; continue;
    }
    i++;
  }
  return null;
}

// PRE-FILTER (perf, behaviour-preserving) — a file that doesn't contain the matcher's literal can never
// match, so skip the (tree-sitter) parse entirely. Shared by runMatcher (the runPipeline PER-NODE loop) and
// applyMatchers' repo-wide grounding walk (key_matcher.ts) — one gate instead of two hand-kept copies (the
// duplicate previously let the SEAM_MATCHER_PREFILTER=0 kill-switch bypass only one of the two call sites).
// Measured impact: ~2000 learned rules × every node = 60k runMatcher calls / 45s on cal.com, 85% of them for
// a rule whose literal is absent and so could never match.
export function matcherPassesPrefilter(m: KeyMatcher, text: string): boolean {
  if (process.env.SEAM_MATCHER_PREFILTER === "0") return true;
  const lit = matcherLiteral(m);
  return !lit || text.includes(lit);
}

// Execute a matcher over ONE file → the keys it detects. Deterministic, bounded, no LLM. ASYNC because the
// AST shapes (assign/attr) parse with tree-sitter; `call` stays a pure regex (no parser ⇒ works offline /
// .vsix-degraded, the floor's robustness). `file` selects the grammar for the AST shapes.
const _NO_HITS: KeyHit[] = [];
export async function runMatcher(m: KeyMatcher, file: string, text: string): Promise<KeyHit[]> {
  if (!matcherPassesPrefilter(m, text)) return _NO_HITS;
  if (m.via === "call") return runCall(m, text);
  if (m.via === "assign") return runAssign(m, file, text);
  if (m.via === "method") return runMethod(m, file, text);
  if (m.via === "annotation") return runAnnotation(m, text);
  if (m.via === "member") return runMember(m, text);
  if (m.via === "repository") return runRepository(m, text);
  if (m.via === "channel") return runChannel(m, text);
  return runAttr(m, file, text);
}

// `<token>.<verb>(` — the 2-part repository shape: the RECEIVER `token` IS the table/entity, verb ∈ m.verbs.
// Pure regex (offline); token + verbs are identifier-safe. Mirrors runMember but the key is the receiver, not
// a member. The lookbehind allows a path prefix (`this.users.create` → receiver `users`), like runMember.
function runRepository(m: Extract<KeyMatcher, { via: "repository" }>, text: string): KeyHit[] {
  const masked = maskComments(text);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const verbs = m.verbs.map(esc).join("|");
  const re = new RegExp(`(?<![\\w$])${esc(m.token)}\\s*\\.\\s*(?:${verbs})\\s*[(<]`, "g");
  const out: KeyHit[] = [];
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(masked)) !== null) {
    // ROOT / this-field ONLY: a repository RECEIVER is a top-level bean/field (`userRepo.find`, `this.userRepo.find`),
    // NOT a nested resource on ANOTHER object (`adminClient.users.create` — an HTTP SDK, not a `users` table). That
    // 3-part `obj.token.verb` shape is member_access's domain (receiver-agnostic). Reject a preceding `<ident>.`
    // unless it's this/self/super — else the learned `users`/`clients` repo matcher fabricates a table on every
    // frontend admin-client call.
    const pre = /([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(masked.slice(Math.max(0, mt.index - 48), mt.index));
    if (pre && pre[1] !== "this" && pre[1] !== "self" && pre[1] !== "super") continue;
    if (plausibleKeyValue(m.token)) out.push({ kind: m.kind, value: m.token, line: lineOf(masked, mt.index), produces: m.role === "produces" });
  }
  return out;
}

// `<token>.<verb>('key')` — RECEIVER-SCOPED string-key extraction: the receiver `token` is a classified
// channel, verb ∈ m.verbs, and the STRING-LITERAL arg is the key. Regex (offline); token/verbs are
// identifier-safe. The receiver scope is the precision the method-scoped `call` shape lacks (no generic
// `.get('x')` false-matches). Path prefix allowed (`this.bus.emit('x')` → receiver `bus`).
function runChannel(m: Extract<KeyMatcher, { via: "channel" }>, text: string): KeyHit[] {
  const masked = maskComments(text);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const verbs = m.verbs.map(esc).join("|");
  const re = new RegExp(`(?<![\\w$])${esc(m.token)}\\s*\\.\\s*(?:${verbs})\\s*\\(\\s*['"\`]([^'"\`]{1,80})['"\`]`, "g");
  const out: KeyHit[] = [];
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(masked)) !== null)
    if (plausibleKeyValue(mt[1])) out.push({ kind: m.kind, value: mt[1], line: lineOf(masked, mt.index), produces: m.role === "produces" });
  return out;
}

// `<token>.<KEY>.<verb>(` — KEY is the member identifier (the table/entity/topic), verb ∈ m.verbs. Pure
// regex (no parser) like runCall, so it works offline; token + verbs are validated bare identifiers, so the
// only embedded user data is identifier-safe (no regex injection). The member IS the key.
function runMember(m: Extract<KeyMatcher, { via: "member" }>, text: string): KeyHit[] {
  const masked = maskComments(text);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const verbs = m.verbs.map(esc).join("|");
  const re = new RegExp(`(?<![\\w$])${esc(m.token)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\.\\s*(?:${verbs})\\s*[(<]`, "g");
  const out: KeyHit[] = [];
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(masked)) !== null) {
    const value = mt[1];
    if (plausibleKeyValue(value)) out.push({ kind: m.kind, value, line: lineOf(masked, mt.index), produces: m.role === "produces" });
  }
  return out;
}

// ANNOTATION — `@Name( … )`: the key is a string literal inside the parens, EITHER `element = "key"` (a named
// member, e.g. `@JmsListener(destination = "export.queue")`) OR the first positional literal when `element`
// is omitted (`@KafkaListener("orders")`). Regex-executed (no parser → offline). `annotation`/`element` are
// validated identifiers (embedded escaped); the literal is pulled by a fixed, bounded sub-pattern. `[^)]` for
// the arg body matches one annotation's parens (annotation args rarely nest) — same bound as annotation_route.
function runAnnotation(m: Extract<KeyMatcher, { via: "annotation" }>, text: string): KeyHit[] {
  const masked = maskComments(text);   // an annotation inside a comment is not a real declaration
  const esc = m.annotation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`@${esc}\\s*\\(([^)]*)\\)`, "g");
  const elemRe = m.element ? new RegExp(`\\b${m.element.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*=\\s*["'\`]([^"'\`\\s]+)["'\`]`) : null;
  const posRe = /["'`]([^"'`\s]+)["'`]/;   // first string literal in the arg body
  const out: KeyHit[] = [];
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(masked)) !== null) {
    const body = mt[1];
    const hit = elemRe ? elemRe.exec(body) : posRe.exec(body);
    const value = hit ? hit[1] : null;
    if (value && plausibleKeyValue(value)) out.push({ kind: m.kind, value, line: lineOf(masked, mt.index), produces: m.role === "produces" });
  }
  return out;
}

// CALL — `(?<![\w$])token(` then the n-th string-literal arg. Member forms (`this.$emit`, `cache.get`) still
// match because `.` is allowed immediately before the token.
function runCall(m: Extract<KeyMatcher, { via: "call" }>, text: string): KeyHit[] {
  const masked = maskComments(text);   // a call inside a comment is not a real access
  const esc = m.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\w$])${esc}\\s*\\(`, "g");
  const out: KeyHit[] = [];
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(masked)) !== null) {
    let value = nthStringArg(masked, re.lastIndex, m.argIndex);
    if (value && m.strip) { if (!value.startsWith(m.strip)) continue; value = value.slice(m.strip.length); }   // directive-named arg → its suffix is the key
    if (value && plausibleKeyValue(value)) out.push({ kind: m.kind, value, line: lineOf(masked, mt.index), produces: m.role === "produces" });
  }
  return out;
}

const _FUNCLIKE = new Set(["function_expression", "arrow_function", "function", "generator_function", "method_definition"]);

// ASSIGN — `token.MEMBER = <function>` via AST. Comment/string masking is FREE (a `$scope.x = function` in a
// comment is a `comment` node, never an `assignment_expression`). Key = the member name; receiver = the token.
async function runAssign(m: Extract<KeyMatcher, { via: "assign" }>, file: string, text: string): Promise<KeyHit[]> {
  const lang = lang_for(file);
  if (!lang || !available()) return [];
  const ctx = await makeCtx(text, lang);
  if (!ctx) return [];
  const out: KeyHit[] = [];
  for (const node of ctx.collect(ctx.root, (k) => k === "assignment_expression")) {
    const lhs = field(node, "left"), rhs = field(node, "right");
    if (!lhs || lhs.type !== "member_expression" || !rhs || !_FUNCLIKE.has(rhs.type)) continue;
    const obj = field(lhs, "object"), prop = field(lhs, "property");
    if (!obj || !prop || ctx.text(obj) !== m.token) continue;               // receiver must be the token ($scope)
    const value = ctx.text(prop);
    if (plausibleKeyValue(value)) out.push({ kind: m.kind, value, line: ctx.span(node)[0], produces: m.role === "produces" });
  }
  return out;
}

const _CLASS_MEMBER = new Set(["method_definition", "public_field_definition"]);   // a class method, or a field = arrow/fn

// METHOD — every CLASS METHOD definition's name is a key (Angular2+/React component methods the template
// calls). LIBERAL (matches all methods) → grounding keeps only the names a consumer actually references; the
// `constructor` is excluded (never a binding). AST (js/ts), comment-safe for free.
async function runMethod(m: Extract<KeyMatcher, { via: "method" }>, file: string, text: string): Promise<KeyHit[]> {
  const lang = lang_for(file);
  if (!lang || !available()) return [];
  const ctx = await makeCtx(text, lang);
  if (!ctx) return [];
  const out: KeyHit[] = [];
  for (const node of ctx.collect(ctx.root, (k) => _CLASS_MEMBER.has(k))) {
    if (node.type === "public_field_definition") { const v = field(node, "value"); if (!v || !_FUNCLIKE.has(v.type)) continue; }   // a field is a method only if it holds a function
    const nameNode = field(node, "name");
    if (!nameNode) continue;
    const value = ctx.text(nameNode);
    if (value === "constructor" || !plausibleKeyValue(value)) continue;
    out.push({ kind: m.kind, value, line: ctx.span(node)[0], produces: m.role === "produces" });
  }
  return out;
}

const _TPL_GRAMMAR = (file: string): string | null => (/\.vue$/i.test(file) ? "vue" : /\.html?$/i.test(file) ? "html" : null);
const _CALLEE = /([A-Za-z_$][\w$]*)\s*\(/g;        // FIXED, bounded — pull callee identifiers from a template expression
const _INTERP = /\{\{([^}]*)\}\}/g;                // `{{ expr }}` mustache interpolation

// ATTR — a TEMPLATE directive, via the html/vue AST (robust attribute/quote handling the old regex got
// wrong). For each `<directive><NAME>="<expr>"`: keyFrom="name" ⇒ the directive suffix is the key (an event
// listener `@sync`); keyFrom="call" ⇒ each callee in the expression is a key (a scope call `ng-click="x()"`),
// and `{{ expr }}` interpolations are scanned too (the same template-expression context).
async function runAttr(m: Extract<KeyMatcher, { via: "attr" }>, file: string, text: string): Promise<KeyHit[]> {
  const g = _TPL_GRAMMAR(file);
  if (!g || !available()) return [];
  const ctx = await makeCtx(text, g);
  if (!ctx) return [];
  const out: KeyHit[] = [];
  const produces = m.role === "produces";
  const push = (value: string, line: number) => { if (plausibleKeyValue(value)) out.push({ kind: m.kind, value, line, produces }); };
  const callees = (expr: string, line: number) => { _CALLEE.lastIndex = 0; let c: RegExpExecArray | null; while ((c = _CALLEE.exec(expr)) !== null) push(c[1], line); };
  const value = (attr: any, line: number) => { const v = ctx.collect(attr, (k) => k === "attribute_value")[0]; if (v) callees(ctx.text(v), line); };
  for (const attr of ctx.collect(ctx.root, (k) => k === "attribute" || k === "directive_attribute")) {
    const line = ctx.span(attr)[0];
    if (attr.type === "directive_attribute") {                                    // Vue: directive_name (@/v-on) + directive_argument (event)
      const dn = ctx.collect(attr, (k) => k === "directive_name")[0];
      if (!dn || !ctx.text(dn).startsWith(m.directive.replace(/:$/, ""))) continue;   // `v-on:`→`v-on`, `@`→`@`
      if (m.keyFrom === "name") { const da = ctx.collect(attr, (k) => k === "directive_argument")[0]; if (da) push(ctx.text(da), line); }
      else value(attr, line);
    } else {                                                                      // HTML plain attribute (AngularJS ng-*, raw @/v-on:)
      const nameNode = ctx.collect(attr, (k) => k === "attribute_name")[0];
      if (!nameNode) continue;
      const name = ctx.text(nameNode);
      if (!name.startsWith(m.directive)) continue;
      if (m.keyFrom === "name") push(name.slice(m.directive.length).replace(/^[^\w$]+|[^\w$]+$/g, ""), line);   // `@sync`→sync, `(click)`→click
      else value(attr, line);
    }
  }
  if (m.keyFrom === "call") {                       // `{{ method() }}` interpolations live in text nodes
    for (const t of ctx.collect(ctx.root, (k) => k === "text" || k === "raw_text" || k === "interpolation")) {
      const s = ctx.text(t), line0 = ctx.span(t)[0];
      _INTERP.lastIndex = 0; let im: RegExpExecArray | null;
      while ((im = _INTERP.exec(s)) !== null) callees(im[1], line0);
    }
  }
  return out;
}
