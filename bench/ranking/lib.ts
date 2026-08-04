// SHARED GROUND for the ranking bench — the demand fixture, the grow replay, and the per-file signals.
//
// Extracted so `rank-eval.ts` (the scoreboard) and `boundary.ts` (the diagnostic) cannot drift apart. They
// must rank and probe the SAME numbers; a second copy of `signals()` that quietly disagreed would make the
// diagnostic explain a scoreboard that no longer exists.
import { readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

const HERE = dirname(new URL(import.meta.url).pathname);
export const TS = join(HERE, "..", "..", "ts");
const CACHE = join(HERE, "cache");

// ── the demand fixture ───────────────────────────────────────────────────────────────────────────────────────
export type DCase = { case: string; arm: "A" | "B"; repo: string; seamCmds: string[]; reads: string[]; bashReads: string[] };
export const demand: DCase[] = JSON.parse(
  execSync(`bun ${join(HERE, "demand.ts")} --json`, { cwd: TS, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 }),
);

// ── the closure: replay the case's own grow as JSON ──────────────────────────────────────────────────────────
// The grow is REPLAYED, not re-invented: the ranking must be scored on the closure the agent was actually
// given, intent string and all. `--format json` (never `--skeleton`, which suppresses the tier the scoreboard
// exists to measure) and a disk cache keyed by the command, because each grow is ~60 s of scan.
/// ONE COMMAND, NOT THE REST OF THE SCRIPT. A stored invocation is often a multi-line shell block:
///
///   bun ts/src/cli/decompose.ts --scan … --format concern > out 2> err
///   echo EXIT $?
///   wc -l out
///   tail -5 err
///
/// Taking everything after `decompose.ts` kept all four lines, so the replay ran the grow with no `--format
/// json` and appended `--format json > cache` to the `tail` — the cache then held tail's output and every
/// cal.com case in that form reported "grow replay produced nothing". Cut at the first UNQUOTED newline or
/// shell operator, after folding backslash continuations, and the quoted `--intent` survives intact.
function cutToOneCommand(s: string): string {
  const folded = s.replace(/\\\r?\n/g, " ");
  let q: string | null = null;
  for (let i = 0; i < folded.length; i++) {
    const c = folded[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "\n" || c === ";" || c === "|" || c === "&") return folded.slice(0, i);
  }
  return folded;
}

export function growOf(cmd: string): any | null {
  const flags = cutToOneCommand(cmd.split("decompose.ts", 2)[1] ?? "");
  const clean = flags.replace(/\s*\d?>>?\s*\S+/g, "").replace(/--format\s+\S+/g, "").replace(/--skeleton\b/g, "").trim();
  // A REPLAY THAT STILL LOOKS LIKE A SCRIPT IS NOT A REPLAY. Refuse rather than run something unintended.
  if (/[\n;|&]/.test(clean) || !/--center/.test(clean)) return null;
  const key = createHash("sha1").update(clean).digest("hex").slice(0, 16);
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, `${key}.json`);
  if (!existsSync(path)) {
    // REDIRECT, DO NOT BUFFER. Capturing this through execSync's pipe silently TRUNCATES it: bun cut all
    // three of the first replays at a 512-byte boundary (255808 / 365440 / 219264 of ~1.65 MB) and every one
    // cached as valid-looking JSON that would not parse. A grow is megabytes; let the shell write the file.
    try {
      execSync(`bun src/cli/decompose.ts ${clean} --format json > ${JSON.stringify(path)}`, {
        cwd: TS, stdio: ["ignore", "ignore", "ignore"], timeout: 1_800_000,
      });
    } catch { /* fall through to the parse check — a partial file fails there, loudly */ }
  }
  // A CACHE ENTRY THAT DOES NOT PARSE IS DELETED, not kept. A truncated replay that survives on disk turns one
  // transient failure into a permanently wrong scoreboard that reruns cannot clear.
  try { return JSON.parse(readFileSync(path, "utf-8")); }
  catch { try { unlinkSync(path); } catch {} return null; }
}

// ── per-file signals, aggregated over the closure ────────────────────────────────────────────────────────────
/// A file is ranked by its BEST seam, not its average. A ranking that averaged would punish a route class for
/// also containing forty unrelated endpoints — which is precisely the file the prior measurement caught being
/// buried (`RealmAdminResource.java`, 127 opens in arm A, relevance 0.533 among near-identical scores).
/// `shell` is the engine's OWN hop number (`region.shell`), carried alongside the BFS `hops` this bench
/// computes, so the two can be compared directly. They are not the same quantity by construction — `hops` is
/// BFS over the closure's resolved edges from the anchor NODE, `shell` is the flood-fill wave the grow
/// recorded per SEAM — and any engine change keyed on `shell` inherits `shell`'s numbers, not `hops`'.
export type Sig = { file: string; tier: number; rel: number; cites: number; hops: number; toB: number; through: number; shell: number; ehops: number };

export const TIER_RANK: Record<string, number> = { spine: 0, supporting: 1, off: 2 };
/// A BOUNDARY IS A MEDIUM NODE, NOT A CODE NODE — and that distinction is the whole of structural v2. The
/// engine already marks it: a hunk carries `kind: "route" | "table" | "egress" | "resource"` exactly when it
/// IS the address (an HTTP path, a table name), and carries no `kind` when it is ordinary code. So the set is
/// read off the closure rather than inferred.
///
/// v1 instead took both ENDPOINTS of every route/db EDGE, which made 661 of 1060 nodes a "boundary" — the
/// handler, its caller and the address all counted, so "distance to a boundary" was ~0 almost everywhere and
/// 100 files tied at the top. Reading the marker instead gives 332 medium nodes of 1954 hunks, and the
/// distance becomes an ordering rather than a near-constant.
export const MEDIUM_KIND = /^(route|table|egress|resource|queue|topic|key)$/;

export function signals(d: any): Map<string, Sig> {
  const seams: any[] = (d.clusters ?? []).flatMap((c: any) => c.seams ?? []);
  const cites = new Map<string, number>();
  const known = new Set<string>();
  const boundary = new Set<string>();
  for (const s of seams) for (const h of s.hunks ?? []) {
    if (h.id) known.add(h.id);
    if (h.id && MEDIUM_KIND.test(h.kind ?? "")) boundary.add(h.id);
    if (h.file) cites.set(h.file, (cites.get(h.file) ?? 0) + 1);
  }

  /// UNDIRECTED. A flow is not a one-way street in this graph: the same crossing appears as `route-fetch`
  /// client->address and `route-serve` address->handler, so a forward-only walk from the center reaches the
  /// address and stops, never arriving at the handler that the demand actually opens. Hop COUNT is the signal
  /// the directive asks for ("within a small number of hops"), not edge direction.
  const adj = new Map<string, string[]>();
  for (const e of d.edges ?? []) {
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    adj.set(e.to, [...(adj.get(e.to) ?? []), e.from]);
  }
  const bfs = (starts: string[]) => {
    const dist = new Map<string, number>(starts.map((s) => [s, 0]));
    let front = starts;
    while (front.length) {
      const next: string[] = [];
      for (const u of front) for (const v of adj.get(u) ?? []) if (!dist.has(v)) { dist.set(v, dist.get(u)! + 1); next.push(v); }
      front = next;
    }
    return dist;
  };

  /// THE CENTER IS THE ANCHOR NODE, which the closure names in `anchor` — one id, the symbol the grow was run
  /// on. v1 used every hunk of every `region.shell === 0` seam, which is the whole ANCHOR FILE: 228 ids on
  /// keycloak, so "distance from the center" started at 0 across an entire class and could not order anything
  /// inside it. Falls back to the shell-0 seams only when `anchor` is not a node in this closure.
  const anchorId: string | undefined = typeof d.anchor === "string" && known.has(d.anchor) ? d.anchor : undefined;
  const centerIds = anchorId
    ? [anchorId]
    : seams.filter((s) => (s.region?.shell ?? -1) === 0).flatMap((s: any) => (s.hunks ?? []).map((h: any) => h.id));
  const fromCenter = bfs(centerIds);
  const toBoundary = bfs([...boundary]);

  const out = new Map<string, Sig>();
  for (const s of seams) {
    const tier = TIER_RANK[s.tier] ?? 3;
    const rel = typeof s.relevance === "number" ? s.relevance : -1;
    for (const h of s.hunks ?? []) {
      if (!h.file) continue;
      // UNREACHED => Infinity, and the ranking sends it to the tail. This is the one way `structural` can be
      // wrong that the others cannot: a node the edge graph never resolved is scored like an irrelevant one.
      const a = fromCenter.get(h.id) ?? Infinity, b = toBoundary.get(h.id) ?? Infinity;
      const p = out.get(h.file);
      const sh = typeof s.region?.shell === "number" && s.region.shell >= 0 ? s.region.shell : Infinity;
      // THE ENGINE'S OWN per-hunk `hops`, read rather than recomputed. This is the gate on the engine change:
      // if `engine` and `hops` do not score the same, the field that shipped is not the signal that measured.
      const eh = typeof h.hops === "number" ? h.hops : Infinity;
      if (!p) out.set(h.file, { file: h.file, tier, rel, cites: cites.get(h.file) ?? 0, hops: a, toB: b, through: a + b, shell: sh, ehops: eh });
      else {
        p.tier = Math.min(p.tier, tier); p.rel = Math.max(p.rel, rel);
        p.hops = Math.min(p.hops, a); p.toB = Math.min(p.toB, b); p.through = Math.min(p.through, a + b);
        p.shell = Math.min(p.shell, sh); p.ehops = Math.min(p.ehops, eh);
      }
    }
  }
  return out;
}

