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
