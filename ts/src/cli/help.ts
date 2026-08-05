// `seam --help` — the CLI's own description of itself.
//
// This did not exist. `--help` fell through to the unknown-flag warning and the run then died with
// "No diff source given: pass --file or --git", which is the same class of trap the note at decompose.ts:937
// records: a caller who cannot discover the surface cannot drive the CLI.
//
// It was measured, not guessed. In `bench/grep-vs-seam` run 1 the arm holding Seam opened with `seam --help` in
// ALL THREE cases, got the error, and then reverse-engineered the flags by reading the engine's OWN SOURCE
// (`grep -n '"--' src/cli/decompose.ts`, `sed -n 380,500p …`). The first real query landed at call 8 of 52
// (private-app), 9 of 60 (cal.com), 6 of 46 (keycloak) — roughly 5-8 calls per run, ~13% of the budget, spent on
// discovery, and charged to Seam's measured cost as though it were analysis.
//
// SHAPE OF THE QUESTION FIRST, flags second. That ordering is deliberate: the hard part of driving Seam is not
// the flag spelling, it is knowing which of the shapes answers the question in hand. An alphabetical flag dump
// would have prevented the error without preventing the source-reading.
//
// The query list is derived from the live handler registry, so a shape added or removed cannot silently drift
// out of the help text.

/** One shape: the question it answers, and how to invoke it. Keyed by the `--query` value. */
const QUERY_HELP: Record<string, { answers: string; needs: string }> = {
  consumers: { answers: "who calls / uses this symbol — the resolved set of callers, per usage SITE", needs: "--center <file>#<symbol>" },
  dependencies: { answers: "what this symbol delegates to — its outbound edges", needs: "--center <file>#<symbol>" },
  impact: { answers: "blast radius — what breaks if you change this", needs: "--center <file>#<symbol>" },
  contract: { answers: "a module's boundary — each export with its DECLARED signature, its OBSERVED\n                       call sites (count + argument-count histogram), and its consumers", needs: "--center <file>   (a module, no #symbol)" },
  neighborhood: { answers: "the subsystem around this symbol — cohesion and the boundary cut", needs: "--center <file>#<symbol> [--depth <n>]" },
  reaches: { answers: "can A reach B? — a verdict plus the witness path", needs: "--center <file>#<symbol> --to-symbol <t> [--to-file <f>]" },
  writers: { answers: "who WRITES the state this symbol reads (reverse data coupling)", needs: "--center <file>#<symbol>" },
  // NAMED BY THE QUESTION, not by the mechanism. "the shared keys this symbol touches" is what it computes;
  // "which endpoints does this class serve" is what a caller asks, and the old wording answered neither
  // recognisably. Measured (bench/grep-vs-seam, keycloak): 11 of 28 search attempts in six seam-arm runs were
  // `grep -n "@GET\|@Path\|@PUT" <one Java file>` — this shape prints exactly that, with handler and code,
  // and the agent never reached for it.
  coupling: { answers: "which HTTP endpoints a class SERVES (@GET/@Path + handler + line), and the db tables / events / routes this symbol touches", needs: "--center <file>#<symbol>" },
  brief: { answers: "EVERYTHING structural about one symbol in ONE call — direct consumers + transitive impact\n                       + dependencies + boundary contract. Start here; reach for a single shape to go deeper", needs: "--center <file>#<symbol>" },
  refactor: { answers: "the same bundle as `brief` (kept for compatibility)", needs: "--center <file>#<symbol>" },
  compare: { answers: "how two symbols differ structurally", needs: "--center <f>#<s> --to-file <f2> --to-symbol <s2>" },
};

/**
 * The help text. `queries` is the live set of registered `--query` values, so an unregistered shape is listed as
 * undocumented rather than omitted — a missing row here is a doc bug, and it should be visible as one.
 */
export function helpText(queries: string[]): string {
  const rows = queries.map((q) => {
    const h = QUERY_HELP[q];
    return h
      ? `  --query ${q.padEnd(13)} ${h.answers}\n${" ".repeat(23)}${h.needs}`
      : `  --query ${q.padEnd(13)} (undocumented — see src/cli/help.ts)`;
  });
  const undocumented = Object.keys(QUERY_HELP).filter((q) => !queries.includes(q));

  return `seam — decompose code into SEAMS (units of one intent) so you review and understand BY INTENT
       instead of file by file. Structural and deterministic: it resolves edges rather than matching text.

USAGE
  seam --locate <name> --repo <repo>                                      WHERE a name lives (do this first)
  seam --scan --repo <repo> --query <shape> --center <file>[#<symbol>]     a resolved SHAPE (no LLM)
  seam --scan --repo <repo> --center <file>#<symbol> --intent "<q>"        a footprint MAP around an anchor
  seam --scan --repo <repo> --auto --center <f>#<s> --intent "<q>"         GROW a flow to its culmination
  seam --scan ... --auto --center <f>#<s> --to-kind route --intent "<q>"   GROW both sides of a CROSS-STACK flow
  seam --scan ... --to-kind route --with-consumers 2 --intent "<q>"        …and the center's own callers too
  seam --git <range> --repo <repo>                                        decompose a DIFF into review seams

WHEN TO REACH FOR WHICH
  A single fact, one symbol, a string literal        -> use grep. Seam is overkill and slower.
  Anything structural about ONE symbol                -> --query brief. One call, four answers. START HERE.
  "who calls X", "what breaks if I change X"         -> a SHAPE (--query, list below). Deterministic, no LLM.
  A flow that CROSSES the stack (UI -> HTTP -> server) -> --to-kind route. Name the end you know; the other
                                                        side of every route the center touches is derived from
                                                        the coupling floor and pinned as a center. Also
                                                        table / queue / egress for data and message boundaries.
  "how does X work / flow end to end"               -> a GROW (--auto --intent), which follows the path.
  "what does this module expose and how is it used" -> --query contract.
  "what does this diff do"                          -> diff mode (--git / --file).

THE SHAPES (deterministic; each prints a resolved set, not a guess)
${rows.join("\n")}
${undocumented.length ? `\n  NOTE: documented but NOT registered: ${undocumented.join(", ")} — stale help entry.\n` : ""}
KEY FLAGS
  --repo <dir>            the repository to analyse (default: cwd)
  --locate <name>         every definition of a name, ranked, with what distinguishes them. Answers "where does
                          the symbol I picked live" in ONE call, so you can pass --center instead of hunting for
                          it. It does NOT choose for you: several definitions come back as several rows.
  --center <file>[#<sym>] THE ANCHOR. Pass it — do not make the engine guess. Several: comma-separated.
  --intent "<question>"   what you are looking for; ranks and tiers the result. REQUIRES --center: it shapes
                          the answer, it does not choose where to look (use --locate if you need the address)
  --scan                  codebase mode (implied by --query / --ask)
  --auto                  grow the footprint along the flow to its culmination
  --concern               center-first map for a "how is X handled across the app" question
  --format <f>            on a SHAPE (--query): llm-context (DEFAULT) is the full answer; ANY other value
                          gives only the one-line summary. On a MAP / GROW: llm-context (DEFAULT) | agent
                          (token-budgeted) | concern | json (the raw model).  On a DIFF: llm | ascii
  --depth <n>             how far to expand (neighborhood; default 1)
  --max-nodes <n>         cap the grow's size
  --data-coupling <mode>  off | floor (deterministic adapters) | llm | auto (DEFAULT)
  --emit-seams <file>     write the full JSON model (for the VS Code extension; ~40x larger than the map)
  --ask "<question>"      natural language -> routed to the right shape (needs an LLM backend)
  --no-snippets           drop the source text (shown by default for the reading formats)
  -v, --verbose           progress + diagnostics on stderr;  --trace adds per-node timing

READING THE OUTPUT
  Provenance is explicit and load-bearing. RESOLVED_FULL / RESOLVED_PARTIAL are VERIFIED edges. A "blindspot"
  or "gap" section lists statically-opaque edges (cross-language, DI, string dispatch) as SUGGESTED LEADS to
  check with grep, never as asserted facts. Every shape states its COUNTING UNIT, because the same
  relationship counted per call site and per consuming file gives two different numbers.

  seam slm --help        the local fast-model helper (optional, for the grow's cheap-tier judge)
`;
}
