//! JSONC loading (JSON + comments + trailing commas) — for tsconfig.json / jsconfig.json. Port of
//! `_strip_jsonc` + `_load_jsonc` (typescript/resolve.ts).

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

static TRAILING_COMMA: Lazy<Regex> = Lazy::new(|| Regex::new(r",(\s*[}\]])").unwrap());

pub fn load(path: &str) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    let stripped = strip_comments(&text);
    let cleaned = TRAILING_COMMA.replace_all(&stripped, "$1");
    serde_json::from_str(&cleaned).ok()
}

// Strip `//` and `/* */` comments, STRING-AWARE (tsconfig path globs contain `/* */`). Char-based to match
// TS's per-character scan and preserve non-ASCII content.
fn strip_comments(text: &str) -> String {
    let c: Vec<char> = text.chars().collect();
    let n = c.len();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut in_str = false;
    while i < n {
        let ch = c[i];
        if in_str {
            out.push(ch);
            if ch == '\\' && i + 1 < n {
                out.push(c[i + 1]);
                i += 2;
                continue;
            }
            if ch == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if ch == '"' {
            in_str = true;
            out.push('"');
            i += 1;
            continue;
        }
        if ch == '/' && i + 1 < n && c[i + 1] == '/' {
            while i < n && c[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if ch == '/' && i + 1 < n && c[i + 1] == '*' {
            i += 2;
            while i + 1 < n && !(c[i] == '*' && c[i + 1] == '/') {
                i += 1;
            }
            i += 2;
            continue;
        }
        out.push(ch);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_comments_and_trailing_commas() {
        let src = r#"{
            // a line comment
            "compilerOptions": { "paths": { "@x/*": ["src/*"], }, }, /* block */
            "url": "http://not-a-comment", // keep the // inside the string
        }"#;
        let stripped = strip_comments(src);
        let cleaned = TRAILING_COMMA.replace_all(&stripped, "$1");
        let v: serde_json::Value = serde_json::from_str(&cleaned).unwrap();
        assert_eq!(v["compilerOptions"]["paths"]["@x/*"][0], "src/*");
        assert_eq!(v["url"], "http://not-a-comment");
    }
}
