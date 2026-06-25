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
import { available, lang_for, makeCtx, Ctx, _CALL, _MEMBER, _MEMBER_NAME, _NAME_KINDS, _STRING_KINDS } from "../atoms.js";

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

// Does the call carry a STRING-LITERAL argument (the key for a `call:`-shape — publish('topic'),
// getItem('k'), from('users'))? Callees hold no string literals, so scanning the whole call is safe.
function _hasStringArg(ctx: Ctx, call: any): boolean {
  const args = ctx.children(call).find((c) => _ARGS.has(c.type));
  return ctx.collect(args ?? call, (k) => _STRING_KINDS.has(k)).length > 0;
}

// The structural shape-tokens a file exhibits, e.g. `member:prisma` (a `prisma.<x>.<verb>()` data layer)
// or `call:getItem` (a `<recv>.getItem('k')` / `getItem('k')` channel). These are CANDIDATE shapes — the
// closed vocabulary the matcher IR can generalise — never the value/meaning. Returns the multiset.
async function _shapeTokens(ctx: Ctx): Promise<string[]> {
  const tokens: string[] = [];
  for (const call of ctx.collect(ctx.root, (k) => _CALL.has(k))) {
    // callee = the first child that's a member chain or a bare name (the args list comes after it)
    const callee = ctx.children(call).find((c) => _MEMBER.has(c.type) || _NAME_KINDS.has(c.type));
    if (!callee) continue;
    if (_MEMBER.has(callee.type)) {
      const obj = ctx.children(callee)[0];
      const nameNode = [...ctx.children(callee)].reverse().find((c) => _MEMBER_NAME.has(c.type) || _NAME_KINDS.has(c.type));
      if (obj && _MEMBER.has(obj.type)) {
        // `recv.member.verb(…)` — the ORM/repository shape; the ROOT receiver is the cluster signature
        const root = _rootId(ctx, obj);
        if (root && !_SELF_REFS.has(root)) tokens.push(`member:${root}`);
      } else if (nameNode && _hasStringArg(ctx, call)) {
        tokens.push(`call:${ctx.text(nameNode)}`);   // `recv.method('lit')` — a string-keyed channel
      }
    } else if (_NAME_KINDS.has(callee.type) && _hasStringArg(ctx, call)) {
      tokens.push(`call:${ctx.text(callee)}`);        // bare `f('lit')`
    }
  }
  return tokens;
}

// The DOMINANT (most frequent) shape-token — the file's cluster signature. Empty when the file shows no
// recognised shape (a unique/literal-key file → its own singleton, never collapsed).
function _dominant(tokens: string[]): string {
  if (!tokens.length) return "";
  const count = new Map<string, number>();
  for (const t of tokens) count.set(t, (count.get(t) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
}

export interface BlindCluster<T> { signature: string; rep: T; members: T[] }

// Cluster floor-blind files by their dominant structural shape: same distinctive signature → one cluster
// (LLM the representative, the rest ground via the learned rule). Shapeless files and unique signatures
// stay singletons (always sent). Tree-sitter unavailable → one cluster per file (no collapse).
export async function clusterBlindFiles<T extends { file: string; text: string }>(files: T[]): Promise<BlindCluster<T>[]> {
  if (!available() || files.length < 2) return files.map((f) => ({ signature: "", rep: f, members: [f] }));
  const groups = new Map<string, { sig: string; richness: number; member: T }[]>();
  for (const f of files) {
    const lang = lang_for(f.file);
    const ctx = lang ? await makeCtx(f.text, lang) : null;
    const tokens = ctx ? await _shapeTokens(ctx) : [];
    const sig = _dominant(tokens);
    const key = sig || `\0solo:${f.file}`;   // shapeless → its own group (NUL prefix can't collide with a real signature)
    (groups.get(key) ?? groups.set(key, []).get(key)!).push({ sig, richness: tokens.length, member: f });
  }
  const clusters: BlindCluster<T>[] = [];
  for (const entries of groups.values()) {
    const rep = entries.reduce((a, b) => (b.richness > a.richness ? b : a));   // richest example = clearest to the LLM
    clusters.push({ signature: rep.sig, rep: rep.member, members: entries.map((e) => e.member) });
  }
  // LEVERAGE order: a shared-shape cluster's single rep covers ALL its members via the learned rule, so when
  // the LLM budget caps the reps, spend it on the big clusters first (one call → many files grounded) before
  // the singleton long-tail. Stable sort → walk order preserved within a size (deterministic).
  return clusters.sort((a, b) => b.members.length - a.members.length);
}
