// CLASS-CALL-CANDIDATES parity — the `--emit-candidates` hand-off. The extension resolves each candidate
// against a language server and returns the survivors as `--attribution`, so this list is the INPUT to the
// verified path (rust/parity/ripple.ts covers the output side).
//
// It is receiver-agnostic by design — it OVER-collects, and the LSP filters. That makes the COLUMN load-
// bearing: a candidate is a cursor position, so an off-by-one puts the language server on the wrong token and
// the real call is silently dropped from the attribution. Columns are UTF-16 code units, which is why the
// fixture below puts a non-ASCII string EARLIER on a call's line — byte columns pass every ASCII test and
// fail exactly there.
//
//   bun rust/parity/candidates.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { class_call_candidates } from "../../ts/src/codebase/scan/index.js";
const require = createRequire(import.meta.url);
const addon = require("../seam_core.node");

const repo = mkdtempSync(join(tmpdir(), "seam-cand-"));
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
w("package.json", `{ "name": "cand", "version": "1.0.0" }\n`);
w("src/repo.ts", `export class Repo {\n  save(id: string) { return id; }\n  load(id: string) { return id; }\n  private hidden() { return 0; }\n}\n`);
w("src/use.ts", `import { Repo } from "./repo.js";\nexport function run(id: string) {\n  const r = new Repo();\n  r.save(id);\n  return r.load(id);\n}\n`);
// NON-ASCII EARLIER ON THE LINE — the UTF-16-vs-bytes case. "café ▲" is 6 code units but 9 bytes, so a byte
// column reports the `save` token 3 places to the right of where the editor puts it.
w("src/unicode.ts", `import { Repo } from "./repo.js";\nexport function u(id: string) {\n  const r = new Repo();\n  return { label: "café ▲", v: r.save(id) };\n}\n`);
w("src/nocall.ts", `import { Repo } from "./repo.js";\nexport const t = typeof Repo;\n`);
// a same-named method on an UNRELATED class — receiver-agnostic means this IS collected (the LSP culls it)
w("src/other.ts", `import { Repo } from "./repo.js";\nclass Mimic { save(id: string) { return id; } }\nexport function m(id: string) { new Mimic().save(id); return new Repo().load(id); }\n`);
w("src/Java.java", `package a;\npublic class Java { }\n`);

let fails = 0;
const eq = (label: string, ts: unknown, rs: unknown) => {
  const a = JSON.stringify(ts, null, 1), b = JSON.stringify(rs, null, 1);
  if (a === b) { console.log(`  ok   ${label}`); return; }
  fails++; console.log(`  FAIL ${label}\n    ts: ${a}\n    rs: ${b}`);
};

for (const [file, cls] of [["src/repo.ts", "Repo"], ["src/repo.ts", "NotAClass"], ["src/Java.java", "Java"]] as const) {
  const ts = await class_call_candidates(repo, file, cls);
  const rs = addon.classCallCandidates(repo, file, cls);
  eq(`${file}#${cls}`, ts, rs.map((c: any) => ({ file: c.file, line: c.line, col: c.col, method: c.method })));
}
// The column claim, asserted DIRECTLY — an equality that is wrong on both sides would still "pass" above.
{
  const rs = addon.classCallCandidates(repo, "src/repo.ts", "Repo") as any[];
  const hit = rs.find((c) => c.file === "src/unicode.ts" && c.method === "save");
  const line = `  return { label: "café ▲", v: r.save(id) };`;
  eq("utf-16 column lands on the method token", line.slice(hit.col, hit.col + 4), "save");
}

rmSync(repo, { recursive: true, force: true });
console.log(fails ? `\n${fails} MISMATCH(ES)` : "\nall identical");
process.exit(fails ? 1 : 0);
