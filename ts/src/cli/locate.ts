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

// ONE row renderer for both the single-name and batched forms — two copies is how they would come to disagree
// about what a definition looks like.
const row = (r: any): string => {
  const sig = r.signature ? `${r.signature}` : "";
  const encl = r.enclosing ? `  in ${r.enclosing}` : "";
  // `signature` is ALREADY the full declaration text, so prefixing the symbol printed `cnexport function cn(`.
  return `- ${r.file}#${r.symbol}   [${r.kind}${r.isTest ? ", TEST" : ""}]${encl}\n` + (sig ? `    ${sig}\n` : "");
};

export async function runLocate(a: Args): Promise<number> {
  const name = (a.locate ?? "").trim();
  if (!name) err("--locate needs a symbol or file name");
  const addon: any = loadAddon();

  // COMMA-SEPARATED NAMES — one call, one answer per name.
  //
  // MEASURED (bench/grep-vs-seam, keycloak, 2026-08-01). Anchor hunting dominated the Seam arm, but the call
  // count understated it: 12, 16 and 8 Bash calls carried 19, 23 and 10 `--locate` INVOCATIONS, because agents
  // were already chaining `--locate A; echo ===; --locate B` in one shell command. They wanted a batch and had
  // to fake one.
  //
  // And the natural spelling was worse than unsupported: `--locate "A,B"` looked up the LITERAL string `A,B`,
  // found nothing, and printed "No definition of 'A,B' found … grep is the right next step" — a confident false
  // negative for two symbols that both exist. That is the single failure this command must not have
  // (locate_recall.test.ts), reached through a spelling nobody had tested.
  if (name.includes(",")) {
    const groups: any[] = addon.locateNames(a.repo, name, 25) ?? [];
    const found = groups.filter((g) => g.rows.length);
    process.stdout.write(`# Locate: ${groups.length} name(s)\n`
      + `${found.length} resolved, ${groups.length - found.length} not found — YOU choose which answers your question.\n\n`);
    for (const g of groups) {
      if (!g.rows.length) {
        // NAMED, not silently dropped. Which of the batch came back empty is exactly what a batch lookup is
        // asked, and a flat merged list could not say it.
        process.stdout.write(`## ${g.name} — no definition found (external package, dynamic, or spelled differently)\n\n`);
        continue;
      }
      process.stdout.write(`## ${g.name} — ${g.rows.length} definition(s)\n`);
      for (const r of g.rows) process.stdout.write(row(r));
      process.stdout.write("\n");
    }
    process.stdout.write(`## Next\nPick one per name and pass it as --center "<file>#<symbol>".\n`);
    return 0;
  }

  const rows: any[] = addon.locateName(a.repo, name, 25) ?? [];

  if (!rows.length) {
    // An honest empty: say which corpus was searched, so the caller knows whether to widen or to spell it right.
    process.stdout.write(`No definition of '${name}' found in ${a.repo}.\n`
      + `It may be an external package symbol, defined dynamically, or spelled differently — grep is the right next step.\n`);
    return 0;
  }

  const one = rows.length === 1;
  // A MODULE MATCH IS NOT A SYMBOL MATCH, and printing it as one is a lie of omission.
  //
  // MEASURED (bench/grep-vs-seam, cal-booking-flow, 2026-08-01): `--locate handleNewBooking` printed
  // "25 definition(s)" for a name that defines NOTHING — it is a directory of ~30 modules with no barrel and no
  // symbol of that name. The agent read that as "one of these 25 is what I asked for", could not see which, and
  // spent 7 of its 11 tool calls on ls/find looking for the entry point that does not exist. Three runs, same
  // dead end each time. The engine knew it had fallen back to a path match and said nothing.
  const viaModule = rows[0]?.viaModule === true;
  const noEntry = rows[0]?.moduleNoEntry === true;
  process.stdout.write(`# Locate: ${name}\n`
    + (viaModule
      ? `'${name}' is a MODULE (a directory or file), not a symbol — nothing declares that name.\n`
        + `${rows.length} definition(s) INSIDE it${noEntry ? "" : ", entry point(s) first"}.\n`
      : `${rows.length} definition(s)${one ? "" : " — YOU choose which one answers your question; this only resolves addresses"}\n`)
    + (viaModule && noEntry
      // The honest negative. An agent that knows there is no way in stops looking for one; that is the whole
      // saving. Stating it costs one line and replaces a hunt.
      ? `NO ENTRY POINT: it has no index.* barrel and no '${name}' symbol, so there is no single way in.\n`
        + `Do NOT go looking for one — pick the member below that does the work, or anchor on a CALLER instead.\n`
      : "")
    + `\n`);
  for (const r of rows) process.stdout.write(row(r));
  // The paste-ready line: this command exists to produce the argument of the NEXT one.
  process.stdout.write(`\n## Next\n`
    + (one
      ? `--center "${rows[0].file}#${rows[0].symbol}"\n`
      : `Pick one, then pass it as --center "<file>#<symbol>". Non-test definitions are listed first;\n`
        + `a same-named symbol in another file is a DIFFERENT thing, so the choice is yours to make.\n`));
  return 0;
}
