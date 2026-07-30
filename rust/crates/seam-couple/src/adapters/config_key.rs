//! FRAMEWORK adapter: CONFIGURATION KEYS — an environment variable or system property read by two stacks that
//! share no code edge of any kind. The CROSS-LANGUAGE floor, like raw SQL: the key is a bare string literal, so
//! one adapter covers every host language once its access syntax is listed.
//!
//! WHY IT EXISTS. `bench/coupling` was built to give the data-coupling layer a ground truth, and on its very
//! first run it found this missing: `api/notify.ts` reads `process.env.NOTIFY_WEBHOOK_URL` and
//! `backend/NotifyWorker.java` reads `System.getenv("NOTIFY_WEBHOOK_URL")`. Redefine what that value means on one
//! side and the other silently changes behaviour — and there is no import, no call, no table and no route to find
//! it by. The adapter set was db-table / http-route / data-file / egress / binding / member-access, none of which
//! can form that key, so the layer resolved nothing at all.
//!
//! THE KEY IS SYMMETRIC, and that is the one thing that makes this kind different from every other adapter here.
//! A table couples a WRITER to a READER; a route couples a CALLER to a HANDLER. A config key couples READER to
//! READER: two independent consumers of the same setting must agree about what it means, and neither writes it.
//! So `ground::other_side` unions both sides for this kind rather than returning the complement (see the
//! `CONFIG_KEY` branch there). A write (`process.env.X = …`) is still recorded as a producer, so a
//! definition ⇄ reader pair reads correctly too — the union simply also admits reader ⇄ reader.
//!
//! SCOPE, deliberately narrow. Only a LITERAL key counts. `process.env[name]` where `name` is a variable is
//! unresolvable here and is skipped rather than guessed at, exactly as an unresolvable table name is.

use crate::key_ir::line_of;
use crate::mask::MaskCtx;
use crate::types::{CouplingAdapter, KeyHit, KindMeta};
use once_cell::sync::Lazy;
use regex::Regex;

pub const CONFIG_KEY: &str = "config-key";

static META: KindMeta = KindMeta {
    kind: CONFIG_KEY,
    node_kind: "config-key",
    produce_edge: "config-write",
    consume_edge: "config-read",
    handler_edge: None,
    terminal: false,
    name: "config-key",
    blurb: "Shared environment variable / system property — configuration coupling across stacks",
    extra_exts: &[],
};

// A conventional env-var name: SCREAMING_SNAKE, at least two characters. The shape is the guard — it is what
// keeps `process.env.NODE_ENV` in and an ordinary property access like `config.timeout` out, without needing to
// know anything about the host language.
const NAME: &str = r"([A-Z][A-Z0-9_]+)";

// The cheap pre-gate. It must list the WRITE accessors too: the first version had only the read ones, so
// `System.setProperty("APP_MODE", …)` was rejected here and never reached the write pattern that was written
// specifically for it — a gate that silently excluded half the kind, caught by the unit test that asserted the
// write direction rather than by any run.
static GATE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:process\s*\.\s*env|import\s*\.\s*meta\s*\.\s*env|getenv|setenv|environ|getProperty|setProperty|GetEnvironmentVariable|SetEnvironmentVariable|\bENV\b)").unwrap()
});

/// Dotted / bracketed access on an env-like object, covering TS/JS (`process.env.X`, `process.env["X"]`,
/// `import.meta.env.X`), Ruby (`ENV["X"]`, `ENV.fetch("X")`) and Python (`os.environ["X"]`,
/// `os.environ.get("X")`). Reads.
static OBJ_READ_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r#"(?:process\s*\.\s*env|import\s*\.\s*meta\s*\.\s*env|os\s*\.\s*environ|\bENV)\s*(?:\.\s*(?:fetch|get)\s*\(\s*["']{NAME}["']|\[\s*["']{NAME}["']\s*\]|\.\s*{NAME})"#
    ))
    .unwrap()
});

/// A WRITE through the same objects: `process.env.X = …`, `os.environ["X"] = …`, `ENV["X"] = …`.
static OBJ_WRITE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r#"(?:process\s*\.\s*env|os\s*\.\s*environ|\bENV)\s*(?:\[\s*["']{NAME}["']\s*\]|\.\s*{NAME})\s*=[^=]"#
    ))
    .unwrap()
});

/// Function-call accessors: Java `System.getenv("X")` / `System.getProperty("x")`, Go `os.Getenv("X")`,
/// Python `os.getenv("X")`, Deno `Deno.env.get("X")`, C# `Environment.GetEnvironmentVariable("X")`. Reads.
static CALL_READ_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r#"(?:getenv|Getenv|getProperty|GetEnvironmentVariable|env\s*\.\s*get)\s*\(\s*["']{NAME}["']"#
    ))
    .unwrap()
});

/// Java `System.setProperty("x", …)` and friends — a write.
static CALL_WRITE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(r#"(?:setenv|Setenv|setProperty|SetEnvironmentVariable)\s*\(\s*["']{NAME}["']"#)).unwrap()
});

/// The first non-empty capture group — the regexes above are alternations, so exactly one matches.
fn captured(c: &regex::Captures) -> Option<String> {
    (1..c.len()).find_map(|i| c.get(i).map(|m| m.as_str().to_string()))
}

pub struct ConfigKey;

impl CouplingAdapter for ConfigKey {
    fn meta(&self) -> &KindMeta {
        &META
    }

    fn scan(&self, _file: &str, text: &str, _mask: &MaskCtx) -> Vec<KeyHit> {
        // THE RAW TEXT, not `mask.strings()`. Unlike raw SQL, a config access straddles the boundary: the key is
        // inside a literal (`getenv("X")`) but the accessor that proves it IS a config read is host syntax
        // outside it, and `process.env.X` has no literal at all. Scanning masked strings alone would drop the
        // dotted form entirely and scanning them for the call form would lose the `getenv` that identifies it.
        if !GATE_RE.is_match(text) {
            return Vec::new();
        }
        let mut out: Vec<KeyHit> = Vec::new();
        // WRITES FIRST, so that a `process.env.X = …` line is not also counted as a read of X by the dotted
        // read pattern. Tracked by (line, name) because the two regexes would otherwise both match it.
        let mut written: std::collections::HashSet<(usize, String)> = std::collections::HashSet::new();
        for re in [&*OBJ_WRITE_RE, &*CALL_WRITE_RE] {
            for c in re.captures_iter(text) {
                let Some(name) = captured(&c) else { continue };
                let line = line_of(text, c.get(0).unwrap().start());
                written.insert((line, name.clone()));
                out.push(KeyHit { kind: CONFIG_KEY.into(), value: name, line, produces: true, ..Default::default() });
            }
        }
        for re in [&*OBJ_READ_RE, &*CALL_READ_RE] {
            for c in re.captures_iter(text) {
                let Some(name) = captured(&c) else { continue };
                let line = line_of(text, c.get(0).unwrap().start());
                if written.contains(&(line, name.clone())) {
                    continue;
                }
                out.push(KeyHit { kind: CONFIG_KEY.into(), value: name, line, produces: false, ..Default::default() });
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hits(text: &str) -> Vec<(String, bool)> {
        let mask = MaskCtx::new(text);
        let mut v: Vec<(String, bool)> = ConfigKey.scan("f.ts", text, &mask).into_iter().map(|h| (h.value, h.produces)).collect();
        v.sort();
        v.dedup();
        v
    }

    #[test]
    fn every_host_language_reaches_the_same_key() {
        // ONE key, five languages, no code edge between any of them — the whole point of the kind.
        assert_eq!(hits(r#"const u = process.env.NOTIFY_WEBHOOK_URL ?? "";"#), vec![("NOTIFY_WEBHOOK_URL".into(), false)]);
        assert_eq!(hits(r#"String u = System.getenv("NOTIFY_WEBHOOK_URL");"#), vec![("NOTIFY_WEBHOOK_URL".into(), false)]);
        assert_eq!(hits(r#"url = ENV["NOTIFY_WEBHOOK_URL"]"#), vec![("NOTIFY_WEBHOOK_URL".into(), false)]);
        assert_eq!(hits(r#"url = os.environ.get("NOTIFY_WEBHOOK_URL")"#), vec![("NOTIFY_WEBHOOK_URL".into(), false)]);
        assert_eq!(hits(r#"url := os.Getenv("NOTIFY_WEBHOOK_URL")"#), vec![("NOTIFY_WEBHOOK_URL".into(), false)]);
    }

    #[test]
    fn a_write_is_a_producer_and_is_not_also_counted_as_a_read() {
        // `process.env.X = …` matches the dotted READ pattern too; if both fired, one line would look like a
        // definition AND a use of the same key, and the file would be its own counterpart.
        assert_eq!(hits(r#"process.env.FEATURE_FLAG = "on";"#), vec![("FEATURE_FLAG".into(), true)]);
        assert_eq!(hits(r#"System.setProperty("APP_MODE", "x");"#), vec![("APP_MODE".into(), true)]);
        // ...but an equality test is NOT a write
        assert_eq!(hits(r#"if (process.env.NODE_ENV === "test") {}"#), vec![("NODE_ENV".into(), false)]);
    }

    #[test]
    fn a_non_literal_key_is_skipped_rather_than_guessed() {
        // The honest answer for `process.env[name]` is nothing, exactly as for an unresolvable table name.
        assert!(hits(r#"const v = process.env[name];"#).is_empty());
        assert!(hits(r#"String v = System.getenv(keyName);"#).is_empty());
    }

    #[test]
    fn ordinary_property_access_is_not_a_config_key() {
        // FALSIFICATION: the shape of the NAME is the only guard, so a lowercase or mixed-case property must not
        // match even on an env-like object, and a file with no accessor at all must produce nothing.
        assert!(hits(r#"const t = config.timeout; const u = settings.apiUrl;"#).is_empty());
        assert!(hits(r#"const x = process.envy.Something;"#).is_empty());
        assert!(hits(r#"export function plain(a: string) { return a; }"#).is_empty());
    }
}
