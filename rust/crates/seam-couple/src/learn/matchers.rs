//! LEARN/CACHE replay — the persisted `.seam/key-adapters.json` matcher store the flywheel LEARNED, replayed
//! deterministically (warm = 0 LLM). `load_matchers` reads the store (repo then shared, deduped by executable
//! identity); `run_matcher` executes ONE rule over a file → the keys it detects (regex over comment-masked
//! text, no tree-sitter for these shapes). Port of key_store.loadMatchers + key_ir.runMatcher. The framework
//! SEMANTICS a rule encodes are learned data, so this stays framework-agnostic (it just replays a rule shape).

use crate::key_ir::{line_of, plausible_key_value};
use crate::mask::mask_comments;
use crate::regex_util::captures_not_word_before;
use crate::types::KeyHit;
use crate::verb_class::write_op;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;
use std::collections::HashSet;

/// A learned key-adapter rule — the persisted shapes the flywheel synthesises. Port of `KeyMatcher`. Extra JSON
/// fields (name/description) are ignored.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "via", rename_all = "lowercase")]
pub enum KeyMatcher {
    Call {
        token: String,
        #[serde(rename = "argIndex")]
        arg_index: i64,
        #[serde(default)]
        strip: Option<String>,
        kind: String,
        role: String,
    },
    Assign { token: String, kind: String, role: String },
    Method { kind: String, role: String },
    Attr {
        directive: String,
        #[serde(rename = "keyFrom")]
        key_from: String,
        kind: String,
        role: String,
    },
    Annotation {
        annotation: String,
        #[serde(default)]
        element: Option<String>,
        kind: String,
        role: String,
    },
    Member { token: String, verbs: Vec<String>, kind: String, role: String },
    Repository { token: String, verbs: Vec<String>, kind: String, role: String },
    Channel { token: String, verbs: Vec<String>, kind: String, role: String },
    Handle { token: String, verbs: Vec<String>, kind: String, role: String },
}

#[derive(Deserialize)]
struct StoreJson {
    schema: Option<u32>,
    #[serde(default)]
    rules: Vec<serde_json::Value>,
}

impl KeyMatcher {
    /// Stable identity for dedup — the shape + distinguishing fields. Port of `matcherKey`.
    pub fn key(&self) -> String {
        match self {
            KeyMatcher::Call { token, arg_index, strip, kind, role } => format!("call:{kind}:{role}:{token}:{arg_index}:{}", strip.as_deref().unwrap_or("")),
            KeyMatcher::Assign { token, kind, role } => format!("assign:{kind}:{role}:{token}"),
            KeyMatcher::Method { kind, role } => format!("method:{kind}:{role}"),
            KeyMatcher::Attr { directive, key_from, kind, role } => format!("attr:{kind}:{role}:{directive}:{key_from}"),
            KeyMatcher::Annotation { annotation, element, kind, role } => format!("annotation:{kind}:{role}:{annotation}:{}", element.as_deref().unwrap_or("")),
            KeyMatcher::Member { token, verbs, kind, role } => format!("member:{kind}:{role}:{token}:{}", sorted_verbs(verbs)),
            KeyMatcher::Repository { token, verbs, kind, role } => format!("repository:{kind}:{role}:{token}:{}", sorted_verbs(verbs)),
            KeyMatcher::Channel { token, verbs, kind, role } => format!("channel:{kind}:{role}:{token}:{}", sorted_verbs(verbs)),
            KeyMatcher::Handle { token, verbs, kind, role } => format!("handle:{kind}:{role}:{token}:{}", sorted_verbs(verbs)),
        }
    }

    /// The required literal for the cheap `text.contains` prefilter. Port of `matcherLiteral`.
    fn literal(&self) -> Option<String> {
        match self {
            KeyMatcher::Call { token, .. } | KeyMatcher::Assign { token, .. } | KeyMatcher::Member { token, .. } | KeyMatcher::Repository { token, .. } | KeyMatcher::Channel { token, .. } => Some(token.clone()),
            KeyMatcher::Handle { token, .. } => Some(token.split('.').next().unwrap_or(token).to_string()),
            KeyMatcher::Attr { directive, .. } => Some(directive.clone()),
            KeyMatcher::Annotation { annotation, .. } => Some(annotation.clone()),
            KeyMatcher::Method { .. } => None,
        }
    }
}

fn sorted_verbs(verbs: &[String]) -> String {
    let mut v = verbs.to_vec();
    v.sort();
    v.join(",")
}

fn produces(role: &str) -> bool {
    role == "produces"
}

/// Load the persisted rules from a `.seam` dir (main store; schema 3). Legacy schema-1 `key-matchers.json` is
/// folded in (deduped). Returns rules in file order, legacy appended. Port of `_loadStore().rules`.
fn load_store_rules(dir: &str) -> Vec<KeyMatcher> {
    let mut rules: Vec<KeyMatcher> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    if let Ok(txt) = std::fs::read_to_string(format!("{dir}/key-adapters.json")) {
        if let Ok(store) = serde_json::from_str::<StoreJson>(&txt) {
            if store.schema == Some(3) {
                for v in &store.rules {
                    if let Ok(m) = serde_json::from_value::<KeyMatcher>(v.clone()) {
                        seen.insert(m.key());
                        rules.push(m);
                    }
                }
            }
        }
    }
    // legacy reusable-rules file → fold into rules (deduped)
    if let Ok(txt) = std::fs::read_to_string(format!("{dir}/key-matchers.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            if v.get("schema").and_then(|s| s.as_u64()) == Some(1) {
                if let Some(arr) = v.get("matchers").and_then(|m| m.as_array()) {
                    for mv in arr {
                        if let Ok(m) = serde_json::from_value::<KeyMatcher>(mv.clone()) {
                            let id = m.key();
                            if seen.insert(id) {
                                rules.push(m);
                            }
                        }
                    }
                }
            }
        }
    }
    rules
}

fn shared_dir() -> String {
    std::env::var("SEAM_ADAPTERS_DIR").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| {
        let home = std::env::var("HOME").unwrap_or_default();
        format!("{home}/.config/seam/adapters")
    })
}

/// All learned rules (repo FIRST, then shared), deduped by executable identity. Port of `loadMatchers`.
pub fn load_matchers(repo: &str) -> Vec<KeyMatcher> {
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for dir in [format!("{repo}/.seam"), shared_dir()] {
        for m in load_store_rules(&dir) {
            let id = m.key();
            if seen.insert(id) {
                out.push(m);
            }
        }
    }
    out
}

/// Execute a matcher over ONE file → the keys it detects. Deterministic, bounded, no LLM. Port of `runMatcher`
/// (the 4 regex shapes that appear in practice: call / repository / channel / handle).
/// A learned rule with its regex COMPILED once (the pattern is a pure function of token+verbs, not the file),
/// so a repo-wide scan compiles each rule once instead of once per (rule, file). `run_compiled` executes it
/// over PRE-MASKED text — so the comment mask is computed once per file, not once per (rule, file). Together
/// these remove the two hot-loop wastes `apply_matchers` was paying ~147k times. Byte-identical to `run_matcher`.
pub struct CompiledMatcher {
    matcher: KeyMatcher,
    re: Option<Regex>,
}

impl CompiledMatcher {
    pub fn new(m: &KeyMatcher) -> Self {
        CompiledMatcher { matcher: m.clone(), re: matcher_regex(m) }
    }
    /// Run over PRE-MASKED text (`raw` = unmasked source, for the literal prefilter). Byte-identical to
    /// `run_matcher(&self.matcher, raw)` but with the regex + mask hoisted out of the hot loop.
    pub fn run(&self, raw: &str, masked: &str) -> Vec<KeyHit> {
        run_compiled(&self.matcher, self.re.as_ref(), raw, masked)
    }
}

fn prefilter_on() -> bool {
    std::env::var("SEAM_MATCHER_PREFILTER").as_deref() != Ok("0")
}

// A matcher's constant look-back regex (ROOT / this-field guard) — compiled ONCE, not per call.
static PRE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"([A-Za-z_$][\w$]*)\s*\.\s*$").unwrap());

/// The per-rule regex (pure function of token/verbs). `None` for shapes with no regex (Method/unported AST).
fn matcher_regex(m: &KeyMatcher) -> Option<Regex> {
    match m {
        KeyMatcher::Call { token, .. } => Some(Regex::new(&format!(r"{}\s*\(", regex::escape(token))).unwrap()),
        KeyMatcher::Repository { token, verbs, .. } => {
            let verbs_alt = verbs.iter().map(|v| regex::escape(v)).collect::<Vec<_>>().join("|");
            Some(Regex::new(&format!(r"{}\s*\.\s*({verbs_alt})\s*[(<]", regex::escape(token))).unwrap())
        }
        KeyMatcher::Channel { token, verbs, .. } => {
            let verbs_alt = verbs.iter().map(|v| regex::escape(v)).collect::<Vec<_>>().join("|");
            Some(Regex::new(&format!(r#"{}\s*\.\s*(?:{verbs_alt})\s*\(\s*['"`]([^'"`]{{1,80}})['"`]"#, regex::escape(token))).unwrap())
        }
        KeyMatcher::Handle { token, verbs, .. } => {
            let recv = token.split('.').map(regex::escape).collect::<Vec<_>>().join(r"\s*\.\s*");
            let verbs_alt = verbs.iter().map(|v| regex::escape(v)).collect::<Vec<_>>().join("|");
            Some(Regex::new(&format!(r"{recv}\s*\.\s*(?:{verbs_alt})\s*\(")).unwrap())
        }
        _ => None,
    }
}

/// Execute ONE rule over a file → the keys it detects (regex over comment-masked text). Port of `runMatcher`.
/// A one-shot convenience (compiles + masks per call) — the repo-wide scan uses `CompiledMatcher` + pre-masked
/// text instead. Kept for the pipeline's per-anchor calls.
pub fn run_matcher(m: &KeyMatcher, text: &str) -> Vec<KeyHit> {
    let re = matcher_regex(m);
    let masked = mask_comments(text);
    run_compiled(m, re.as_ref(), text, &masked)
}

/// Run a matcher with its PRECOMPILED regex over PRE-MASKED text. `raw` is the unmasked source (the literal
/// prefilter checks it, byte-identical to `run_matcher`). Used by `apply_matchers` (mask + compile hoisted out).
pub fn run_compiled(m: &KeyMatcher, re: Option<&Regex>, raw: &str, masked: &str) -> Vec<KeyHit> {
    // prefilter: a file lacking the required literal can never match (checked on the RAW text, as before).
    if prefilter_on() {
        if let Some(lit) = m.literal() {
            if !raw.contains(&lit) {
                return Vec::new();
            }
        }
    }
    match m {
        KeyMatcher::Call { arg_index, strip, kind, role, .. } => run_call(re.unwrap(), *arg_index, strip.as_deref(), kind, produces(role), masked),
        KeyMatcher::Repository { token, kind, role, .. } => run_repository(re.unwrap(), token, kind, produces(role), masked),
        KeyMatcher::Channel { kind, role, .. } => run_channel(re.unwrap(), kind, produces(role), masked),
        KeyMatcher::Handle { token, kind, role, .. } => run_handle(re.unwrap(), token, kind, produces(role), masked),
        // The AST shapes (assign/method/attr/annotation/member) don't appear in practice yet — port on demand.
        _ => Vec::new(),
    }
}

fn slug(s: &str) -> String {
    let mut out = String::new();
    let lower = s.to_lowercase();
    let mut prev_dash = false;
    for c in lower.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let out = out.trim_matches('-').to_string();
    out.chars().take(48).collect()
}

/// The nth (0-based) string-literal argument of a call whose args start at byte `start`. Port of `nthStringArg`.
fn nth_string_arg(text: &str, start: usize, n: i64) -> Option<String> {
    let lit = |raw: &str| -> Option<String> {
        let s = raw.trim();
        let ch: Vec<char> = s.chars().collect();
        if ch.len() >= 2 && matches!(ch[0], '"' | '\'' | '`') && ch[ch.len() - 1] == ch[0] {
            let inner: String = ch[1..ch.len() - 1].iter().collect();
            if inner.contains(['`', '\'', '"']) {
                return None;
            }
            return Some(inner);
        }
        None
    };
    let b = text.as_bytes();
    let (mut depth, mut arg): (i64, i64) = (0, 0);
    let mut arg_start = start;
    let mut i = start;
    while i < b.len() {
        let c = b[i] as char;
        if c == '"' || c == '\'' || c == '`' {
            let q = b[i];
            i += 1;
            while i < b.len() && b[i] != q {
                if b[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i += 1;
            continue;
        }
        if c == '(' || c == '[' || c == '{' {
            depth += 1;
            i += 1;
            continue;
        }
        if c == ')' || c == ']' || c == '}' {
            if depth == 0 {
                return if arg == n { lit(&text[arg_start..i]) } else { None };
            }
            depth -= 1;
            i += 1;
            continue;
        }
        if c == ',' && depth == 0 {
            if arg == n {
                return lit(&text[arg_start..i]);
            }
            arg += 1;
            arg_start = i + 1;
            i += 1;
            continue;
        }
        i += 1;
    }
    None
}

fn run_call(re: &Regex, arg_index: i64, strip: Option<&str>, kind: &str, produces: bool, masked: &str) -> Vec<KeyHit> {
    let mut out = Vec::new();
    for c in captures_not_word_before(re, masked) {
        let whole = c.get(0).unwrap();
        let mut value = match nth_string_arg(masked, whole.end(), arg_index) {
            Some(v) => v,
            None => continue,
        };
        if let Some(strip) = strip {
            if !value.starts_with(strip) {
                continue;
            }
            value = value[strip.len()..].to_string();
        }
        if plausible_key_value(&value) {
            out.push(KeyHit { kind: kind.into(), value, line: line_of(masked, whole.start()), produces, ..Default::default() });
        }
    }
    out
}

fn run_repository(re: &Regex, token: &str, kind: &str, produces: bool, masked: &str) -> Vec<KeyHit> {
    let mut out = Vec::new();
    for c in captures_not_word_before(re, masked) {
        let start = c.get(0).unwrap().start();
        // ROOT / this-field only: reject a preceding `<ident>.` unless this/self/super.
        let lo = start.saturating_sub(48);
        if let Some(pre) = PRE_RE.captures(&masked[lo..start]) {
            let id = &pre[1];
            if id != "this" && id != "self" && id != "super" {
                continue;
            }
        }
        if plausible_key_value(token) {
            let op = if produces { write_op(&c[1]) } else { None };
            out.push(KeyHit { kind: kind.into(), value: token.into(), line: line_of(masked, start), produces, op: op.map(|s| s.to_string()), ..Default::default() });
        }
    }
    out
}

fn run_channel(re: &Regex, kind: &str, produces: bool, masked: &str) -> Vec<KeyHit> {
    let mut out = Vec::new();
    for c in captures_not_word_before(re, masked) {
        let start = c.get(0).unwrap().start();
        if plausible_key_value(&c[1]) {
            out.push(KeyHit { kind: kind.into(), value: c[1].to_string(), line: line_of(masked, start), produces, ..Default::default() });
        }
    }
    out
}

fn run_handle(re: &Regex, token: &str, kind: &str, produces: bool, masked: &str) -> Vec<KeyHit> {
    let value = slug(token);
    if !plausible_key_value(&value) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for c in captures_not_word_before(re, masked) {
        let start = c.get(0).unwrap().start();
        out.push(KeyHit { kind: kind.into(), value: value.clone(), line: line_of(masked, start), produces, ..Default::default() });
    }
    out
}
