// STRUCTURAL PRE-CLUSTERING of floor-blind files — the upfront, deterministic half of the flywheel.
//
// The matcher flywheel GENERALISES a recurring data-access shape into one rule from a couple of examples,
// then applies it repo-wide deterministically. But today the per-file LLM pass still reads EVERY floor-blind
// file (36 on a cal.com booking grow) to get there — even though 30 of them are the SAME shape
// (`prisma.<model>.<verb>()`). That's the cost: N near-identical files all sent to the model.
//
// This module decides "which files share a pattern" STRUCTURALLY and UPFRONT (tree-sitter, no LLM), so the
// LLM only sees ONE representative per pattern; the rest of the cluster is covered by the learned rule
// (applyMatchers, deterministic). This is the right version of an iterative "scan → learn → skip-covered"
// loop: the loop can only discover that two files share a shape by spending LLM on both; clustering knows it
// before spending any (and so never re-pays the learn cost the loop did — measured net-zero grounding).
//
// CLAUDE.md split: the GROUPING is structural (a closed set of access SHAPES read from the atoms node-kind
// registry — never a regex over meaning); naming/role of the resulting rule stays the LLM's job, on the rep.
// Degrades to one-cluster-per-file (no collapse → current behaviour) when tree-sitter is unavailable.
import { createHash } from "node:crypto";
import { available, lang_for, makeCtx, Ctx, _CALL, _MEMBER, _MEMBER_NAME, _NAME_KINDS, _STRING_KINDS } from "../atoms.js";
import { loadShard, saveShard } from "../../core/resolve/index_cache.js";

// PURELY STRUCTURAL, content-hash-keyed cache for the per-file tree-sitter shape scan (`_shapeScan`) — the
// tree-sitter parse this module runs on every floor-blind file was being REPEATED on every warm CLI run (a
// separate process each time), because the only persisted cache for these files (key_store.ts's per-file
// key-adapters entries) is written by the CALLER only when the LLM/matcher pass actually ran — in
// `--data-coupling floor` mode it never does, so those files stay "uncached" there forever and re-cluster
// from scratch. This cache is deliberately a SEPARATE, narrower fact: "this file's structural shape tokens
// are X" is always true regardless of whether an LLM/matcher rule was ever learned from them, so it's safe
// to persist unconditionally — unlike a `cluster-covered` marker, it never claims a rule grounds the file.
type ShapeScan = { tokens: string[]; weak: string[]; hasSignal: boolean };
const _SHAPE_CACHE = "shape-scan-v1";
const _contentKey = (file: string, text: string): string => `${file} ${createHash("sha1").update(text).digest("hex")}`;

// Cross-language self-reference keywords (a closed LINGUISTIC set, not a framework list): a member chain
// rooted at `this`/`self` is too common to be a distinctive cluster signature (it would over-merge unrelated
// files). Most grammars type `this` as its own node kind (auto-excluded by _NAME_KINDS below), but Python's
// `self` is a plain identifier — so we drop these explicitly. Anything else (`prisma`, `db`, `repo`, `bus`)
// is a real, distinctive receiver.
const _SELF_REFS = new Set(["this", "self", "super"]);

const _ARGS = new Set(["arguments", "argument_list"]);

// The leftmost identifier of a (possibly nested) member/call expression — the ROOT receiver of a chain.
function _rootId(ctx: Ctx, node: any): string | null {
  let n = node;
  while (n && !_NAME_KINDS.has(n.type)) {
    const kids = ctx.children(n);
    if (!kids.length) return null;
    n = kids[0];
  }
  return n && _NAME_KINDS.has(n.type) ? ctx.text(n) : null;
}

// Does the call carry a STRING-LITERAL argument of ITS OWN (the key for a string-keyed channel —
// publish('topic'), getItem('k'), from('users'))? Descends the arguments but STOPS at a nested call, so
// `JSON.parse(getItem('k'))` does not credit the inner key to the outer `parse`.
function _hasStringArg(ctx: Ctx, call: any): boolean {
  const args = ctx.children(call).find((c) => _ARGS.has(c.type));
  if (!args) return false;
  const stack = ctx.children(args);   // the actual arguments, not the wrapper node
  while (stack.length) {
    const n = stack.pop();
    if (_STRING_KINDS.has(n.type)) return true;
    if (_CALL.has(n.type)) continue;   // a nested call's string belongs to THAT call, not this one
    stack.push(...ctx.children(n));
  }
  return false;
}

// The structural shape-tokens a file exhibits — clustered by the DATA OBJECT (the receiver), so a whole
// channel's methods land together: `recv:prisma` covers `prisma.<x>.find()` AND `prisma.<x>.create()`,
// `recv:localStorage` covers `getItem('k')` AND `setItem('k')` (the producer+consumer pair grounding needs).
// These are CANDIDATE shapes — the closed vocabulary the matcher IR generalises — never the value/meaning.
// A call only counts as a data shape when it's either a member CHAIN (`recv.member.verb()` — the member is
// the key, ORM/repo) or carries a STRING-LITERAL key arg (`recv.method('k')`); a bare `arr.map(fn)` doesn't.
// Returns the multiset.
// Returns BOTH the strict cluster tokens AND a lenient `hasSignal`, in ONE traversal:
//  • tokens — the DISTINCTIVE shapes for CLUSTERING (deep member CHAIN `recv.x.verb()` or a STRING-KEYED call).
//  • hasSignal — the LENIENT DISCARD signal: ANY member-access call (incl. a 2-level `Payment.where` the strict
//    tokens miss) OR any string-literal call arg. A file with NEITHER is a pure declaration (DTO/interface/enum,
//    or bare-local-call logic) that PROVABLY can't carry a cross-FILE shared key → safe to discard. Conservative:
//    we KEEP on any doubt (keeping a file is safe — just less saving; dropping a real edge is a recall loss).
// Ruby constants / Java scoped names that _NAME_KINDS may not list — a call receiver can be any of these.
const _NAMEISH = new Set(["constant", "scoped_identifier", "identifier", "simple_identifier", "type_identifier"]);
// The ROOT RECEIVER of a call, CROSS-GRAMMAR (this is the fix for Java/Ruby, where clustering did nothing):
//  • JS/TS   `a.b.c()`     — a member_expression callee; walk to its leftmost id.
//  • Java    `rs.getBytes()` (method_invocation) / Ruby `Payment.where()` (call) — the call node itself holds
//    [receiver, ".", method, args]; ≥2 name children BEFORE the arg list ⇒ the first is the receiver.
//  • bare    `f()`         — one name, no receiver → null (not a channel).
// Returns { recv, deep } — deep = a ≥3-level member chain (`prisma.user.find`), the strongest ORM/repo signal.
function _callReceiver(ctx: Ctx, call: any): { recv: string; deep: boolean } | null {
  const kids = ctx.children(call);
  const memberCallee = kids.find((c) => _MEMBER.has(c.type));
  if (memberCallee) {
    const root = _rootId(ctx, memberCallee);
    if (!root || _SELF_REFS.has(root)) return null;
    const obj = ctx.children(memberCallee)[0];
    return { recv: root, deep: !!(obj && _MEMBER.has(obj.type)) };
  }
  const argsIdx = kids.findIndex((c) => _ARGS.has(c.type));
  const names = (argsIdx >= 0 ? kids.slice(0, argsIdx) : kids).filter((c) => _NAME_KINDS.has(c.type) || _NAMEISH.has(c.type));
  if (names.length >= 2) { const recv = ctx.text(names[0]); return recv && !_SELF_REFS.has(recv) ? { recv, deep: names.length >= 3 } : null; }
  return null;
}

async function _shapeScan(ctx: Ctx): Promise<{ tokens: string[]; weak: string[]; hasSignal: boolean }> {
  const tokens: string[] = [];   // STRICT coupling shapes (deep chain / string-keyed) — the primary cluster signature
  const weak: string[] = [];     // WEAK fallback: a bare 2-level receiver (`booking.save()`, `Payment.where()`, `rs.getBytes()`).
  // LENIENT DISCARD signal — LANGUAGE-AGNOSTIC: a file with NO CALL node at all is a pure declaration (interface /
  // DTO / enum / type alias) that CANNOT reach a store/route/queue → can't couple. Anything with a call is KEPT.
  const hasSignal = ctx.collect(ctx.root, (k) => _CALL.has(k)).length > 0;
  for (const call of ctx.collect(ctx.root, (k) => _CALL.has(k))) {
    const r = _callReceiver(ctx, call);
    if (r) {
      // deep chain / string-keyed = a DISTINCTIVE coupling shape → strict. A bare 2-level `recv.verb()` (a repo /
      // model / entity call — `Payment.where`, `rs.getBytes` — the strict rule misses) → WEAK: still clusters files
      // that share the receiver (one rep LLM'd for the whole channel) and grounds ORM/repo access. Same receiver ⇒
      // same channel ⇒ recall-safe. This now fires on Java/Ruby too, so their per-file flood finally collapses.
      (r.deep || _hasStringArg(ctx, call) ? tokens : weak).push(`recv:${r.recv}`);
    } else {
      const callee = ctx.children(call).find((c) => _NAME_KINDS.has(c.type) || _NAMEISH.has(c.type));
      if (callee && _hasStringArg(ctx, call)) tokens.push(`call:${ctx.text(callee)}`);   // bare `f('lit')`
    }
  }
  return { tokens, weak, hasSignal };
}

// The DOMINANT (most frequent) shape-token — the file's cluster signature. Empty when the file shows no
// recognised shape (a unique/literal-key file → its own singleton, never collapsed).
function _dominant(tokens: string[]): string {
  if (!tokens.length) return "";
  const count = new Map<string, number>();
  for (const t of tokens) count.set(t, (count.get(t) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
}

// `shaped` = the file exhibits a SUSPECTED data-access edge — a member CHAIN (`recv.x.verb()`, ORM/repo) or a
// STRING-KEYED call (`f('k')`). A floor-blind file with NO such shape (a pure DTO / serializer / entity — the
// `EncryptedByteArrayUserType` infra flood) is blind because it's STRUCTURE, not because it hides a boundary, so
// there is nothing for the matcher flywheel to learn from it. The caller SKIPS `!shaped` clusters — the flywheel
// only spends LLM where an edge is suspected (Brice: "only blind files where the edges are suspected"). The signal
// is STRUCTURAL (a closed call-shape set from the atoms registry), never a keyword guess (CLAUDE.md).
export interface BlindCluster<T> { signature: string; shaped: boolean; rep: T; members: T[] }

// Cluster floor-blind files by their dominant structural shape: same distinctive signature → one cluster
// (LLM the representative, the rest ground via the learned rule). Shapeless files stay singletons but are marked
// `shaped:false` so the caller drops them. Tree-sitter unavailable → one cluster per file, all `shaped:true` (we
// can't read the shape, so keep the old behaviour). Opt out of the shape gate with SEAM_COUPLING_SHAPE_GATE=0.
export async function clusterBlindFiles<T extends { file: string; text: string }>(files: T[], repo?: string): Promise<BlindCluster<T>[]> {
  // DEFAULT-ON: discard a floor-blind file that carries NO coupling signal at all — no member-access call, no
  // string-literal key (a pure DTO/interface/enum, or bare-local-call logic). It PROVABLY can't share a cross-file
  // key, so the flywheel wastes LLM on it. This is LENIENT (keeps any 2-level `Payment.where` ORM call), which
  // closes the strict gate's recall hole — so it's safe as a default, not a per-stack knob. Opt out: SEAM_COUPLING_SHAPE_GATE=0.
  const gate = process.env.SEAM_COUPLING_SHAPE_GATE !== "0";   // gate only decides DROPPING; clustering-collapse always runs
  if (!available()) return files.map((f) => ({ signature: "", shaped: true, rep: f, members: [f] }));
  const groups = new Map<string, { sig: string; richness: number; member: T; shaped: boolean }[]>();
  for (const f of files) {
    const lang = lang_for(f.file);
    const ck = repo ? _contentKey(f.file, f.text) : "";
    const cached = repo ? loadShard<ShapeScan>(repo, _SHAPE_CACHE, ck) : undefined;
    let scan: ShapeScan | null;
    if (cached) scan = cached;
    else {
      const ctx = lang ? await makeCtx(f.text, lang) : null;
      scan = ctx ? await _shapeScan(ctx) : null;   // null = unsupported lang → can't read → keep (shaped)
      if (repo && scan) saveShard(repo, _SHAPE_CACHE, ck, scan);
    }
    // signature = the STRICT coupling shape if any, else the WEAK 2-level receiver (so shapeless-but-has-calls files
    // cluster by their repo/model receiver instead of each becoming its own LLM rep). Both dominant-most.
    const sig = scan ? (scan.tokens.length ? _dominant(scan.tokens) : _dominant(scan.weak)) : "";
    const richness = (scan?.tokens.length ?? 0) + (scan?.weak.length ?? 0);
    const shaped = !gate || scan === null || scan.hasSignal;   // no coupling signal at all ⇒ pure declaration ⇒ drop
    const key = shaped ? (sig || `\0solo:${f.file}`) : `\0noshape:${f.file}`;   // NUL prefix can't collide with a real signature
    (groups.get(key) ?? groups.set(key, []).get(key)!).push({ sig, richness, member: f, shaped });
  }
  const clusters: BlindCluster<T>[] = [];
  for (const entries of groups.values()) {
    const rep = entries.reduce((a, b) => (b.richness > a.richness ? b : a));   // richest example = clearest to the LLM
    clusters.push({ signature: rep.sig, shaped: rep.shaped, rep: rep.member, members: entries.map((e) => e.member) });
  }
  // LEVERAGE order: a shared-shape cluster's single rep covers ALL its members via the learned rule, so when
  // the LLM budget caps the reps, spend it on the big clusters first (one call → many files grounded) before
  // the singleton long-tail. Stable sort → walk order preserved within a size (deterministic).
  return clusters.sort((a, b) => b.members.length - a.members.length);
}
