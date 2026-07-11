// SELF-VALIDATING KEY-ADAPTER SYNTHESIS — the flywheel that lets Seam LEARN a new framework's shared-key
// shape on the fly and then run it DETERMINISTICALLY. The loop (per the teacher-3 design, hardened with a
// re-execution gate the carrier teacher lacks):
//   1. a floor-blind file has a data edge no adapter keys
//   2. the LLM synthesizes a CONSTRAINED matcher IR (key_ir.ts) — the rule's SHAPE, never a regex
//   3. RE-EXECUTE the matcher deterministically over the files it was derived from
//   4. accept ONLY if it detects ≥1 key (it actually matches) — a hallucinated rule matches nothing
//   5. one self-correction retry on a detection miss (feed the dead tokens back), else drop
//   6. persist the survivors to `.seam/` → applied deterministically forever (LLM once → det after)
// GROUNDING (the same literal must co-occur at a producer AND a consumer) is enforced downstream by the
// shared-key index, exactly as for the floor — so a detected-but-uncorroborated key still can't fabricate
// an edge. Gated on `--data-coupling llm` + budget; the LLM seam is the shared run_pass (host-bus/claude/
// copilot), no API key.
import { run_pass_async, registerPass, ClassifierError as LLMError } from "../../core/llm.js";
import { emit } from "../../core/progress.js";
import { walkFiles } from "../../core/resolve/walk.js";
import { SKIP_DIRS } from "../../core/resolve/languages/index.js";
import { scan_file_keys, scannableForKeys } from "./adapters/index.js";
import { COUPLING } from "./config.js";
import { EngineCtx } from "../engine_ctx.js";
import type { GroundingIndex } from "./types.js";
import { type KeyMatcher, validateMatcher, runMatcher, matcherKey, matcherPassesPrefilter } from "./key_ir.js";
import { persistMatchers, loadMatchers, hasLearnedMatchersFor, recordLearnedMatchers } from "./key_store.js";
import { createHash } from "node:crypto";

const PASS = registerPass({ tag: "discover-key-matchers", tier: "strong", note: "reusable shared-key adapter-rule synthesis (semantic, learn-once → .seam)" });

const MATCHER_SNIPPET_CAP = COUPLING.matcherSnippetCap;
const MATCHER_PER_FILE = COUPLING.matcherPerFile;

export interface MatcherOpts { llm?: boolean; model?: string; claudeBin?: string | null }

function _prompt(files: { file: string; snippet: string }[], deadTokens: string[]): string {
  const blocks = files.map((f) => `=== FILE: ${f.file} ===\n${f.snippet}`).join("\n\n");
  const retry = deadTokens.length
    ? `\nA PREVIOUS attempt proposed rules whose token matched NOTHING literally in these files: `
      + `${deadTokens.join(", ")}. Either correct the token/argIndex to a call that LITERALLY appears above, or omit it.\n`
    : "";
  return `You are LEARNING reusable DETECTION RULES for DATA-FLOW couplings carried by a SHARED KEY — an
identifier (event name, scope/component method, DB table, queue/topic, cache key, route) that two files
share with NO import/call between them. One side PRODUCES the key (defines/emits/writes it), the other
CONSUMES it (calls/listens/reads it); they wire up because the SAME key string appears on both sides. You
describe each rule's SHAPE — a small structural template the engine runs deterministically — not the value.
${retry}
${blocks}

THREE shapes are available — pick the one that fits the evidence:

 1) "call"   — a CALL whose STRING-LITERAL argument is the key: $emit('sync'), publish('topic'),
               bus.on('refresh', …), from('users'). ALSO storage/cache channels where a string KEY is shared
               by a writer and a reader across files: localStorage/sessionStorage.setItem('k')/getItem('k'),
               cache.set('k')/get('k') → kind "cache" (setItem/set = produces, getItem/get = consumes).
               Fields: token = the BARE callee method name ONLY, with
               no receiver/dots (\`bus.publish\` → "publish", \`this.$emit\` → "$emit"); argIndex = 0-based
               index of the string arg that IS the key. OPTIONAL strip: when the string arg is a DIRECTIVE
               NAME and the key is its suffix — \`el.setAttribute('v-on:open', handler)\` → strip "v-on:",
               key = "open" (a dynamically-wired listener; the computed handler name is not the key).
 2) "assign" — a method/handler DEFINED on a receiver object, where the MEMBER NAME is the key:
               \`$scope.refreshSection = function …\`, \`this.onSave = () => …\`. The template/other file then
               CALLS that name. Field: token = the RECEIVER identifier ("$scope", "this", "vm"). role =
               "produces" (it defines the binding).
 2b) "method" — a CLASS METHOD definition where the METHOD NAME is the key — \`refreshSection() { … }\` inside
               an Angular2+/React component class, which the template then calls. NO fields beyond the common
               ones. role = "produces". Use this (not "assign") when the handler is a plain class method, not
               an explicit \`receiver.x = fn\` assignment.
 3) "attr"   — a TEMPLATE/markup directive binding (HTML, .vue, AngularJS/Angular templates). Fields:
               directive = the attribute-name prefix EXACTLY as written ("ng-", "@", "v-on:", "(", "on"),
               keyFrom = "name" when the directive's OWN name is the key (an event listener: \`@sync="…"\`,
               \`(click)="…"\` → key = sync/click) OR "call" when a method CALLED in the directive's value is
               the key (\`ng-click="refreshSection()"\`, Angular2+ \`(click)="refreshSection()"\`, \`{{ total() }}\`
               → key = refreshSection/total). role is usually "consumes" (the template USES the binding).
 4) "annotation" — a DECORATOR/ANNOTATION whose STRING-LITERAL arg is the key — the CONSUMER (handler) side of
               a queue/event whose producer is a "call": \`@JmsListener(destination="export.queue")\`,
               \`@KafkaListener(topics="orders")\`, \`@RabbitListener(queues="q")\`, \`@EventListener("user.created")\`.
               Fields: annotation = the bare annotation name ("JmsListener"); element = the named member to read
               ("destination"/"topics"/"queues"), OMIT it when the key is the first positional literal
               (\`@KafkaListener("orders")\`). role = "consumes" (the annotated method LISTENS for the key). PAIR
               it with the producer "call" (\`convertAndSend('export.queue', …)\` → produces queue) that grounds it.
NOTE: a data-access LAYER (\`prisma.eventType.findMany()\` / \`users.create()\` — an ORM/repository) is NOT your
job: the deterministic \`member-access\` floor adapter + the receiver CLASSIFIER cover it. Do NOT emit rules for
a \`<recv>.<entity>.<verb>()\` or \`<repo>.<verb>()\` data layer. Focus on the TEMPLATE/event/receiver-less shapes
below that classification can't see.

DISCRIMINATOR (payload routing) — a SPECIAL "call" pair. When a GENERIC payload/message/event object carries a
FIELD whose VALUE selects which handler processes it — a producer SETS a literal on the field
(\`export.setType("INVENTORY")\`, a builder \`.type("INVENTORY")\`) and a consumer BRANCHES on that same field read
against the SAME literal (\`export.getType().equals("INVENTORY")\`, \`if (kind.equals("PRICING"))\`) — the KEY is the
LITERAL, kind "event". Emit the PAIR as two "call" rules: the setter (token "setType") role produces, and the
comparison (token "equals") role consumes. This is the ONE allowed exception to the "never target a generic API
like equals" rule below — safe ONLY because both sides must carry the SAME literal to ground. Emit the "equals"
consumer rule ONLY when a setter producer carrying that SAME literal is ALSO present in the evidence — NEVER the
\`equals\` rule alone (it would match every comparison in the repo and ground by coincidence).

A coupling needs BOTH sides to ground: whenever you emit a PRODUCER rule (defines/emits the key), also emit
the matching CONSUMER rule that USES it (and vice-versa) if its evidence is present above — e.g. a class
"method" producer PAIRED with the template "attr" (key from call) that invokes it. A producer with no
consumer rule (or the reverse) grounds nothing.

For every rule with CONCRETE evidence above, output one object. Do NOT invent rules — only constructs
LITERALLY present. A wrong rule is worse than silence. NEVER target a generic API whose string argument is
human PROSE — logging (log/info/warn), i18n (t/translate), formatting, exceptions — it extracts words like
"the" and couples unrelated files by coincidence. The ONLY generic-API exception is the DISCRIMINATOR pair
above (a setter literal paired with the equals/comparison of the SAME literal) — never an "equals" rule alone.

Common fields on every object: via, kind (db-table|queue|event|route|cache|key|binding), role
("produces"|"consumes"), name (short slug), description (one line).

Return a JSON array (empty if none). Examples — note the PAIRS (producer + the consumer that grounds it):
[{"id":"r1","via":"call","token":"$emit","argIndex":0,"kind":"event","role":"produces","name":"vue-emit","description":"emits a component event"},
 {"id":"r2","via":"attr","directive":"@","keyFrom":"name","kind":"event","role":"consumes","name":"vue-listener","description":"@event template listener"},
 {"id":"r3","via":"assign","token":"$scope","kind":"binding","role":"produces","name":"scope-method","description":"defines an AngularJS $scope view method"},
 {"id":"r4","via":"attr","directive":"ng-","keyFrom":"call","kind":"binding","role":"consumes","name":"ng-directive-call","description":"calls a scope method from an ng-* directive"},
 {"id":"r5","via":"method","kind":"binding","role":"produces","name":"ng2-method","description":"Angular2+/React component class method"},
 {"id":"r6","via":"attr","directive":"(","keyFrom":"call","kind":"binding","role":"consumes","name":"ng2-event-binding","description":"calls a component method from an Angular2+ (event) binding"},
 {"id":"r7","via":"call","token":"setItem","argIndex":0,"kind":"cache","role":"produces","name":"localstorage-write","description":"writes a localStorage key"},
 {"id":"r8","via":"call","token":"getItem","argIndex":0,"kind":"cache","role":"consumes","name":"localstorage-read","description":"reads a localStorage key"},
 {"id":"r9","via":"call","token":"convertAndSend","argIndex":0,"kind":"queue","role":"produces","name":"jms-send","description":"publishes to a JMS queue/topic"},
 {"id":"r10","via":"annotation","annotation":"JmsListener","element":"destination","kind":"queue","role":"consumes","name":"jms-listener","description":"a method listening on a JMS queue/topic"},
 {"id":"r11","via":"call","token":"setType","argIndex":0,"kind":"event","role":"produces","name":"payload-discriminator-set","description":"sets the payload field that routes which handler processes it"},
 {"id":"r12","via":"call","token":"equals","argIndex":0,"kind":"event","role":"consumes","name":"payload-discriminator-branch","description":"branches on the payload field value (PAIRED with the setter of the same literal)"}]
ALWAYS pair a "method" producer with the "attr" (key from call) consumer — e.g. a class method
\`refreshSection()\` AND the \`(click)="refreshSection()"\` that invokes it — so the binding grounds.
`;
}

function _parse(out: Map<string, any>): KeyMatcher[] {
  const seen = new Set<string>();
  const matchers: KeyMatcher[] = [];
  for (const obj of out.values()) {
    const m = validateMatcher(obj);
    if (!m) continue;
    const id = matcherKey(m);
    if (seen.has(id)) continue;
    seen.add(id);
    matchers.push(m);
  }
  return matchers;
}

// The token to echo back as a "matched nothing" hint on the self-correction round (call/assign carry a
// callee/receiver identifier; attr carries its directive prefix).
const _feedbackToken = (m: KeyMatcher): string => (m.via === "attr" ? m.directive : m.via === "method" ? "method" : m.via === "annotation" ? `@${m.annotation}` : m.token);

// A matcher DETECTS if it re-executes to ≥1 key over the candidate files (step 3-4: it actually matches).
async function _detects(m: KeyMatcher, files: { file: string; text: string }[]): Promise<boolean> {
  for (const f of files) if ((await runMatcher(m, f.file, f.text)).length > 0) return true;
  return false;
}

// LEARN reusable matchers from floor-blind files: synthesize → validate shape → re-execute → keep only those
// that detect, with one self-correction retry on the misses → persist + return. No-op without opts.llm/budget.
export async function learnKeyMatchers(
  repo: string, blindFiles: { file: string; text: string }[], opts: MatcherOpts, ctx: EngineCtx,
): Promise<KeyMatcher[]> {
  if (!opts.llm || !blindFiles.length || ctx.keyBudget <= 0) return [];
  // ALREADY-LEARNED gate: matcher learning is the expensive LLM step. Key it by a signature of its blind-file
  // INPUT (path + content hash) — a re-run with the same intent sees the same blind files, so we replay the
  // cached rules instead of paying the LLM AGAIN. The content hash means editing a blind file re-learns. This
  // is what stops `--data-coupling llm` from regenerating every run.
  const sig = createHash("sha1").update(blindFiles.map((f) => `${f.file}:${createHash("sha1").update(f.text).digest("hex")}`).sort().join("\n")).digest("hex");
  if (hasLearnedMatchersFor(repo, sig)) return loadMatchers(repo);
  // bound the snippet payload (the LLM derives the SHAPE from the visible code). BREADTH over depth: a small
  // per-file snippet from MANY files, so a recurring pattern (the same `getItem('…')` across files) is visible
  // and generalises into ONE rule — instead of each file's keys being listed literally by the per-file pass.
  const snippets: { file: string; snippet: string }[] = [];
  let size = 0;
  for (const f of blindFiles) {
    const len = Math.min(f.text.length, MATCHER_PER_FILE);
    if (size + len > MATCHER_SNIPPET_CAP && snippets.length) break;
    snippets.push({ file: f.file, snippet: f.text.slice(0, MATCHER_PER_FILE) });
    size += len;
  }

  const synth = async (deadTokens: string[]): Promise<KeyMatcher[]> => {
    if (ctx.keyBudget <= 0) return [];
    ctx.keyBudget -= 1;
    try { return _parse(await run_pass_async(_prompt(snippets, deadTokens), { model: opts.model, claudeBin: opts.claudeBin, tag: PASS.tag })); }
    catch (e) { if (!(e instanceof LLMError)) throw e; return []; }
  };

  emit(`Learning shared-key adapter rule(s) for ${snippets.length} floor-blind file(s) via LLM…`);
  const candidates = await synth([]);
  const accepted: KeyMatcher[] = [], failed: KeyMatcher[] = [];
  for (const m of candidates) (await _detects(m, blindFiles) ? accepted : failed).push(m);

  // step 5 — ONE retry: on detection MISSES (feed the dead tokens back to correct them), OR when the first
  // round produced NOTHING usable at all (an empty / over-conservative reply — a bare re-ask recovers it,
  // model nondeterminism on small snippets). Skipped once we already have accepted matchers + no misses.
  if (failed.length || !accepted.length) {
    const have = new Set(accepted.map(matcherKey));
    for (const m of await synth(failed.map((f) => _feedbackToken(f))))
      if (!have.has(matcherKey(m)) && await _detects(m, blindFiles)) { accepted.push(m); have.add(matcherKey(m)); }
  }

  persistMatchers(repo, accepted);
  recordLearnedMatchers(repo, sig);   // mark this blind-file input learned → a same-intent re-run replays, no LLM
  return accepted;
}

// APPLY matchers deterministically across the repo → a grounding index of their hits MINUS the keys the
// floor already covers (reconciliation — a learned rule that duplicates an adapter is not double-counted).
// No LLM. Empty matchers → empty index (and no walk), so a cold det run with no `.seam/` pays nothing.
export async function applyMatchers(repo: string, matchers: KeyMatcher[], skipDirs: Set<string> = SKIP_DIRS): Promise<GroundingIndex> {
  const idx: GroundingIndex = new Map();
  if (!matchers.length) return idx;
  for (const { rel, text } of walkFiles(repo, skipDirs, scannableForKeys)) {
    let floor: Set<string> | null = null;   // floor reconcile is itself a scan — defer it until a matcher actually hits
    for (const m of matchers) {
      if (!matcherPassesPrefilter(m, text)) continue;                 // file can't contain this rule → skip the (tree-sitter) parse
      const hits = await runMatcher(m, rel, text);
      if (!hits.length) continue;
      floor ??= new Set(scan_file_keys(rel, text).map((h) => `${h.kind} ${h.value}`));
      for (const h of hits) {
        const id = `${h.kind} ${h.value}`;
        if (floor.has(id)) continue;                                 // floor already covers it → reconcile away
        if (!idx.has(id)) idx.set(id, { producers: [], consumers: [] });
        (h.produces ? idx.get(id)!.producers : idx.get(id)!.consumers).push({ file: rel, line: h.line });
      }
    }
  }
  return idx;
}
