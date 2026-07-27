//! `from x import a, b` / `import a, b` → the names a module BINDS. Port of python `parse_imports`/`imports`.

use crate::types::ImportRef;
use once_cell::sync::Lazy;
use regex::Regex;

static FROM_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)$").unwrap());
static IMPORT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\s*import\s+(.+)$").unwrap());

/// The imported names with their line/column. `source: None` — see the module note: Python resolution is not
/// path-derivable, so the ref names the BINDING and leaves the target to the LSP.
pub fn imports(text: &str) -> Vec<ImportRef> {
    let mut out = Vec::new();
    for (i, line) in text.split('\n').enumerate() {
        if let Some(c) = FROM_RE.captures(line) {
            let g2 = c.get(2).unwrap();
            for seg in g2.as_str().split('#').next().unwrap_or("").split(',') {
                // `a as b` binds `a` at the boundary (the TS side takes the ORIGINAL name, not the alias)
                let orig = seg.trim().trim_matches(['(', ')']).split(" as ").next().unwrap_or("").trim();
                if orig.is_empty() || orig == "*" {
                    continue;
                }
                let col = line[g2.start()..].find(orig).map(|p| p + g2.start()).unwrap_or(g2.start());
                out.push(ImportRef { name: orig.to_string(), local: orig.to_string(), line: i as u32, col: col as u32, source: None, reexport: false });
            }
            continue;
        }
        if let Some(c) = IMPORT_RE.captures(line) {
            if line.trim_start().starts_with("from") {
                continue; // already handled above; a `from …` line also matches the bare-import shape
            }
            for seg in c[1].split('#').next().unwrap_or("").split(',') {
                // `import a.b.c` binds the ROOT package `a`
                let orig = seg.trim().split(" as ").next().unwrap_or("").trim().split('.').next().unwrap_or("").trim();
                if orig.is_empty() {
                    continue;
                }
                let col = line.find(orig).unwrap_or(0);
                out.push(ImportRef { name: orig.to_string(), local: orig.to_string(), line: i as u32, col: col as u32, source: None, reexport: false });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_import_binds_the_original_names_not_the_aliases() {
        let r = imports("from .models import User, Order as O\n");
        assert_eq!(r.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), vec!["User", "Order"]);
        assert!(r.iter().all(|i| i.source.is_none()), "python resolution is not path-derivable — see the module note");
    }

    #[test]
    fn a_dotted_import_binds_its_root_package() {
        assert_eq!(imports("import os.path\n")[0].name, "os");
    }

    #[test]
    fn a_star_import_binds_nothing_nameable() {
        assert!(imports("from x import *\n").is_empty());
    }

    #[test]
    fn a_comment_after_the_import_is_not_a_name() {
        let r = imports("from a import b  # c, d\n");
        assert_eq!(r.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), vec!["b"]);
    }
}
