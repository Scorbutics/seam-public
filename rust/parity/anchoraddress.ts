// ANCHOR-ADDRESS parity — `resolve_anchor_address` TS vs the Rust core.
//
// This guard is the reason the port has to be exact. When a caller addresses `<file>#<symbol>` and the symbol
// is not declared there, every footprint builder falls back to a bare node and asks who imports THAT name FROM
// THAT FILE. Nobody does, so the answer renders as an authoritative "nothing calls this" — telling someone
// their live code is dead. A DEFAULT export triggers it routinely: importers bind it under a name of their own
// choosing, so the name at every call site is not a symbol of the defining file.
//
// So the comparison covers all three verdicts: DECLARED (a true empty answer is still reported), NOT DECLARED
// (an addressing error, with the default-export local as the missing piece), and UNPARSEABLE (null on both
// sides — absence of evidence must not become evidence of a bad address).
//
//   bun rust/parity/anchoraddress.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { resolve_anchor_address } from "../../ts/src/codebase/scan/anchor_address.js";
const require = createRequire(import.meta.url);
const addon = require("../seam_core.node");

const repo = mkdtempSync(join(tmpdir(), "seam-addr-"));
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
w("package.json", `{ "name": "addr", "version": "1.0.0" }\n`);
// the cal.com shape: no `handleCancelBooking` declaration anywhere, `export default handler`
w("src/handleCancelBooking.ts", `async function handler(req: Request) { return validate(req); }\nfunction validate(r: Request) { return r; }\nexport default handler;\n`);
w("src/named.ts", `export function alpha() { return 1; }\nexport const beta = () => 2;\nfunction gamma() { return 3; }\nexport { gamma };\n`);
w("src/cls.ts", `export class Repo {\n  save(id: string) { return id; }\n}\nexport default Repo;\n`);
w("README.md", `# not a language the engine parses\n`);

const CASES: [string, string][] = [
  ["src/handleCancelBooking.ts", "handleCancelBooking"],  // NOT declared — the failure this guard exists for
  ["src/handleCancelBooking.ts", "handler"],              // declared, and the default-export local
  ["src/handleCancelBooking.ts", "validate"],             // declared but not exported
  ["src/named.ts", "alpha"], ["src/named.ts", "beta"], ["src/named.ts", "gamma"], ["src/named.ts", "missing"],
  ["src/cls.ts", "Repo"], ["src/cls.ts", "save"],
  ["README.md", "anything"],                              // unparseable → null on BOTH sides
  ["src/nope.ts", "ghost"],                               // unreadable → null on BOTH sides
];

const norm = (r: any) => r === null || r === undefined ? "null" : JSON.stringify({
  declared: r.declared, defaultExportLocal: r.defaultExportLocal ?? r.default_export_local ?? null,
  candidates: r.candidates,
});

let ok = 0; const bad: string[] = [];
for (const [file, sym] of CASES) {
  const ts = norm(await resolve_anchor_address(repo, file, sym));
  const rs = norm(addon.resolveAnchorAddress(repo, file, sym));
  if (ts === rs) { ok++; continue; }
  bad.push(`✗ ${file}#${sym}\n    ts:   ${ts}\n    rust: ${rs}`);
}
rmSync(repo, { recursive: true, force: true });

console.log(`\nanchor-address parity: ${ok}/${CASES.length} byte-identical`);
for (const b of bad) console.log(b);
process.exit(bad.length ? 1 : 0);
