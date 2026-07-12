// SCAN phase — NAME-GROUNDED recall. The import/namespace-based consumer scan (consumers.ts) is the
// VERIFIED floor: it resolves a caller only when the symbol's module actually resolves to the anchor.
// That floor is strong for TS/Java but thin-to-absent for languages where callers don't import a symbol
// by name — Ruby constants are global after a file `require` (`EpsaStream.new` with no per-symbol import),
// and C/C++ have no import parser at all (`Init_Color()` after an `#include`). There, callers still use
// the EXACT symbol name, so a name-grounded AST scan recovers them.
//
// This is NOT a semantic proxy: the symbol name is a deterministic token, and tree-sitter identifier
// nodes are code positions (comments/strings are other node kinds, excluded for free). The imprecision
// is real but bounded — a same-named symbol elsewhere can match — so these are RECALLED (unverified),
// kept SEPARATE from the verified members, never promoted to the resolved floor.
import { available, makeCtx } from "../../atoms.js";
import { walkFiles, normpath } from "../../../core/resolve/walk.js";
import { SKIP_DIRS, endsWithSourceExt } from "../../../core/resolve/languages/index.js";
import { expanduser, stem, _read, _named_units, _enclosing, _call_lines } from "../ast_units.js";

// A name-grounded consumer: a unit (function/method/module) that USES the symbol name in a code
// position. `call` = the name appears in a call/instantiation position (stronger), else a bare reference.
export interface NameConsumer { file: string; symbol: string; kind: string; enclosing: string; line: number; call: boolean }

// Name-leaf node kinds across grammars: plain identifiers (TS/Java/C/C++ functions), `constant` (Ruby
// `EpsaStream` — NOT an identifier in the Ruby grammar, the reason _ref_lines alone missed it), and the
// typed/qualified identifier variants. A scoped name (`cgss::normalize_long`, `Foo::Bar`) nests these
// leaves, so collecting leaves catches the symbol on either side.
const _NAME_LEAF = (k: string): boolean => k.includes("identifier") || k === "constant";

export async function scan_name_consumers(repo: string, anchorFile: string, symbol: string): Promise<NameConsumer[]> {
  repo = expanduser(repo);
  if (!available()) return [];
  const anchorNorm = normpath(anchorFile);
  const out: NameConsumer[] = [];
  const seen = new Set<string>();
  for (const { rel, text } of walkFiles(repo, SKIP_DIRS, endsWithSourceExt)) {
    if (normpath(rel) === anchorNorm) continue;
    if (!text.includes(symbol)) continue;                 // cheap prefilter — skip the parse when absent
    const rd = _read(repo, rel);
    if (!rd) continue;
    const ctx = await makeCtx(rd[0], rd[1]);
    if (!ctx) continue;
    const units = _named_units(ctx);
    const callLines = new Set(_call_lines(ctx, symbol));   // call-position occurrences (stronger signal)
    // every name-leaf occurrence of `symbol` in code (comments/strings are other node kinds, excluded).
    const lineSet = new Set<number>();
    for (const n of ctx.collect(ctx.root, _NAME_LEAF)) if (ctx.text(n) === symbol) lineSet.add(ctx.span(n)[0]);
    const lines = [...lineSet].sort((a, b) => a - b);
    for (const ln of lines) {
      const enc = _enclosing(units, ln);
      const name = enc ? enc[0] : stem(rel);
      const start = enc ? enc[2] : ln;
      const key = `${rel}#${name}#${start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cls = enc ? (units.find((u) => u[1] === "class" && u[2] <= start && start <= u[3])?.[0] ?? "") : "";
      out.push({ file: rel, symbol: name, kind: enc ? enc[1] : "module", enclosing: cls, line: start, call: callLines.has(ln) });
    }
  }
  return out;
}
