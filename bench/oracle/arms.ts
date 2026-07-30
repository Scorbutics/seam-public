// THE ARMS — three ways to answer "how many places call this, and where", each timed.
//
// WHY AN LSP ARM EXISTS, and why it is the most important one. `grep` alone is a straw man for a TypeScript
// monorepo: any competent agent can reach the compiler, and a result that only beats naked `rg` dies to one
// sentence from a skeptic. So the honest baseline is the TypeScript LANGUAGE SERVICE — `findReferences`, the
// same machinery "Find All References" in an editor runs on.
//
// This arm is expected to be very accurate. That is the point. If it is, then on TS call-site questions Seam's
// value is NOT capability — it is cost, and reach into questions the language service has no concept of
// (cross-language hops, data coupling). Knowing which of those it is decides where the work goes next, and it
// cannot be known without building the arm that might win.
//
// Every arm returns the SAME two claims so they are comparable at both grains the harness scores:
//   callSites — how many call expressions (the figure `--query contract` prints, and the oracle proves)
//   files     — which files contain them
// plus `ms`, because when two arms are equally correct the cost is the entire decision.
import { writeFileSync } from "node:fs";
import { sh } from "./probe.ts";

export type Answer = {
  arm: string;
  callSites: number | null;   // null = the arm CANNOT express this claim; scoring it as 0 would invent a claim
  files: Set<string>;
  ms: number;
  note?: string;
};

const timed = <T>(f: () => T): [T, number] => { const t = Date.now(); const v = f(); return [v, Date.now() - t]; };

// ── ARM: seam ───────────────────────────────────────────────────────────────────────────────────────────────
const SEAM = "cd /home/scorbutics/seam-phase0/ts && bun src/cli/decompose.ts";
const contractCache = new Map<string, string>();
// The FIRST, uncached cost per module file, kept separately from the cache. Without this the reported cost was
// literally `0ms`: the target-selection pass calls the contract once per file to find out which exports are
// consumed, so by the time the timing loop ran every file was already warm and every measurement was a cache
// hit. Reporting 0ms for the tool under test, in a harness built to compare costs, is the flattering kind of
// artefact — the one that survives review because nobody questions their own good news.
const contractMs = new Map<string, number>();
export const seamFirstCallMs = (repo: string, file: string): number => contractMs.get(`${repo}::${file}`) ?? 0;

export function seamContract(repo: string, file: string): { out: string; ms: number } {
  const key = `${repo}::${file}`;
  if (contractCache.has(key)) return { out: contractCache.get(key)!, ms: 0 };
  const [out, ms] = timed(() => sh(`${SEAM} --scan --repo ${repo} --query contract --center ${file} --format llm-context`, "/"));
  // A BROKEN TOOL IS NOT A TOOL MAKING NO CLAIM. This distinction cost a whole run: `git checkout` had deleted
  // ts/node_modules, every invocation died with "grammars unavailable" — the engine failing LOUDLY, as designed
  // — and the caller read the absence of a claim as null for all 200 candidates, then printed "EXACT 0/0" and
  // exited 0. A harness that reports success when the thing under test never ran is worse than no harness.
  if (/^error:|grammars unavailable|could not be built/m.test(out)) {
    console.error(`\nABORT: the seam CLI is not answering — the engine, not the benchmark, is broken:\n  ${out.split("\n").find((l) => l.trim()) ?? "(no output)"}`);
    process.exit(3);
  }
  contractCache.set(key, out);
  contractMs.set(key, ms);
  return { out, ms };
}

export function armSeam(repo: string, file: string, name: string): Answer {
  const { out, ms } = seamContract(repo, file);
  const block = new RegExp(`^- ${name}\\b[^\\n]*\\n(?:\\s+observed: (\\d+) call sites?[^\\n]*\\n)?((?:\\s+(?:verify|←)[^\\n]*\\n)*)`, "m").exec(out);
  if (!block) return { arm: "seam", callSites: null, files: new Set(), ms, note: "not listed as a consumed export" };
  const files = new Set<string>();
  for (const m of block[2].matchAll(/←\s+\S+\s+\((.+?)\)/g)) files.add(m[1]);
  return { arm: "seam", callSites: block[1] === undefined ? null : Number(block[1]), files, ms };
}

// ── ARM: grep ───────────────────────────────────────────────────────────────────────────────────────────────
export function armGrep(repo: string, file: string, name: string): Answer {
  const [out, ms] = timed(() => sh(`rg -c '\\b${name}\\(' -g '!node_modules' -g '*.ts' -g '*.tsx' . || true`, repo));
  const files = new Set<string>();
  let total = 0;
  for (const line of out.split("\n").filter(Boolean)) {
    const i = line.lastIndexOf(":");
    if (i < 0) continue;
    const f = line.slice(0, i).replace(/^\.\//, "");
    if (f === file) continue;                      // the definition's own file is not a consumer
    files.add(f);
    total += Number(line.slice(i + 1));
  }
  // grep counts LINES containing a textual match, which is neither call sites nor files: two calls on one line
  // count once, and a mention in a comment or a same-named local counts as a call. Reported as-is; the score
  // shows how far that is from truth, which is the whole reason the arm is here.
  return { arm: "grep", callSites: total, files, ms, note: "line-grained, no resolution" };
}

// ── ARM: lsp (TypeScript language service) ──────────────────────────────────────────────────────────────────
//
// Run OUT OF PROCESS, on purpose. The language service needs the repo's own `typescript` (5.7 on private-app) and its
// own module resolution; importing it into this process would resolve against seam's node_modules and silently
// analyse a different program than the one `tsc` compiles — the arm would then be measured against a judge it
// disagrees with for reasons that have nothing to do with references.
//
// It answers the CALL-SITE question, not the reference question: a reference whose parent is a CallExpression
// with the identifier in callee position is a call; an import specifier, a type position, or the function passed
// as a value is not. Counting all references would inflate the arm against the oracle for a question it was
// never asked, which would be the same grain error as the usage-site/call-site collision.
const LSP_SCRIPT = String.raw`
const path = require("path");
const [, , repoArg, tsconfigRel, targetsJson] = process.argv;
const repo = path.resolve(repoArg);
// The REPO's OWN typescript, resolved absolutely. A relative require() resolves against THIS script's
// directory (/tmp), not the repo, and the MODULE_NOT_FOUND was then reported as the arm "making no claim".
const ts = require(path.resolve(repo, "node_modules/typescript"));
const cfgPath = path.join(repo, tsconfigRel);
const cfg = ts.getParsedCommandLineOfConfigFile(cfgPath, {}, {
  ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, " ")); },
});
if (!cfg) { console.log(JSON.stringify({ error: "could not parse tsconfig" })); process.exit(0); }

const files = cfg.fileNames;
const versions = new Map(files.map((f) => [f, "1"]));
const serviceHost = {
  getScriptFileNames: () => files,
  getScriptVersion: (f) => versions.get(f) ?? "1",
  getScriptSnapshot: (f) => { const t = ts.sys.readFile(f); return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t); },
  getCurrentDirectory: () => repo,
  getCompilationSettings: () => cfg.options,
  getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
  realpath: ts.sys.realpath,
};
const svc = ts.createLanguageService(serviceHost, ts.createDocumentRegistry());
// ONE PROGRAM, MANY QUESTIONS. Building the program is ~3.5s on private-app and dominates a single query, so asking
// per process would report a cost no real user pays: an editor and an agent-with-an-LSP both keep it warm. The
// build is timed separately and the per-symbol cost is measured after it, which is the honest cost model.
const buildMs = Date.now();
const program = svc.getProgram();
process.stderr.write("BUILD_MS " + (Date.now() - buildMs) + "\n");

for (const { file: targetFile, symbol } of JSON.parse(require("fs").readFileSync(targetsJson, "utf-8"))) {
  const t0 = Date.now();
  const emit = (o) => console.log(JSON.stringify({ file: targetFile, symbol, ms: Date.now() - t0, ...o }));
  const absTarget = path.resolve(repo, targetFile);
  const sf = program.getSourceFile(absTarget);
  if (!sf) { emit({ error: "target file not in the program" }); continue; }

  // the declaration's own name node — where "find all references" is invoked from
  let pos = -1;
  const visit = (n) => {
    if (pos >= 0) return;
    if (ts.isFunctionDeclaration(n) && n.name && n.name.text === symbol) { pos = n.name.getStart(sf); return; }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (pos < 0) { emit({ error: "declaration not found" }); continue; }

  const refs = svc.getReferencesAtPosition(absTarget, pos) || [];
  const callFiles = new Set();
  let calls = 0, other = 0;
  for (const r of refs) {
    const rf = program.getSourceFile(r.fileName);
    if (!rf) continue;
    const rel = path.relative(repo, r.fileName);
    if (rel === targetFile) continue;                 // the definition's own file is not a consumer
    // walk down to the innermost node covering the reference, then ask what its parent does with it
    let hit = rf;
    const step = (n) => {
      if (r.textSpan.start >= n.getStart(rf) && r.textSpan.start + r.textSpan.length <= n.getEnd()) {
        hit = n; ts.forEachChild(n, step);
      }
    };
    ts.forEachChild(rf, step);
    const parent = hit && hit.parent;
    if (parent && ts.isCallExpression(parent) && parent.expression === hit) { calls++; callFiles.add(rel); }
    else other++;
  }
  emit({ calls, other, files: [...callFiles] });
}
`;

let lspScriptPath: string | null = null;
function lspScript(): string {
  if (!lspScriptPath) {
    lspScriptPath = "/tmp/seam-bench-lsp-refs.cjs";
    writeFileSync(lspScriptPath, LSP_SCRIPT);
  }
  return lspScriptPath;
}

/** One program build, one answer per target. `buildMs` is reported separately from the per-symbol cost. */
export function armLspBatch(
  repo: string,
  tsconfig: string,
  targets: { file: string; name: string }[],
): { answers: Map<string, Answer>; buildMs: number } {
  const spec = "/tmp/seam-bench-lsp-targets.json";
  writeFileSync(spec, JSON.stringify(targets.map((t) => ({ file: t.file, symbol: t.name }))));
  const raw = sh(`node ${lspScript()} ${repo} ${tsconfig} ${spec} 2>&1`, repo, 1_800_000);
  const lines = raw.split("\n").filter(Boolean);
  const buildMs = Number(/BUILD_MS (\d+)/.exec(raw)?.[1] ?? 0);
  const answers = new Map<string, Answer>();
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    let p: any;
    try { p = JSON.parse(line); } catch { continue; }
    answers.set(`${p.file}#${p.symbol}`, p.error
      ? { arm: "lsp", callSites: null, files: new Set(), ms: p.ms ?? 0, note: p.error }
      : { arm: "lsp", callSites: p.calls, files: new Set<string>(p.files ?? []), ms: p.ms ?? 0, note: `${p.other} non-call reference(s) excluded` });
  }
  // A BROKEN ARM IS NOT AN ARM MAKING NO CLAIM — the same distinction the seam arm above learned the hard way,
  // and it bit immediately here: a relative require() of typescript threw MODULE_NOT_FOUND, and returning null
  // reported that as "the language service cannot express a call-site count". It can; the harness was broken.
  if (!answers.size) {
    console.error(`\nABORT: the lsp arm answered nothing — the harness, not the tool, is broken:\n${raw.slice(0, 800)}`);
    process.exit(3);
  }
  return { answers, buildMs };
}
