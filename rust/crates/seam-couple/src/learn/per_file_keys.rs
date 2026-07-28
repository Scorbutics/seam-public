//! THE PER-FILE KEY AXIS — the flywheel's second learn path: ask the model what SHARED KEYS a file carries
//! that the deterministic floor could not read, then cache them per file-content so a warm run replays for
//! free. Port of `_batchPrompt` / `_parseBatch` / `_definedNames` / `_keyAdapterMeta` / `_batchSynthesize` /
//! `anchorProposedKeys` (ts/src/codebase/coupling/llm_key_index.ts).
//!
//! Where `discover.rs` learns a reusable RULE (a shape that grounds repo-wide), this learns FACTS about one
//! file. Both persist into the same `.seam` store and both replay deterministically.
//!
//! THREE GUARDS, all of them load-bearing, because a wrong key is worse than a missing one — it couples
//! unrelated files by coincidence and the answer LOOKS grounded:
//!   · `plausible_key_value` drops prose/generic tokens the model sometimes emits as "keys".
//!   · the DEFINED-NAMES guard drops values that are code symbols declared in the very text the model was
//!     shown — it echoes a class or method name back as a data key, and because it does so consistently
//!     across files those echoes would "ground" against each other.
//!   · the floor diff drops anything the deterministic scan already found, so the model can only ADD.

use crate::adapters::scan_file_keys;
use crate::key_ir::plausible_key_value;
use crate::learn::key_store::{cached_file_keys, persist_file_keys, KeyAdapter};
use crate::mask::MaskCtx;
use crate::types::KeyHit;
use once_cell::sync::Lazy;
use regex::Regex;
use seam_lang::{ast, node_kinds as nk, Ctx};
use sha1::{Digest, Sha1};
use std::collections::HashSet;

// COUPLING config (config.ts): the per-chunk and per-file snippet bounds.
const SNIPPET_CAP: usize = 8000;
const PER_FILE: usize = 4000;

fn sha1_hex(s: &str) -> String {
    let mut h = Sha1::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The content key a file's learned adapter is stored under — `<rel> <sha1(text)>`, so an EDIT invalidates
/// exactly that file's entry and nothing else.
pub fn content_key(file: &str, text: &str) -> String {
    format!("{file} {}", sha1_hex(text))
}

// a string literal as a CALL ARGUMENT — the syntactic tell of a string-keyed channel (queue/event/cache/route)
static ARG_STRING: Lazy<Regex> = Lazy::new(|| Regex::new(r#"[(,]\s*['"`]"#).unwrap());

/// FILE SNIPPET = the structural HEAD ⊕ the deep string-key windows.
///
/// The per-file pass infers couplings two ways: STRUCTURAL ones near the top (a model/controller declaration,
/// the imports) and STRING-KEYED ones at a call site with a literal argument, which can sit ANYWHERE. Taking
/// the first N bytes catches the first and truncates the second, so this always keeps the head AND adds a
/// window around each string-key site, dropping only the inert middle. Comment-masked, so a literal inside a
/// comment is not a site. Port of `candidatePassages`.
pub fn candidate_passages(text: &str, max_chars: usize, context: usize, head_chars: usize) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let masked = MaskCtx::new(text);
    let code = masked.comments();
    let mut sites: Vec<usize> = ARG_STRING.find_iter(code).map(|m| code[..m.start()].matches('\n').count()).collect();
    sites.sort_unstable();
    sites.dedup();

    // window 0 = the HEAD (structural context); later windows = string-key sites beyond it
    let (mut head_end, mut hc) = (0usize, 0usize);
    while head_end + 1 < lines.len() && hc < head_chars {
        hc += lines[head_end].len() + 1;
        head_end += 1;
    }
    let mut windows: Vec<(usize, usize)> = vec![(0, head_end)];
    for s in sites {
        let lo = s.saturating_sub(context);
        let hi = (s + context).min(lines.len().saturating_sub(1));
        let last = windows.last_mut().unwrap();
        if lo <= last.1 + 1 {
            last.1 = last.1.max(hi); // merge into the head / previous window
        } else {
            windows.push((lo, hi));
        }
    }
    let (mut out, mut size) = (String::new(), 0usize);
    for (lo, hi) in windows {
        let mut block = if lo > 0 { format!("… (line {})\n", lo + 1) } else { String::new() };
        block.push_str(&lines[lo..=hi.min(lines.len() - 1)].join("\n"));
        block.push('\n');
        if size + block.len() > max_chars && size > 0 {
            break;
        }
        size += block.len();
        out.push_str(&block);
    }
    out
}

/// The batched prompt — every file's snippet in one call, each analysed independently. Byte-identical to
/// `_batchPrompt` (the wording is the pass's contract with the model; drifting it silently changes recall).
pub fn batch_prompt(files: &[(String, String)]) -> String {
    let blocks: Vec<String> = files.iter().map(|(f, s)| format!("=== FILE: {f} ===\n{s}")).collect();
    format!(
        r#"You are finding DATA-FLOW couplings carried by a SHARED KEY — an identifier a file shares with
OTHER files that no import/call connects: a DB table, a queue/topic, an event name, a cache key, an HTTP
route path. NOT ordinary imports/calls. Analyse EACH file below independently.

{}

For every shared key with CONCRETE textual evidence, output one object. Do NOT invent keys — only ones
literally present. A wrong guess is worse than silence. The value MUST be a SPECIFIC IDENTIFIER (a
table/topic/event/route/cache name) — NEVER a common word, prose, a sentence fragment, or a generic token
like "the"/"data"/"value": a key that is not a distinctive name couples unrelated files by coincidence.
  file  — the FILE header path it came from
  kind  — db-table | queue | event | route | cache | key | egress (an outbound call to an EXTERNAL system —
          a 3rd-party HTTP API / broker the repo does NOT serve; TERMINAL, role always "produces", no consumer)
  value — the literal name (table/topic/event/route/cache-key string; for egress, the external host/service)
  role  — "produces" if the file WRITES/EMITS/PUBLISHES/CALLS-OUT it, "consumes" if it READS/SUBSCRIBES/HANDLES it

Return a JSON array (empty if none):
[{{"id":"k1","file":"<path>","kind":"db-table","value":"payments","role":"produces"}}]
"#,
        blocks.join("\n\n")
    )
}

/// Parse the model's array into per-file key hits, canonicalising the kind vocabulary and dropping anything
/// implausible. `line: 0` marks these as file-level facts, not located sites. Port of `_parseBatch`.
pub fn parse_batch(values: &[serde_json::Value]) -> Vec<(String, Vec<KeyHit>)> {
    let mut by_file: Vec<(String, Vec<KeyHit>)> = Vec::new();
    for obj in values {
        let Some(map) = obj.as_object() else { continue };
        let get = |k: &str| map.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let file = get("file");
        let kind = crate::key_ir::canon_kind(&get("kind"));
        let mut value = get("value");
        if file.is_empty() || kind.is_empty() || value.is_empty() {
            continue;
        }
        if kind == "http-route" {
            value = crate::adapters::http_route::norm_path(&value);
        }
        if !plausible_key_value(&value) {
            continue; // generic/prose values the model hallucinated as keys
        }
        let produces = get("role").to_lowercase().starts_with("produc");
        let hit = KeyHit { kind, value, line: 0, produces, ..Default::default() };
        match by_file.iter_mut().find(|(f, _)| *f == file) {
            Some((_, v)) => v.push(hit),
            None => by_file.push((file, vec![hit])),
        }
    }
    by_file
}

/// The class/method/function names DECLARED in the files the model was shown — the only symbols it can echo.
/// A real data key (a table/topic/event NAME) is not a code identifier defined in the source, so a proposed
/// key matching one of these is an echo, not a finding. Port of `_definedNames`.
pub fn defined_names(files: &[(String, String)]) -> HashSet<String> {
    let mut names = HashSet::new();
    for (file, text) in files {
        let Some(grammar) = seam_lang::grammar_for(file) else { continue };
        let Some(ctx) = Ctx::parse(text, &grammar) else { continue };
        for n in ctx.collect(ctx.root(), |k| nk::is_funclike(k) || nk::is_class_kind(k)) {
            if let Some(c) = ctx.children(n).into_iter().find(|c| nk::is_name_kind(c.kind())) {
                names.insert(ctx.text(c).to_string());
            }
        }
    }
    names
}

/// A learned per-file adapter's name + description. File-derived, not model-given: per-file facts don't
/// generalise like a rule, so a model-chosen name would imply a reusability that isn't there.
/// Port of `_keyAdapterMeta`.
pub fn key_adapter_meta(file: &str, keys: &[KeyHit]) -> (String, String) {
    let base = file.rsplit('/').next().unwrap_or(file);
    let base = base.rsplit_once('.').map(|(a, _)| a).unwrap_or(base);
    let raw = format!("{base}{}", keys.first().map(|k| format!("-{}", k.kind)).unwrap_or_default()).to_lowercase();
    let mut name: String = raw.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    while name.contains("--") {
        name = name.replace("--", "-");
    }
    let name = name.trim_matches('-').chars().take(48).collect::<String>();
    let description = if keys.is_empty() {
        "no keys".to_string()
    } else {
        keys.iter().take(4).map(|k| format!("{} {} {}", if k.produces { "produces" } else { "consumes" }, k.kind, k.value)).collect::<Vec<_>>().join("; ")
    };
    (name, description)
}

/// Synthesize keys for the given (uncached) files: chunk by snippet size, ONE model call per chunk, drop the
/// symbol echoes, persist each file's adapter. Returns file → keys. A failed pass yields empty for that chunk
/// — the caller keeps its floor. Port of `_batchSynthesize`.
pub fn batch_synthesize(repo: &str, files: &[(String, String)], model: Option<&str>, claude_bin: Option<&str>) -> Vec<(String, Vec<KeyHit>)> {
    let opts = seam_llm::PassOpts {
        model: model.map(String::from),
        tag: Some("discover-keys-batch".into()),
        thinking: Some(0),
        claude_bin: claude_bin.map(String::from),
    };
    let mut out: Vec<(String, Vec<KeyHit>)> = Vec::new();
    let mut chunk: Vec<(String, String)> = Vec::new(); // (file, snippet)
    let mut texts: Vec<(String, String)> = Vec::new(); // (file, full text) for the defined-names guard
    let mut size = 0usize;

    let mut flush = |chunk: &mut Vec<(String, String)>, texts: &mut Vec<(String, String)>, out: &mut Vec<(String, Vec<KeyHit>)>| {
        if chunk.is_empty() {
            return;
        }
        let prompt = batch_prompt(chunk);
        // WHETHER the pass answered is kept, not collapsed into "it found nothing". Persisting a `no keys`
        // adapter is a VERDICT — the content key is then cached and the file is never asked about again. Doing
        // that because the model was unreachable (no backend, a timeout, or a host bus still collecting
        // prompts) permanently blinds the repo to that file's coupling on the strength of a missing binary.
        // An empty ANSWER is a real verdict and still settles; an error does not.
        let answered = seam_llm::run_pass_json(&prompt, &opts);
        let by_file = match &answered {
            Ok(vals) => parse_batch(vals),
            Err(_) => Vec::new(), // a failed/malformed pass finds nothing; the floor still stands
        };
        let persist = answered.is_ok();
        let def_names = defined_names(texts);
        for (file, _) in chunk.iter() {
            let keys: Vec<KeyHit> = by_file
                .iter()
                .find(|(f, _)| f == file)
                .map(|(_, ks)| ks.iter().filter(|h| !def_names.contains(&h.value)).cloned().collect())
                .unwrap_or_default();
            let text = texts.iter().find(|(f, _)| f == file).map(|(_, t)| t.clone()).unwrap_or_default();
            if persist {
                let (name, description) = key_adapter_meta(file, &keys);
                persist_file_keys(repo, &content_key(file, &text), &KeyAdapter { name, description, keys: keys.clone() });
            }
            out.push((file.clone(), keys));
        }
        chunk.clear();
        texts.clear();
    };

    for (file, text) in files {
        let snippet = candidate_passages(text, PER_FILE, 3, 700);
        if size + snippet.len() > SNIPPET_CAP && !chunk.is_empty() {
            flush(&mut chunk, &mut texts, &mut out);
            size = 0;
        }
        size += snippet.len();
        chunk.push((file.clone(), snippet));
        texts.push((file.clone(), text.clone()));
    }
    flush(&mut chunk, &mut texts, &mut out);
    out
}

/// The keys the model proposes for ONE anchor file, MINUS everything its deterministic floor already found.
/// Cache-first: a known content key replays with no model call. Returns empty when there is nothing cached and
/// no LLM was requested — the caller then runs on the floor alone. Port of `anchorProposedKeys`.
pub fn anchor_proposed_keys(repo: &str, anchor_file: &str, text: &str, llm: bool, model: Option<&str>, claude_bin: Option<&str>) -> Vec<KeyHit> {
    let mask = MaskCtx::new(text);
    let floor: HashSet<String> = scan_file_keys(anchor_file, text, &mask).into_iter().map(|h| format!("{} {}", h.kind, h.value)).collect();
    let ck = content_key(anchor_file, text);
    let (hit, cached) = cached_file_keys(repo, &ck);
    let keys = if hit {
        cached
    } else if llm {
        batch_synthesize(repo, &[(anchor_file.to_string(), text.to_string())], model, claude_bin)
            .into_iter()
            .find(|(f, _)| f == anchor_file)
            .map(|(_, k)| k)
            .unwrap_or_default()
    } else {
        return Vec::new();
    };
    keys.into_iter().filter(|h| plausible_key_value(&h.value) && !floor.contains(&format!("{} {}", h.kind, h.value))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_snippet_keeps_the_head_and_the_deep_string_key_sites() {
        // a string-keyed call far past the head must survive — that recall hole is why this exists
        let mut text = String::from("import { q } from \"./q\";\nexport class Svc {\n");
        for i in 0..300 {
            text.push_str(&format!("  filler{i}() {{ return {i}; }}\n"));
        }
        text.push_str("  emit() { q.publish(\"orders.created\", 1); }\n}\n");
        let s = candidate_passages(&text, 4000, 3, 700);
        assert!(s.contains("import { q }"), "the structural head must be kept");
        assert!(s.contains("orders.created"), "a string-key site past the head must be kept");
        assert!(s.len() < text.len(), "the inert middle must be dropped");
    }

    #[test]
    fn a_code_symbol_echoed_as_a_key_is_dropped() {
        let files = vec![("src/a.ts".to_string(), "export class MessageBean { validateDocumentCount() { return 1; } }\n".to_string())];
        let names = defined_names(&files);
        assert!(names.contains("MessageBean"));
        assert!(names.contains("validateDocumentCount"));
    }

    #[test]
    fn parsing_drops_prose_and_canonicalises_the_kind() {
        // `endpoint` is an ALIAS of http-route (the model uses free vocabulary); `table` is NOT aliased — it
        // passes through unchanged on both engines, so asserting a db-table rewrite here would encode a
        // mapping neither side performs.
        let vals: Vec<serde_json::Value> = serde_json::from_str(
            r#"[{"file":"a.ts","kind":"endpoint","value":"/api/pay","role":"produces"},
                {"file":"a.ts","kind":"db-table","value":"the","role":"consumes"},
                {"file":"","kind":"db-table","value":"x","role":"produces"}]"#,
        )
        .unwrap();
        let by_file = parse_batch(&vals);
        assert_eq!(by_file.len(), 1);
        let (_, keys) = &by_file[0];
        assert_eq!(keys.len(), 1, "the prose value and the file-less row must both be dropped");
        assert_eq!(keys[0].kind, "http-route", "`endpoint` canonicalises to the registered kind");
        assert_eq!(keys[0].value, "/api/pay");
        assert!(keys[0].produces);
    }

    #[test]
    fn the_structural_head_is_always_sent() {
        // The head carries the class/model/controller context the ActiveRecord and route inference read off.
        // Dropping it to save tokens would leave the model a pile of attribute lines with nothing to key on.
        let text = format!("class Payment < ApplicationRecord\n{}end\n", "  attr_accessor :x\n".repeat(500));
        let p = candidate_passages(&text, 12000, 3, 700);
        assert!(p.contains("class Payment"), "the head must survive");
        assert!(p.len() < text.len(), "the big inert middle must not be sent");
    }

    #[test]
    fn a_literal_in_a_comment_past_the_head_opens_no_window() {
        // A commented-out key is not a key. Opening a window on it spends tokens AND invites the model to
        // propose a channel the code does not touch — a fabricated edge from a dead line.
        let head = "const x = 1;\n".repeat(70); // > 700 chars → the head ends before the lines below
        let text = format!(
            "{head}{}// bus.emit('commented') marker\n{}bus.emit('real-key');\n",
            "const filler = 0;\n".repeat(40),
            "const z = 0;\n".repeat(40)
        );
        let p = candidate_passages(&text, 20000, 3, 700);
        assert!(p.contains("real-key"), "a real deep site gets a window");
        assert!(!p.contains("commented"), "a commented literal past the head is masked");
    }

    #[test]
    fn many_blind_files_cost_one_call_not_one_each() {
        let _g = crate::learn::GLOBAL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // The batching is the whole economics of the per-file axis: N floor-blind files must cost ONE model
        // call while they fit the snippet cap, not N. A regression here is invisible in the OUTPUT — the keys
        // are identical either way — and shows up only as a bill.
        let dir = std::env::temp_dir().join(format!("seam-batch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = dir.to_string_lossy().to_string();
        let files: Vec<(String, String)> = (0..3)
            .map(|i| (format!("f{i}.ts"), format!("export const r{i} = () => cache{i}.read('k{i}');\n")))
            .collect();

        let mut answers: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut prompts: Vec<String> = Vec::new();
        for _ in 0..3 {
            seam_llm::host_bus::install(answers.clone());
            batch_synthesize(&repo, &files, None, None);
            let recorded = seam_llm::host_bus::take_recorded();
            if recorded.is_empty() {
                break;
            }
            for r in recorded {
                prompts.push(r.prompt.clone());
                answers.insert(r.key, "[]".to_string());
            }
        }
        seam_llm::host_bus::uninstall();

        assert_eq!(prompts.len(), 1, "three files, one call — got {} prompts", prompts.len());
        for i in 0..3 {
            assert!(prompts[0].contains(&format!("f{i}.ts")), "every file must be in the one prompt");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_adapter_name_is_file_derived_and_slug_safe() {
        let keys = vec![KeyHit { kind: "db-table".into(), value: "payments".into(), produces: true, ..Default::default() }];
        let (name, desc) = key_adapter_meta("src/api/Payment_Repo.ts", &keys);
        assert_eq!(name, "payment-repo-db-table");
        assert_eq!(desc, "produces db-table payments");
    }
}
