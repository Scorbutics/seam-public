// SCAN phase — NAME-GROUNDED recall. The import/namespace-based consumer scan is the VERIFIED floor: it
// resolves a caller only when the symbol's module actually resolves to the anchor. That floor is strong for
// TS/Java but thin-to-absent for languages where callers don't import a symbol by name — Ruby constants are
// global after a file `require` (`EpsaStream.new` with no per-symbol import), and C/C++ have no import parser
// at all (`Init_Color()` after an `#include`). There, callers still use the EXACT symbol name, so a
// name-grounded AST scan recovers them.
//
// This is NOT a semantic proxy: the symbol name is a deterministic token, and tree-sitter identifier nodes are
// code positions (comments/strings are other node kinds, excluded for free). The imprecision is real but
// bounded — a same-named symbol elsewhere can match — so these are RECALLED (unverified), kept SEPARATE from
// the verified members, never promoted to the resolved floor. Port of `scan/up/name_consumers.ts`.
use seam_fs::{normpath, stem};
use seam_lang::{ast, Ctx};
use std::collections::HashSet;

/// A name-grounded consumer: a unit (function/method/module) that USES the symbol name in a code position.
/// `call` = the name appears in a call/instantiation position (stronger), else a bare reference.
pub struct NameConsumer {
    pub file: String,
    pub symbol: String,
    pub kind: String,
    pub enclosing: String,
    pub line: usize,
    pub call: bool,
}

// Name-leaf node kinds across grammars: plain identifiers (TS/Java/C/C++ functions), `constant` (Ruby
// `EpsaStream` — NOT an identifier in the Ruby grammar, the reason a call-only scan missed it), and the
// typed/qualified identifier variants. A scoped name (`cgss::normalize_long`, `Foo::Bar`) nests these leaves,
// so collecting leaves catches the symbol on either side.
fn is_name_leaf(k: &str) -> bool {
    k.contains("identifier") || k == "constant"
}

pub fn scan_name_consumers(repo: &str, anchor_file: &str, symbol: &str) -> Vec<NameConsumer> {
    let anchor_norm = normpath(anchor_file);
    let mut out: Vec<NameConsumer> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    // The TS walk is `walkFiles(repo, SKIP_DIRS, endsWithSourceExt)` with NO size cap — deliberately not
    // `candidate_source_files`, which additionally drops oversized-for-anchor files a name scan still reads.
    for rel in seam_fs::source_files(repo, |r| seam_couple::ground::floor::ends_with_source_ext(r)) {
        if normpath(&rel) == anchor_norm {
            continue;
        }
        let Some((text, grammar)) = crate::util::read(repo, &rel) else { continue };
        if !text.contains(symbol) {
            continue; // cheap prefilter — skip the parse when absent
        }
        let Some(ctx) = Ctx::parse(&text, &grammar) else { continue };
        let units = ast::named_units(&ctx);
        let call_lines: HashSet<usize> = ast::call_lines(&ctx, symbol).into_iter().collect(); // call-position occurrences (stronger signal)
        // every name-leaf occurrence of `symbol` in code (comments/strings are other node kinds, excluded).
        let mut line_set: HashSet<usize> = HashSet::new();
        for n in ctx.collect(ctx.root(), is_name_leaf) {
            if ctx.text(n) == symbol {
                line_set.insert(ctx.span(n).0);
            }
        }
        let mut lines: Vec<usize> = line_set.into_iter().collect();
        lines.sort_unstable();
        for ln in lines {
            let enc = ast::enclosing(&units, ln);
            let name = enc.map(|u| u.name.clone()).unwrap_or_else(|| stem(&rel));
            let start = enc.map(|u| u.start).unwrap_or(ln);
            let key = format!("{rel}#{name}#{start}");
            if seen.contains(&key) {
                continue;
            }
            seen.insert(key);
            let cls = if enc.is_some() {
                units
                    .iter()
                    .find(|u| u.kind == "class" && u.start <= start && start <= u.end)
                    .map(|u| u.name.clone())
                    .unwrap_or_default()
            } else {
                String::new()
            };
            out.push(NameConsumer {
                file: rel.clone(),
                symbol: name,
                kind: enc.map(|u| u.kind.clone()).unwrap_or_else(|| "module".to_string()),
                enclosing: cls,
                line: start,
                call: call_lines.contains(&ln),
            });
        }
    }
    out
}
