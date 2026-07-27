//! DEF TABLE — enumerate the repo's top-level declarations (+ class methods) with enough context to EMBED for
//! semantic anchor recall: name + kind + signature line + enclosing class + path (+ a body passage for
//! callables). The closed candidate set the embedding recall ranks against. Deterministic/offline. Port of
//! `codebase/scan/def_table.ts` + `def_treesitter.ts` (the embed string / caching / disk-shard memo are the
//! caller's concern; here we produce the defs). TS/JS use the JS-shaped REGEX extractor; the other languages
//! use the tree-sitter extractor.

use once_cell::sync::Lazy;
use regex::Regex;
use seam_fs::normpath;
use seam_lang::{grammar_for, has_validated_regex_defs, Ctx};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

const MAX_CANDIDATE_BYTES: u64 = 1024 * 1024; // 1 MB — a source file past this is a vendored/generated bundle
const DOC_CAP: usize = 200; // SCAN.docCap
const BODY_LINES: usize = 14; // SCAN.bodyLines
const BODY_CAP: usize = 240; // SCAN.bodyCap

/// A declaration with embed context. Port of `Def`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Def {
    pub name: String,
    pub kind: String,
    pub file: String,
    pub signature: String,
    pub enclosing: String,
    pub doc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

/// A source file bigger than 1 MB is skipped as an anchor/def candidate (missing/unstattable → skip). Port of
/// `oversizedForAnchor`.
pub fn oversized_for_anchor(abs: &str) -> bool {
    std::fs::metadata(abs).map(|m| m.len() > MAX_CANDIDATE_BYTES).unwrap_or(true)
}

/// The repo's anchor-CANDIDATE source files: the gitignore-aware source walk (`source_files` over the
/// SOURCE_EXTS), minus oversized bundles, sorted. Port of `candidate_source_files` (the git-set ∪ walk-set of TS
/// nets out to the gitignore-aware walk after the source-ext / no-skip-seg / oversized filters).
pub fn candidate_source_files(repo: &str) -> Vec<String> {
    let mut out: Vec<String> = seam_fs::source_files(repo, |r| seam_couple::ground::floor::ends_with_source_ext(r))
        .into_iter()
        .filter(|rel| !oversized_for_anchor(&format!("{repo}/{rel}")))
        .collect();
    out.sort();
    out.dedup();
    out
}

// ── the JS-shaped regex extractor (TS/JS) ─────────────────────────────────────────────────────────────────────
// `[\w$]` is the ASCII `[0-9A-Za-z_$]` (matching JS `\w`); no lookbehind/backref, so these port directly.
static CLASS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:abstract[ \t]+)?(class|interface|enum|namespace)[ \t]+([A-Za-z_$][0-9A-Za-z_$]*)").unwrap());
static FN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?function[ \t]*\*?[ \t]*([A-Za-z_$][0-9A-Za-z_$]*)").unwrap());
static ARROW_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[ \t]*(?:export[ \t]+)?(?:const|let)[ \t]+([A-Za-z_$][0-9A-Za-z_$]*)[ \t]*(?::[^=\n]+)?=[ \t]*(?:async[ \t]+)?(?:\([^)]*\)|[A-Za-z_$][0-9A-Za-z_$]*)[ \t]*(?::[^\n]+?)?=>").unwrap());
static METHOD_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[ \t]+(?:public|private|protected|static|async|readonly|get|set|\*|[ \t])*([A-Za-z_$][0-9A-Za-z_$]*)[ \t]*\([^)]*\)[ \t]*(?::[^={\n]+)?[ \t]*\{").unwrap());
static DESCRIPTOR_KEY_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"^[ \t]*["']?([A-Za-z_$][0-9A-Za-z_$]*)["']?[ \t]*:[ \t]*\{"#).unwrap());
static OBJ_OPEN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:^|[ \t.])([A-Za-z_$][0-9A-Za-z_$]*)[ \t]*=[ \t]*\{[ \t]*$").unwrap());
static METHOD_SKIP: Lazy<std::collections::HashSet<&'static str>> =
    Lazy::new(|| ["if", "for", "while", "switch", "catch", "return", "function", "constructor"].into_iter().collect());

fn is_comment(t: &str) -> bool {
    t.starts_with("//") || t.starts_with("/*") || t.starts_with('*')
}

// Strip comment markers exactly as def_table's `_stripComment`:
//   .replace(/^\/\*+|\*+\/$/g, "").replace(/^\*\s?/, "").replace(/^\/\/\s?/, "").trim()
static SC_BLOCK: Lazy<Regex> = Lazy::new(|| Regex::new(r"^/\*+|\*+/$").unwrap());
static SC_STAR: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\*\s?").unwrap());
static SC_SLASH: Lazy<Regex> = Lazy::new(|| Regex::new(r"^//\s?").unwrap());
fn strip_comment(t: &str) -> String {
    let s = SC_BLOCK.replace_all(t, "");
    let s = SC_STAR.replace(&s, "").into_owned();
    let s = SC_SLASH.replace(&s, "").into_owned();
    s.trim().to_string()
}

/// The forward body passage — the next code lines after a callable's signature, comment-stripped, capped. Port
/// of `_body_window`.
pub fn body_window(lines: &[&str], from: isize) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut i = from + 1;
    while (i as usize) < lines.len() && i <= from + BODY_LINES as isize {
        let t = lines[i as usize].trim();
        i += 1;
        if t.is_empty() || is_comment(t) || t.chars().all(|c| "{}()[];,".contains(c)) && !t.is_empty() {
            continue;
        }
        parts.push(t.to_string());
        if u16_len(&parts.join(" ")) >= BODY_CAP {
            break;
        }
    }
    let joined: String = parts.join(" ").split_whitespace().collect::<Vec<_>>().join(" ");
    take_chars(&joined, BODY_CAP)
}

/// UTF-16 code-unit length (matching JS `.length`) — caps/slices are JS-string-length based.
fn u16_len(s: &str) -> usize {
    s.encode_utf16().count()
}
/// Truncate `s` to at most `n` UTF-16 code units (matching JS `.slice(0, n)`).
fn take_chars(s: &str, n: usize) -> String {
    String::from_utf16_lossy(&s.encode_utf16().take(n).collect::<Vec<u16>>())
}

struct Scope {
    name: String,
    depth: i64,
    obj: bool,
}

/// The JS-shaped regex def extractor. Port of `defs_in_file`.
pub fn defs_in_file(file: &str, text: &str) -> Vec<Def> {
    let mut out: Vec<Def> = Vec::new();
    let mut stack: Vec<Scope> = Vec::new();
    let mut depth: i64 = 0;
    let mut pending_doc = String::new();
    let lines: Vec<&str> = text.split('\n').collect();
    for li in 0..lines.len() {
        let raw = lines[li];
        // truncate to 300 chars (char-safe) as TS `raw.slice(0,300)`.
        let line: String = if u16_len(raw) > 300 { take_chars(raw, 300) } else { raw.to_string() };
        let trimmed = line.trim();
        if is_comment(trimmed) {
            if u16_len(&pending_doc) < DOC_CAP {
                pending_doc.push(' ');
                pending_doc.push_str(&strip_comment(trimmed));
            }
            continue;
        }
        let enclosing = stack.last().map(|s| s.name.clone()).unwrap_or_default();
        let in_obj = stack.last().map(|s| s.obj).unwrap_or(false);
        // signature = trimmed with a trailing `{` (and surrounding spaces/tabs) dropped.
        let sig = TRAIL_BRACE.replace(trimmed, "").to_string();
        let take = |pd: &mut String| -> String {
            let d = take_chars(pd.trim(), DOC_CAP);
            pd.clear();
            d
        };
        if let Some(m) = CLASS_RE.captures(&line) {
            out.push(Def { name: m[2].to_string(), kind: m[1].to_string(), file: file.to_string(), signature: sig.clone(), enclosing, doc: take(&mut pending_doc), body: None });
            if line.contains('{') {
                stack.push(Scope { name: m[2].to_string(), depth, obj: false });
            }
        } else if let Some(m) = FN_RE.captures(&line) {
            out.push(Def { name: m[1].to_string(), kind: "function".into(), file: file.to_string(), signature: sig.clone(), enclosing, doc: take(&mut pending_doc), body: Some(body_window(&lines, li as isize)) });
        } else if let Some(m) = ARROW_RE.captures(&line) {
            out.push(Def { name: m[1].to_string(), kind: "function".into(), file: file.to_string(), signature: sig.clone(), enclosing, doc: take(&mut pending_doc), body: Some(body_window(&lines, li as isize)) });
        } else if !enclosing.is_empty() && METHOD_RE.captures(&line).map(|m| !METHOD_SKIP.contains(&m[1])).unwrap_or(false) {
            let m = METHOD_RE.captures(&line).unwrap();
            out.push(Def { name: m[1].to_string(), kind: "method".into(), file: file.to_string(), signature: sig.clone(), enclosing, doc: take(&mut pending_doc), body: Some(body_window(&lines, li as isize)) });
        } else if in_obj && DESCRIPTOR_KEY_RE.is_match(&line) {
            let m = DESCRIPTOR_KEY_RE.captures(&line).unwrap();
            out.push(Def { name: m[1].to_string(), kind: "function".into(), file: file.to_string(), signature: sig.clone(), enclosing, doc: take(&mut pending_doc), body: Some(body_window(&lines, li as isize)) });
        } else if let Some(m) = OBJ_OPEN_RE.captures(&line) {
            if line.contains('{') {
                stack.push(Scope { name: m[1].to_string(), depth, obj: true });
            }
        } else if !trimmed.is_empty() {
            pending_doc.clear();
        }
        for ch in line.chars() {
            if ch == '{' {
                depth += 1;
            } else if ch == '}' {
                depth -= 1;
                if let Some(top) = stack.last() {
                    if depth <= top.depth {
                        stack.pop();
                    }
                }
            }
        }
    }
    out
}

static TRAIL_BRACE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[ \t]*\{[ \t]*$").unwrap());

/// The embed string (the domain signal the bare name lacks). Port of `embedString`.
pub fn embed_string(d: &Def) -> String {
    let encl = if d.enclosing.is_empty() { String::new() } else { format!(" in {}", d.enclosing) };
    let prefix = if d.kind == "method" { "method " } else { "" };
    let doc = if d.doc.is_empty() { String::new() } else { format!(" :: {}", d.doc) };
    // An EMPTY body is ABSENT, not an empty brace pair. TS tests `d.body ?` — a `""` is falsy there and the
    // clause is omitted, so `Some("")` here appended a bare " {  }" and embedded a DIFFERENT string than the
    // TS side for every def whose body extraction came back empty. Same def, same file, different vector.
    let body = d.body.as_deref().filter(|b| !b.is_empty()).map(|b| format!(" {{ {b} }}")).unwrap_or_default();
    let sig = if d.signature.is_empty() { &d.name } else { &d.signature };
    format!("{prefix}{sig}{encl} — {}{doc}{body}", d.file)
}

/// A FILE-LEVEL def (name=basename, doc=first comment block, body=file head). Port of `module_def`.
pub fn module_def(rel: &str, text: &str) -> Def {
    let base = {
        let last = rel.rsplit('/').next().unwrap_or(rel);
        match last.rfind('.') {
            Some(i) => &last[..i],
            None => last,
        }
    };
    let lines: Vec<&str> = text.split('\n').collect();
    let mut doc = String::new();
    for i in 0..lines.len().min(40) {
        if u16_len(&doc) >= DOC_CAP {
            break;
        }
        let t = lines[i].trim();
        if is_comment(t) {
            doc.push(' ');
            doc.push_str(&strip_comment(t));
        } else if !doc.is_empty() {
            break;
        }
    }
    Def {
        name: base.to_string(),
        kind: "module".into(),
        file: rel.to_string(),
        signature: format!("module {base}"),
        enclosing: String::new(),
        doc: take_chars(doc.trim(), DOC_CAP),
        body: Some(body_window(&lines, -1)),
    }
}

// ── the tree-sitter extractor (non-TS/JS) ─────────────────────────────────────────────────────────────────────
static CONTAINER: Lazy<std::collections::HashSet<&'static str>> = Lazy::new(|| {
    ["class_declaration", "class_specifier", "class", "interface_declaration", "enum_declaration", "enum_specifier", "struct_specifier", "namespace_definition", "module"].into_iter().collect()
});
static CALLABLE: Lazy<std::collections::HashSet<&'static str>> = Lazy::new(|| {
    ["function_declaration", "function_definition", "method_definition", "method_declaration", "method", "constructor_declaration"].into_iter().collect()
});
static ARROW_HOLDERS: Lazy<std::collections::HashSet<&'static str>> = Lazy::new(|| ["lexical_declaration", "variable_declaration"].into_iter().collect());
static FN_VALUES: Lazy<std::collections::HashSet<&'static str>> = Lazy::new(|| ["arrow_function", "function", "function_expression"].into_iter().collect());
static NAME_LEAVES: Lazy<std::collections::HashSet<&'static str>> =
    Lazy::new(|| ["identifier", "field_identifier", "qualified_identifier", "destructor_name", "operator_name", "type_identifier"].into_iter().collect());

// The def_treesitter `_stripComment` (distinct from the regex-path one — MULTILINE `gm` on the `*#` and `//`
// strips, and it removes only ONE `//` per line, not every leading slash):
//   .replace(/^\/\*+|\*+\/$/g,"").replace(/^[ \t]*[*#]\s?/gm,"").replace(/^\/\/\s?/gm,"")
//   .replace(/^#\s?/,"").replace(/\s+/g," ").trim()
static TSC_BLOCK: Lazy<Regex> = Lazy::new(|| Regex::new(r"^/\*+|\*+/$").unwrap());
static TSC_STARHASH: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^[ \t]*[*#]\s?").unwrap());
static TSC_SLASH: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^//\s?").unwrap());
static TSC_HASH: Lazy<Regex> = Lazy::new(|| Regex::new(r"^#\s?").unwrap());
static TSC_WS: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").unwrap());
fn ts_strip_comment(t: &str) -> String {
    let s = TSC_BLOCK.replace_all(t, "");
    let s = TSC_STARHASH.replace_all(&s, "").into_owned();
    let s = TSC_SLASH.replace_all(&s, "").into_owned();
    let s = TSC_HASH.replace(&s, "").into_owned();
    let s = TSC_WS.replace_all(&s, " ").into_owned();
    s.trim().to_string()
}

fn field_name(ctx: &Ctx, n: tree_sitter::Node) -> Option<String> {
    n.child_by_field_name("name").map(|f| ctx.text(f).to_string())
}

fn declarator_name(ctx: &Ctx, n: tree_sitter::Node) -> Option<String> {
    let mut x = Some(n);
    for _ in 0..16 {
        let Some(node) = x else { break };
        if NAME_LEAVES.contains(node.kind()) {
            return Some(ctx.text(node).to_string());
        }
        x = node.child_by_field_name("declarator");
    }
    None
}

fn sig_line(lines: &[&str], row: usize) -> String {
    let l = lines.get(row).copied().unwrap_or("").trim();
    TRAIL_BRACE.replace(l, "").to_string()
}

/// The tree-sitter def extractor for a parsed file. Port of `defs_in_file_treesitter` (None if no grammar).
pub fn defs_in_file_treesitter(file: &str, text: &str) -> Option<Vec<Def>> {
    let grammar = grammar_for(file)?;
    let ctx = Ctx::parse(text, grammar)?;
    let root = ctx.root();
    let lines: Vec<&str> = text.split('\n').collect();
    // comments indexed by the row they END on (full traversal incl. extras).
    let mut comments: HashMap<usize, (usize, String)> = HashMap::new();
    {
        let mut stack = vec![root];
        while let Some(n) = stack.pop() {
            if n.kind().contains("comment") {
                comments.insert(n.end_position().row, (n.start_position().row, ctx.text(n).to_string()));
            }
            for i in 0..n.child_count() {
                if let Some(c) = n.child(i) {
                    stack.push(c);
                }
            }
        }
    }
    let preceding_doc = |start_row: usize| -> String {
        let mut parts: Vec<String> = Vec::new();
        let mut row = start_row as isize - 1;
        while row >= 0 {
            let Some((cstart, ctext)) = comments.get(&(row as usize)) else { break };
            parts.insert(0, ts_strip_comment(ctext));
            row = *cstart as isize - 1;
        }
        take_chars(&parts.join(" "), DOC_CAP).trim().to_string()
    };
    let mut out: Vec<Def> = Vec::new();
    // recursive visit
    fn visit(ctx: &Ctx, n: tree_sitter::Node, enclosing: &str, lines: &[&str], preceding_doc: &dyn Fn(usize) -> String, out: &mut Vec<Def>) {
        let mut next_enclosing = enclosing.to_string();
        let kind = n.kind();
        if CONTAINER.contains(kind) {
            if let Some(name) = field_name(ctx, n) {
                let dk = if kind.contains("interface") { "interface" } else if kind.contains("enum") { "enum" } else { "class" };
                out.push(Def { name: name.clone(), kind: dk.into(), file: String::new(), signature: sig_line(lines, n.start_position().row), enclosing: enclosing.to_string(), doc: preceding_doc(n.start_position().row), body: None });
                next_enclosing = name;
            }
        } else if CALLABLE.contains(kind) {
            if let Some(name) = field_name(ctx, n).or_else(|| declarator_name(ctx, n)) {
                let dk = if enclosing.is_empty() { "function" } else { "method" };
                out.push(Def { name, kind: dk.into(), file: String::new(), signature: sig_line(lines, n.start_position().row), enclosing: enclosing.to_string(), doc: preceding_doc(n.start_position().row), body: Some(body_window(lines, n.start_position().row as isize)) });
            }
        } else if ARROW_HOLDERS.contains(kind) {
            for i in 0..n.named_child_count() {
                let Some(d) = n.named_child(i) else { continue };
                if d.kind() != "variable_declarator" {
                    continue;
                }
                if let Some(v) = d.child_by_field_name("value") {
                    if FN_VALUES.contains(v.kind()) {
                        if let Some(name) = field_name(ctx, d) {
                            let dk = if enclosing.is_empty() { "function" } else { "method" };
                            out.push(Def { name, kind: dk.into(), file: String::new(), signature: sig_line(lines, n.start_position().row), enclosing: enclosing.to_string(), doc: preceding_doc(n.start_position().row), body: None });
                        }
                    }
                }
            }
        }
        for i in 0..n.named_child_count() {
            if let Some(c) = n.named_child(i) {
                visit(ctx, c, &next_enclosing, lines, preceding_doc, out);
            }
        }
    }
    visit(&ctx, root, "", &lines, &preceding_doc, &mut out);
    // stamp the file (TS builds Defs with the file already; we set it here to avoid threading through visit).
    for d in out.iter_mut() {
        d.file = file.to_string();
    }
    Some(out)
}

/// Per-language def extraction for one file → its real defs + the file-level module def. Port of `_scan_defs_file`.
fn scan_defs_file(rel: &str, text: &str) -> (Vec<Def>, Def) {
    let defs = if has_validated_regex_defs(rel) {
        defs_in_file(rel, text)
    } else {
        defs_in_file_treesitter(rel, text).unwrap_or_else(|| defs_in_file(rel, text))
    };
    (defs, module_def(rel, text))
}

// In-memory whole-repo memo (the disk shard cache is a later perf layer; output-identical without it).
static MEM: Lazy<Mutex<HashMap<String, Vec<Def>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Whole-repo / scoped def enumeration. `files` (repo-relative) scopes it to those files; else the whole repo
/// (memoized). `module_defs` appends the file-level def after each file's real ones. Port of `enumerate_defs`.
pub fn enumerate_defs(repo: &str, limit: usize, files: Option<&[String]>, module_defs: bool) -> Vec<Def> {
    let rels: Vec<String> = match files {
        Some(fs) if !fs.is_empty() => fs.iter().map(|f| normpath(f)).collect(),
        _ => {
            let key = format!("{repo}|{limit}|{module_defs}");
            if let Some(hit) = MEM.lock().unwrap().get(&key) {
                return hit.clone();
            }
            let out = enumerate_files(repo, &candidate_source_files(repo), limit, module_defs);
            MEM.lock().unwrap().insert(key, out.clone());
            return out;
        }
    };
    enumerate_files(repo, &rels, limit, module_defs)
}

fn enumerate_files(repo: &str, rels: &[String], limit: usize, module_defs: bool) -> Vec<Def> {
    let mut out: Vec<Def> = Vec::new();
    for rel in rels {
        let Ok(text) = std::fs::read_to_string(format!("{repo}/{rel}")) else { continue };
        let (defs, m) = scan_defs_file(rel, &text);
        for d in defs {
            out.push(d);
            if out.len() >= limit {
                return out;
            }
        }
        if module_defs {
            out.push(m);
            if out.len() >= limit {
                return out;
            }
        }
    }
    out
}

/// Drop the whole-repo memo (the edit-loop hook).
pub fn reset(repo: Option<&str>) {
    let mut m = MEM.lock().unwrap();
    match repo {
        Some(r) => m.retain(|k, _| !k.starts_with(&format!("{r}|"))),
        None => m.clear(),
    }
}
