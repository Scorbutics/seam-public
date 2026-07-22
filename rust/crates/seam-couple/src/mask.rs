//! Per-file source masking — the offset/line-preserving scanners the adapters run over instead of raw text,
//! so a key inside a comment (or a comment inside a string) is classified right. `MaskCtx` computes each
//! variant at most once, lazily, and shares it across every adapter in one file scan. Port of util.ts.
//!
//! Char-based (mirrors the TS UTF-16 char scan): for BMP/ASCII source — every real corpus — the code-unit and
//! code-point walks agree; a non-BMP char (surrogate pair in TS) is the one latent edge, unexercised here.

use once_cell::sync::OnceCell;

fn is_quote(c: char) -> bool {
    c == '"' || c == '\'' || c == '`'
}

/// Blank every non-newline char to a space (newlines kept, so line counts stay exact). Port of `blank`.
fn blank(s: &[char]) -> String {
    s.iter().map(|&c| if c == '\n' { '\n' } else { ' ' }).collect()
}

fn slice(chars: &[char], a: usize, b: usize) -> String {
    chars[a..b].iter().collect()
}

/// Replace `//` and `/* */` comment CONTENT with spaces — offset/line-preserving, string-aware (a `//` inside
/// a literal is kept). Port of `maskComments`.
pub fn mask_comments(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut out = String::with_capacity(text.len());
    let (mut i, mut keep_start) = (0usize, 0usize);
    while i < n {
        let c = chars[i];
        if is_quote(c) {
            let q = c;
            i += 1;
            while i < n {
                let d = chars[i];
                if d == '\\' {
                    i += 2;
                    continue;
                }
                i += 1;
                if d == q {
                    break;
                }
            }
            continue;
        }
        if c == '/' && i + 1 < n && chars[i + 1] == '/' {
            out.push_str(&slice(&chars, keep_start, i));
            let start = i;
            while i < n && chars[i] != '\n' {
                i += 1;
            }
            out.push_str(&blank(&chars[start..i]));
            keep_start = i;
            continue;
        }
        if c == '/' && i + 1 < n && chars[i + 1] == '*' {
            out.push_str(&slice(&chars, keep_start, i));
            let start = i;
            i += 2;
            while i < n && !(chars[i] == '*' && i + 1 < n && chars[i + 1] == '/') {
                i += 1;
            }
            if i < n {
                i += 2;
            }
            out.push_str(&blank(&chars[start..i]));
            keep_start = i;
            continue;
        }
        i += 1;
    }
    out.push_str(&slice(&chars, keep_start, n));
    out
}

/// Keep ONLY string-literal content, blank code AND comments (offset/line-preserving). The "key lives in a
/// string literal" scan (raw SQL). Port of `stringLiteralsOnly`.
pub fn string_literals_only(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut out = String::with_capacity(text.len());
    let (mut i, mut blank_start) = (0usize, 0usize);
    macro_rules! flush_blank {
        ($end:expr) => {
            if $end > blank_start {
                out.push_str(&blank(&chars[blank_start..$end]));
            }
        };
    }
    while i < n {
        let c = chars[i];
        if is_quote(c) {
            flush_blank!(i);
            out.push(' ');
            let q = c;
            i += 1;
            let content_start = i;
            while i < n {
                let d = chars[i];
                if d == '\\' {
                    i += 2;
                    continue;
                }
                if d == q {
                    break;
                }
                i += 1;
            }
            out.push_str(&slice(&chars, content_start, i.min(n)));
            if i < n {
                out.push(' ');
                i += 1;
            }
            blank_start = i;
            continue;
        }
        if c == '/' && i + 1 < n && chars[i + 1] == '/' {
            while i < n && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && i + 1 < n && chars[i + 1] == '*' {
            i += 2;
            while i < n && !(chars[i] == '*' && i + 1 < n && chars[i + 1] == '/') {
                i += 1;
            }
            if i < n {
                i += 2;
            }
            continue;
        }
        i += 1;
    }
    flush_blank!(n);
    out
}

/// A file's mask context — each variant computed at most once. Port of `MaskCtx` + `makeMaskCtx`.
pub struct MaskCtx {
    text: String,
    comments: OnceCell<String>,
    strings: OnceCell<String>,
}

impl MaskCtx {
    pub fn new(text: &str) -> Self {
        Self { text: text.to_string(), comments: OnceCell::new(), strings: OnceCell::new() }
    }
    /// Source with comment content blanked (string-aware).
    pub fn comments(&self) -> &str {
        self.comments.get_or_init(|| mask_comments(&self.text))
    }
    /// Only string-literal content kept, everything else blanked.
    pub fn strings(&self) -> &str {
        self.strings.get_or_init(|| string_literals_only(&self.text))
    }
}
