// SNIPPETS (`--snippets[=N]`) — the cited SOURCE TEXT under a `file:line`, opt-in.
//
// WHY IT EXISTS: a blind grader gave a flow-trace round to plain ripgrep over Seam. Both answers had the right
// hops; the grep arm won by going INSIDE the functions Seam had located. Across the eval arms the same shape
// recurs — Seam locates, the agent then re-reads large ranges from the very files Seam pinpointed, and while
// re-deriving line numbers from those bulk reads it introduces citation errors Seam had not made.
//
// WHAT THIS GUARDS: the one thing that makes the feature worth anything — the emitted text is the file's REAL
// text at the cited 1-BASED line. This codebase had a systemic 0-based/1-based citation bug fixed across six
// render sites; a snippet reintroducing it would be worse than no snippet, because it reads as ground truth.
// Plus: no snippet for an unlocated (0/null) member, off by default, and — in the budget-ranked region render —
// snippets yield their budget BEFORE a mechanism step is cropped, never the other way round.
//
// SHAPE OF THE TEST: hand-built models + a hermetic tmp dir of real source files, mirroring the sibling render
// tests (render/impact_hub_cap.test.ts, grow/agent_hub_crossing.test.ts) — these renders are PURE functions of
// an emitted model, so a grow would add minutes and prove less. The tmp FILES are real because the snippet
// reader's whole contract is "what does the file actually say at that line": a stubbed reader would test
// nothing. No tree-sitter, no embeddings, no LLM ⇒ nothing to guard on, green offline.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderAgent } from "../../src/codebase/llm_context.js";
import { renderConsumerSet, renderImpact } from "../../src/codebase/render/shapes.js";
import { makeSnippetReader, snippetsTruncated, MAX_SNIPPET_BYTES } from "../../src/codebase/render/snippets.js";

let REPO = "";

// Every line SAYS its own 1-based number, so an off-by-one is not a subtle diff — it is a wrong number printed
// next to the right one. Lines 10-14 (the window around the cited line 12) all carry 6 spaces of common indent,
// and 13 carries 4 MORE, so the de-indent rule is observable: the common 6 go, the relative 4 stay. The file is
// 20 lines, so a citation at 21 is past EOF.
const NUMBERED = Array.from({ length: 20 }, (_, i) => {
  const n = i + 1;
  if (n === 11) return "      const eleven = 11;";
  if (n === 12) return "      const TARGET = callee(12);";
  if (n === 13) return "          const thirteen = 13;";
  if (n === 10 || n === 14) return `      // line ${n}`;
  return `// line ${n}`;
});

const write = (rel: string, lines: string[]) => {
  const p = join(REPO, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.join("\n"));
};

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "seam-snippets-"));
  write("src/callers/one.ts", NUMBERED);
  write("src/callers/two.ts", NUMBERED);
  write("src/orders/orderService.ts", NUMBERED);
  write("src/orders/computeQuote.ts", NUMBERED);
});
afterAll(() => { if (REPO) rmSync(REPO, { recursive: true, force: true }); });

const consumerModel = () => ({
  shape: "set", anchor: { symbol: "callee", file: "src/callee.ts" }, resolutionQuality: "FULL",
  members: [
    { symbol: "caller1", file: "src/callers/one.ts", line: 12, kind: "function", edgeKind: "call", provenance: "RESOLVED_FULL" },
    // UNLOCATED — the resolver grounded the symbol but no site (project_set's `to1` yields 0). `at` renders it as
    // a bare path; a snippet here would point at an unrelated line, so there must be none.
    { symbol: "ghost", file: "src/callers/two.ts", line: 0, kind: "function", edgeKind: "call", provenance: "RESOLVED_FULL" },
  ],
  unresolved: [], recalled: [], crossStack: [],
});

describe("snippets — the cited text is the file's real text at the cited 1-based line", () => {
  test("the marked line is line N itself, and its neighbours are N±ctx (the 0-based/1-based guard)", () => {
    const out = renderConsumerSet(consumerModel(), makeSnippetReader(REPO, 2));
    expect(out).toContain("caller1 (src/callers/one.ts:12)");
    // the CITED line, marked `>`, carries the number 12 and the text that is genuinely on line 12
    expect(out).toMatch(/^ +12> const TARGET = callee\(12\);$/m);
    // …and the window is 10..14, each number against its own true text — an off-by-one would pair 12> with
    // line 11's or 13's body, which these two assertions forbid.
    expect(out).toMatch(/^ +10│ \/\/ line 10$/m);
    expect(out).toMatch(/^ +11│ const eleven = 11;$/m);
    expect(out).toMatch(/^ +13│ {5}const thirteen = 13;$/m);
    expect(out).toMatch(/^ +14│ \/\/ line 14$/m);
    expect(out).not.toMatch(/12> const eleven/);
    expect(out).not.toMatch(/12> const thirteen/);
  });

  test("the COMMON indentation goes, the RELATIVE indentation stays", () => {
    const out = renderConsumerSet(consumerModel(), makeSnippetReader(REPO, 1));
    // window 11..13, common indent 6 → stripped; line 13's extra 4 survive, so the nesting still reads.
    expect(out).toMatch(/^ +11│ const eleven = 11;$/m);
    expect(out).toMatch(/^ +12> const TARGET = callee\(12\);$/m);
    expect(out).toMatch(/^ +13│ {5}const thirteen = 13;$/m);
    expect(out).not.toMatch(/^ +11│ {7}const eleven/m);   // the shared 6 are NOT reprinted per line
  });

  test("N=0 emits the cited line ALONE (the flag's window is the caller's)", () => {
    const out = renderConsumerSet(consumerModel(), makeSnippetReader(REPO, 0));
    expect(out).toMatch(/^ +12> const TARGET = callee\(12\);$/m);
    expect(out).not.toContain("11│");
    expect(out).not.toContain("13│");
  });

  test("an UNLOCATED member (line 0) gets NO snippet — the bare path stands alone", () => {
    const out = renderConsumerSet(consumerModel(), makeSnippetReader(REPO, 2));
    const ghost = out.slice(out.indexOf("- ghost ("));
    expect(ghost).toContain("- ghost (src/callers/two.ts)");        // `at` already refuses to print `:0`
    expect(ghost.split("\n")[1] ?? "").not.toMatch(/[│>]/);          // and no snippet rides under it
  });

  test("a citation past EOF, or an unreadable file, yields nothing rather than something wrong", () => {
    const snip = makeSnippetReader(REPO, 2);
    expect(snip("src/callers/one.ts", 21)).toEqual([]);              // the fixture is 20 lines
    expect(snip("src/does/not/exist.ts", 3)).toEqual([]);
  });

  test("OFF BY DEFAULT — no reader ⇒ not one snippet character", () => {
    const out = renderConsumerSet(consumerModel());
    expect(out).toContain("caller1 (src/callers/one.ts:12)");
    expect(out).not.toContain("const TARGET");
    expect(out).not.toMatch(/[│>]/);
    expect(out).toBe(renderConsumerSet(consumerModel(), undefined));
  });

  test("the impact shape cites a line under a FILE heading — the snippet reads that file, not the anchor's", () => {
    const model = {
      shape: "impact", anchor: { symbol: "callee" }, total: 1, fileCount: 1,
      files: [{ file: "src/callers/one.ts", count: 1 }],
      impacted: [{ file: "src/callers/one.ts", symbol: "caller1", line: 12, kind: "function", hop: 1 }],
      surface: [], gaps: [],
    };
    const out = renderImpact(model, makeSnippetReader(REPO, 1));
    expect(out).toContain("caller1 (:12)");
    expect(out).toMatch(/^ +12> const TARGET = callee\(12\);$/m);
  });
});

// ---- the region render: snippets are a BUDGET RUNG, spent before a mechanism step is ever cropped.
// 12 steps — MORE than the generic exempt allowance (EXEMPT_N = max(6, budget/500)) at the budgets these tests
// use, so "crop the mechanism" and "drop the snippets" are OBSERVABLY different outcomes: a rung order that
// spent a step before a snippet would show 6 steps here, not 12.
const STEPS = 12;
const agentModel = () => {
  const hunks: any[] = [{ id: "n1", file: "src/orders/orderService.ts", start: 12, role: "core", label: "placeOrder" }];
  const edges: any[] = [];
  for (let i = 1; i <= STEPS; i++) {
    hunks.push({ id: `m${i}`, file: "src/orders/computeQuote.ts", start: 12, role: "link", label: `step${i}` });
    edges.push({ from: "n1", to: `m${i}`, kind: "call", line: 10 * i });
  }
  return {
    mode: "codebase", anchor: "n1", resolutionQuality: "FULL",
    clusters: [{ id: "g1", intent: "placeOrder", seams: [{ id: "d0", label: "placeOrder", tier: "spine",
      region: { shell: 0, direction: "down" },
      primary: { file: "src/orders/orderService.ts", line: 12, symbol: "placeOrder" }, hunks }] }],
    edges, frontier: [], unresolved: [], blindspots: [],
  };
};
const mechOf = (out: string) => out.slice(out.indexOf("## Mechanism"));
const nSteps = (out: string) => (mechOf(out).match(/^ {2}\d+\. /gm) ?? []).length;

describe("snippets in the region render — budget-aware, and never at a mechanism step's expense", () => {
  test("each Mechanism step carries the cited source text, at its own 1-based line", () => {
    const out = renderAgent(agentModel(), { tokenBudget: 40000, snippet: makeSnippetReader(REPO, 1) });
    expect(mechOf(out)).toMatch(/^ +12> const TARGET = callee\(12\);$/m);
    expect(nSteps(out)).toBe(STEPS);
  });

  test("OFF BY DEFAULT — no reader ⇒ the render is byte-identical to the pre-flag one", () => {
    const bare = renderAgent(agentModel(), { tokenBudget: 40000 });
    expect(bare).not.toContain("const TARGET");
    expect(bare).not.toContain("snippets");
    expect(bare).toBe(renderAgent(agentModel(), { tokenBudget: 40000, snippet: undefined }));
  });

  test("when the budget cannot hold them, snippets are DROPPED and SAID — the step count is untouched", () => {
    const bare = renderAgent(agentModel(), { tokenBudget: 40000 });
    // a budget the bare render meets but the snippet-bearing one cannot ⇒ the ladder must give up the snippets,
    // NOT crop the mechanism (the defect that lost a round: the flow cropped while lesser sections printed full).
    // +60 tokens of headroom: enough for the "dropped" notice the section must print, nowhere near the ~200
    // the six snippets cost — so the ONLY way to fit is the snippet rung, which is the rung under test.
    const budget = Math.ceil(bare.length / 4) + 60;
    const out = renderAgent(agentModel(), { tokenBudget: budget, snippet: makeSnippetReader(REPO, 2) });
    expect(out).not.toContain("const TARGET");
    expect(out).toContain("snippets requested but DROPPED");
    // THE ORDER IS THE CONTRACT: every step survives. The generic allowance here is 6, so a ladder that cropped
    // the mechanism before giving up the snippets would render 6 steps — this is what pins the rung order.
    expect(nSteps(out)).toBe(STEPS);
    expect(nSteps(bare)).toBe(STEPS);
  });

  test("when NO rung fits, the requested snippets are kept and the overrun is STATED (dropping them buys no fit)", () => {
    const out = renderAgent(agentModel(), { tokenBudget: 300, snippet: makeSnippetReader(REPO, 2) });
    const bare = renderAgent(agentModel(), { tokenBudget: 300 });
    expect(out).toContain("snippets KEPT although this render EXCEEDS --token-budget 300");
    expect(mechOf(out)).toMatch(/^ +12> const TARGET = callee\(12\);$/m);
    expect(nSteps(out)).toBe(nSteps(bare));   // the mechanism cap is the same with and without them
  });

  test("deterministic: same model + same budget + same N renders byte-identically", () => {
    const r = () => renderAgent(agentModel(), { tokenBudget: 40000, snippet: makeSnippetReader(REPO, 2) });
    expect(r()).toBe(r());
  });
});

// ── DEFAULT-ON (2026-07-30) ─────────────────────────────────────────────────────────────────────────────────
//
// Snippets became default-on for the READING formats because locating without showing only moves the cost:
// measured in bench/grep-vs-seam run 2, the Seam arm spent ~40 of its commands re-reading files Seam had already
// pinpointed. These pin the two halves that make default-on safe rather than merely louder.
describe("the citation cap that makes default-on safe", () => {
  test("the cap counts DISTINCT citations, so a re-render is free", () => {
    // THE BUG THIS PINS: the first cap counted CALLS. The budget-aware agent render re-renders at several crop
    // rungs to find one that fits, so probing consumed the budget and the final pass dropped snippets it had
    // already decided to keep — step 1 shown, steps 2-12 silently lost. Twelve citations of ONE line must cost
    // one unit of budget however many times they are rendered.
    const r = makeSnippetReader(REPO, 2);
    const first = r("src/orders/computeQuote.ts", 12);
    expect(first.length).toBeGreaterThan(0);
    for (let i = 0; i < 75; i++) {
      expect(r("src/orders/computeQuote.ts", 12)).toEqual(first);   // same citation, still emitted
    }
    expect(snippetsTruncated(r)).toBe(false);
  });

  test("DISTINCT citations past the cap are dropped, and the reader SAYS so", () => {
    // Its OWN fixture, long enough to hold more distinct citations than the cap. `computeQuote.ts` has 20 lines,
    // so citations past it hit the EOF guard and — correctly — consume no budget, which made an earlier version
    // of this test unable to reach the cap at all. The rule being pinned is that only a REAL emitted snippet
    // spends budget; an unlocated or past-EOF citation is free.
    // The budget is BYTES of emitted snippet, not a citation count (see MAX_SNIPPET_BYTES): what binds is the
    // transport ceiling, and a 1-line snippet must not cost the same as a 5-line one. So this walks distinct
    // citations until the reader goes quiet, and pins that it (a) lasts a sane while and (b) says when it stops.
    const LINES = 4000;
    writeFileSync(join(REPO, "src/orders/long.ts"),
      Array.from({ length: LINES }, (_, i) => `const l${i + 1} = ${i + 1};`).join("\n"));
    const r = makeSnippetReader(REPO, 2);
    let emitted = 0, bytes = 0;
    for (let line = 3; line < LINES && !snippetsTruncated(r); line += 6) {
      const out = r("src/orders/long.ts", line);
      if (out.length) { emitted++; bytes += out.join("\n").length; }
    }
    expect(snippetsTruncated(r)).toBe(true);              // it stops, and the flag lets the render SAY so
    expect(bytes).toBeLessThanOrEqual(MAX_SNIPPET_BYTES + 500);   // and it stops near the budget, not past it
    // a byte budget buys FAR more citations than the old count of 25 — that is the point of the change
    expect(emitted).toBeGreaterThan(25);
  });
});
