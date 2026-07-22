//! A `(?<![\w$])` NEGATIVE-LOOKBEHIND emulation — the Rust `regex` crate has no lookaround, so we replicate JS
//! global-regex semantics exactly: try each position left-to-right; on a match whose preceding char IS a word
//! char (`[\w$]`), the lookbehind fails and JS advances by ONE char (it does NOT consume the body), so we resume
//! the search one char past the match START, not its end. This is byte-identical to the JS lookbehind, not an
//! approximation.

use regex::{Captures, Regex};

fn word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

/// All captures of `re` in `text` for which the char immediately before the match is NOT a word char — i.e. as
/// if `re` were prefixed with `(?<![\w$])`.
pub fn captures_not_word_before<'t>(re: &Regex, text: &'t str) -> Vec<Captures<'t>> {
    let mut out = Vec::new();
    let mut cursor = 0;
    while cursor <= text.len() {
        let Some(caps) = re.captures_at(text, cursor) else { break };
        let m = caps.get(0).unwrap();
        let start = m.start();
        let ok = start == 0 || !text[..start].chars().next_back().is_some_and(word_char);
        if ok {
            let end = m.end();
            cursor = if end > start { end } else { start + text[start..].chars().next().map_or(1, char::len_utf8) };
            out.push(caps);
        } else {
            // lookbehind failed → JS advances ONE char from the match start
            cursor = start + text[start..].chars().next().map_or(1, char::len_utf8);
        }
    }
    out
}
