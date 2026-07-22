//! CONSTANT-RESOLVING shared-key floor. Frameworks like Dubbo key couplings with a NAMED CONSTANT, not a
//! literal: `url.getParameter(TOKEN_KEY)` (consume) ⇄ `url.addParameter(TOKEN_KEY, …)` (produce), where
//! `String TOKEN_KEY = "token"` lives in a constants interface. We build a repo-wide CONSTANT→VALUE map, then
//! resolve each getParameter/addParameter arg through it so both sides land on ONE value ("token"). Repo-wide
//! by necessity (the constant is DEFINED in one file, USED in another). Deterministic, no LLM. Port of
//! coupling/const_keys.ts.

use crate::key_ir::{line_of, plausible_key_value};
use crate::types::{Access, KeySides};
use indexmap::IndexMap;
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;

// A NAMED string constant: `static final String NAME = "value"`, or a Java interface field `String NAME =
// "value"` (implicitly static final). Require an UPPER_SNAKE name so a local `String x = "y"` isn't a constant.
static CONST_DECL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?:static\s+final\s+|final\s+static\s+)?String\s+([A-Z][A-Z0-9_]{1,})\s*=\s*"([^"]*)""#).unwrap());
// CONSUME / PRODUCE the key via a getter/setter whose FIRST arg is the key (literal or constant).
static CONSUME: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\.(?:getParameter|getAttachment|getMethodParameter|getServiceParameter)\s*\(\s*([^,)\n]+?)\s*[,)]").unwrap());
static PRODUCE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\.(?:setParameter|addParameter|addParameterIfAbsent|setAttachment|putAttachment)\s*\(\s*([^,)\n]+?)\s*[,)]").unwrap());
// A resolvable string-literal arg: the whole arg is one quoted literal.
static LIT_ARG: Lazy<Regex> = Lazy::new(|| Regex::new(r#"^["'`]([^"'`]+)["'`]$"#).unwrap());
// An UPPER_SNAKE identifier (the constant-name shape).
static UPPER_ID: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Z][A-Z0-9_]+$").unwrap());

/// One unresolved getParameter/addParameter call-site — the raw arg + where it sits, collected during the
/// repo walk and resolved against the COMPLETE const map afterward. Port of `ParamSite`.
#[derive(Clone, Debug)]
pub struct ParamSite {
    pub rel: String,
    pub raw: String,
    pub line: usize,
    pub produces: bool,
}

/// Resolve a call arg to a key VALUE: a "string literal" → its content; a CONSTANT (or `Class.CONSTANT`) → its
/// mapped value; anything else (a variable, a computed expr) → None. Port of `resolveArg`.
fn resolve_arg(raw: &str, const_map: &HashMap<String, String>) -> Option<String> {
    let v = raw.trim();
    if let Some(c) = LIT_ARG.captures(v) {
        return Some(c[1].to_string());
    }
    let id = v.rsplit('.').next().unwrap_or(v); // CommonConstants.TOKEN_KEY → TOKEN_KEY
    if UPPER_ID.is_match(id) {
        return const_map.get(id).cloned();
    }
    None
}

/// Collect NAMED string-constant declarations into `const_map` (first declaration wins). Port of `scanConstDecls`.
pub fn scan_const_decls(masked: &str, const_map: &mut HashMap<String, String>) {
    for c in CONST_DECL.captures_iter(masked) {
        const_map.entry(c[1].to_string()).or_insert_with(|| c[2].to_string());
    }
}

/// A file's const decls as ordered (name, value) pairs, first-occurrence wins — the per-file `FloorContribution`
/// stores these (matches TS `constDecls.push(...cm)` over the insertion-ordered Map).
pub fn const_decls_ordered(masked: &str) -> Vec<(String, String)> {
    let mut seen: HashMap<String, ()> = HashMap::new();
    let mut out = Vec::new();
    for c in CONST_DECL.captures_iter(masked) {
        if seen.insert(c[1].to_string(), ()).is_none() {
            out.push((c[1].to_string(), c[2].to_string()));
        }
    }
    out
}

/// Collect raw getParameter/addParameter call-sites (arg left UNRESOLVED). Port of `scanParamSites`.
pub fn scan_param_sites(masked: &str, rel: &str, out: &mut Vec<ParamSite>) {
    for (re, produces) in [(&*CONSUME, false), (&*PRODUCE, true)] {
        for c in re.captures_iter(masked) {
            let whole = c.get(0).unwrap();
            out.push(ParamSite { rel: rel.to_string(), raw: c[1].to_string(), line: line_of(masked, whole.start()), produces });
        }
    }
}

/// Resolve collected sites against the final const map → a `GroundingIndex` (literal or constant → value),
/// dropping implausible values with the shared floor guard. Port of `resolveParamSites`.
pub fn resolve_param_sites(sites: &[ParamSite], const_map: &HashMap<String, String>) -> IndexMap<String, KeySides> {
    let mut idx: IndexMap<String, KeySides> = IndexMap::new();
    for s in sites {
        let Some(value) = resolve_arg(&s.raw, const_map) else { continue };
        if !plausible_key_value(&value) {
            continue; // no "the"/generic/prose keys
        }
        let k = format!("key {value}");
        let entry = idx.entry(k).or_default();
        let acc = Access { file: s.rel.clone(), line: s.line };
        if s.produces {
            entry.producers.push(acc);
        } else {
            entry.consumers.push(acc);
        }
    }
    idx
}
