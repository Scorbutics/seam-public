// `--locate <name>` — WHERE DOES THIS NAME LIVE?
//
// The mechanical half of anchoring, and nothing more. Measured in bench/grep-vs-seam: every Seam arm opened by
// hunting for a definition it had already decided it wanted — `rg "export .*\bcn\b"`, `rg "function cn|const cn"`,
// then reading files to confirm — 3 to 8 calls before the first real query, on every run.
//
// IT DOES NOT PICK A CENTER. Choosing which symbol answers a question is a semantic judgement that belongs to the
// caller, and the engine's text-matcher is measurably worse at it — SKILL.md tells an agent to always pass
// `--center` for exactly that reason. So when a name has several definitions this prints ALL of them with what
// distinguishes them and lets the caller decide. It resolves an address; it does not form an opinion.
import type { Args } from "./args.js";
import { loadAddon } from "../codebase/rust_core.js";
import { err } from "./util.js";

export async function runLocate(a: Args): Promise<number> {
  const name = (a.locate ?? "").trim();
  if (!name) err("--locate needs a symbol or file name");
  const addon: any = loadAddon();
  const rows: any[] = addon.locateName(a.repo, name, 25) ?? [];

  if (!rows.length) {
    // An honest empty: say which corpus was searched, so the caller knows whether to widen or to spell it right.
    process.stdout.write(`No definition of '${name}' found in ${a.repo}.\n`
      + `It may be an external package symbol, defined dynamically, or spelled differently — grep is the right next step.\n`);
    return 0;
  }

  const one = rows.length === 1;
  process.stdout.write(`# Locate: ${name}\n`
    + `${rows.length} definition(s)${one ? "" : " — YOU choose which one answers your question; this only resolves addresses"}\n\n`);
  for (const r of rows) {
    const sig = r.signature ? `${r.signature}` : "";
    const encl = r.enclosing ? `  in ${r.enclosing}` : "";
    process.stdout.write(`- ${r.file}#${r.symbol}   [${r.kind}${r.isTest ? ", TEST" : ""}]${encl}\n`
      // `signature` is ALREADY the full declaration text, so prefixing the symbol printed `cnexport function cn(`.
      + (sig ? `    ${sig}\n` : ""));
  }
  // The paste-ready line: this command exists to produce the argument of the NEXT one.
  process.stdout.write(`\n## Next\n`
    + (one
      ? `--center "${rows[0].file}#${rows[0].symbol}"\n`
      : `Pick one, then pass it as --center "<file>#<symbol>". Non-test definitions are listed first;\n`
        + `a same-named symbol in another file is a DIFFERENT thing, so the choice is yours to make.\n`));
  return 0;
}

// `--locate-intent "<phrase>" [--scope <dir>[,<dir>…]]` — THE INTENT HALF of anchoring.
//
// WHY IT EXISTS. `--locate <name>` closes the address hunt, but only once the caller already knows the name. An
// agent starting from a prose task ("how does the admin UI update a realm") has no name, and that gap is what
// pushed `--scan --intent` into picking the anchor ITSELF via two LLM judge passes (grow/center_repo.ts). Those
// judges were measured on 2026-07-31 over four uncached keycloak runs: 18s–81s, and they picked a DIFFERENT
// mechanism cluster on 1 run in 4 — nondeterministic enough that a `centers-v1` cache exists purely to freeze
// one sample so grows stay reproducible. An engine that answers the same question two ways is not a fact source.
//
// SAME CONTRACT AS `--locate`: candidates out, NO PICK. The caller is already an LLM with the full task, the
// conversation and its own prior findings; Seam's judge got an intent phrase and a bounded list. Handing the
// choice back to the caller is both more honest and better-informed.
//
// THE RANKING IS LEXICAL AND SAYS SO. `center_candidates` scores name overlap against the phrase, so a verb like
// "reads" pulls in `Base64.read` and `StreamUtil.readString` (measured, keycloak, unscoped). That is why `--scope`
// exists and why the output states the basis: an honest weak ranking the caller can correct beats a confident one
// it cannot see into. Scope is the caller's to supply — the engine guessing the domain directory is the LLM pass
// this command replaces.
/// Sort candidates IN PLACE by intent-token overlap, then fan-in, then address. Exported so the line it defends
/// is testable without a repo: the cap must never fall before the phrase has had its say.
export function rankByIntent(rows: any[], intent: string): any[] {
  const toks = intent.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const overlap = (r: any): number => {
    const hay = `${r.symbol ?? ""} ${(r.file ?? "").split("/").pop() ?? ""}`.toLowerCase();
    return toks.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
  };
  return rows.sort((x, y) => overlap(y) - overlap(x) || (y.fanIn ?? 0) - (x.fanIn ?? 0)
    || `${x.file}#${x.symbol}`.localeCompare(`${y.file}#${y.symbol}`));
}

export async function runLocateIntent(a: Args): Promise<number> {
  const intent = (a.locateIntent ?? "").trim();
  if (!intent) err("--locate-intent needs an intent phrase, e.g. --locate-intent \"how a booking is persisted\"");
  const scope = (a.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const addon: any = loadAddon();
  let rows: any[] = [];
  try {
    rows = JSON.parse(addon.growCenterCandidates(a.repo, intent, scope.length ? scope : undefined, a.excludeDirs ?? [], !!a.includeTests, 0) ?? "[]");
  } catch (e) { err(`candidate scan failed: ${(e as Error).message}`); }

  if (!rows.length) {
    process.stdout.write(`No candidate definition matched "${intent}"${scope.length ? ` under ${scope.join(", ")}` : ""} in ${a.repo}.\n`
      + `The match is LEXICAL (name overlap with the phrase), so a domain word that appears in no identifier finds nothing.\n`
      + `Try the words the code would use, widen --scope, or use --locate <name> if you already know the symbol.\n`);
    return 0;
  }

  // RE-RANK BY INTENT OVERLAP BEFORE TRUNCATING. The core ranks scoped candidates "type-first then fan-in" with
  // NO intent scoring (see grow_center_candidates' contract), which for a directory of same-shaped classes
  // degenerates to ALPHABETICAL. Measured: `--scope .../resources/admin` put Admin*/Attack*/Client*/Component*
  // in the top 25 and cut `RealmAdminResource` — the one class the phrase names, and the anchor the keycloak
  // benchmark agent actually used. A 25-row answer that excludes the answer is worse than no command at all, so
  // the cap must not fall before the phrase has had its say. Deterministic: token overlap, then fan-in, then
  // address, so the same phrase always yields the same order.
  rankByIntent(rows, intent);
  const shown = rows.slice(0, 25);
  process.stdout.write(`# Locate by intent: ${intent}\n`
    + `${rows.length} candidate(s)${rows.length > shown.length ? `, showing ${shown.length}` : ""}`
    + `${scope.length ? ` under ${scope.join(", ")}` : " across the repo"}`
    + ` — YOU choose which one answers your question; this only ranks addresses\n\n`);
  for (const r of shown) {
    const encl = r.enclosing ? `  in ${r.enclosing}` : "";
    process.stdout.write(`- ${r.file}#${r.symbol}   [${r.kind}, fan-in ${r.fanIn ?? 0}]${encl}\n`
      + (r.signature ? `    ${r.signature}\n` : ""));
  }
  // STATE THE BASIS, so a bad ranking reads as a weak signal rather than a wrong answer.
  process.stdout.write(`\n## How this was ranked\n`
    + `Lexical name overlap with the phrase, then fan-in (how many places call it)`
    + `${scope.length ? "" : " — UNSCOPED, so a common verb in the phrase will pull in unrelated same-named methods"}.\n`
    + `No semantic model, no LLM: the same phrase always returns the same list.\n`
    // Say the sharp edge out loud. Matching is exact substring, NOT stemmed: "persisted" does not match
    // `persistPayment`, so the literal answer can sit a rank or two down. A caller who knows that reads the
    // whole list; one who doesn't reads row 1 and trusts it.
    + `Matching is exact substring, not stemmed — "persisted" will not match \`persist\`, so scan the list rather than taking row 1.\n`
    + `\n## Next\n`
    + `Pick one, then pass it as --center "<file>#<symbol>".\n`
    + (scope.length ? "" : `If the list looks off-subject, narrow it: --scope <dir> (the domain directory).\n`));
  return 0;
}
