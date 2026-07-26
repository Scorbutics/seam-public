//! THE LLM TRANSPORT — the core's own backend client. Port of `ts/src/core/llm.ts`.
//!
//! The flywheel (learn-once → cache → replay deterministically) lives in `seam-couple`, and the ONE step it
//! could not perform itself was the model call, which is why every learn axis used to be driven from the JS
//! shell. This crate closes that: the Rust core resolves a backend, runs a pass, and parses the reply on its
//! own, so the flywheel is self-contained and a caller needs no JS at all to turn it.
//!
//! FAILURE IS A DEGRADE, NOT A CRASH — every entry point returns `Result`, and each caller's contract is to
//! fall back to its DETERMINISTIC floor when a pass fails (backend missing, non-zero exit, unparseable reply,
//! timeout). That is what makes the flywheel safe to run anywhere: the answer is never worse than the floor,
//! it just misses what the model would have added.

use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The one error type — every failure mode collapses to this, because every caller treats them identically
/// (degrade to the floor). Mirrors `ClassifierError`.
#[derive(Debug, Clone)]
pub struct LlmError(pub String);

impl std::fmt::Display for LlmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for LlmError {}

type R<T> = Result<T, LlmError>;

fn err<T>(msg: impl Into<String>) -> R<T> {
    Err(LlmError(msg.into()))
}

// ── pass registry ────────────────────────────────────────────────────────────────────────────────────────
/// A pass's TIER. `strong` passes are model-routed up from a weak base; `cheap` ones run as asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    Cheap,
    Strong,
}

/// The registry, mirroring the TS `registerPass` call sites (which register at module load). Rust has no
/// module-load side effects to hook, so the tags are declared here — the SAME table, in one place. A tag that
/// is absent is treated as `cheap`, exactly as an unregistered tag is on the TS side.
static PASSES: Lazy<HashMap<&'static str, Tier>> = Lazy::new(|| {
    use Tier::*;
    HashMap::from([
        ("affinity", Cheap), ("anchor-judge", Strong), ("carrier-synthesis-batch", Strong),
        ("center-dir-pick", Strong), ("center-pick", Strong), ("classify-annotations", Strong),
        ("classify-receivers", Strong), ("cluster", Cheap), ("compose-subresource-route", Strong),
        ("discover", Cheap), ("discover-key-matchers", Strong), ("discover-keys-batch", Strong),
        ("expand", Cheap), ("label-clusters", Cheap), ("reconcile", Cheap), ("reconcile-roles", Cheap),
        ("review-triage", Strong), ("role", Cheap), ("shape-route", Strong), ("wire", Cheap),
    ])
});

pub fn tier_of(tag: &str) -> Tier {
    PASSES.get(tag).copied().unwrap_or(Tier::Cheap)
}

fn strong_model() -> String {
    std::env::var("SEAM_STRONG_MODEL").unwrap_or_else(|_| "claude-sonnet-4-6".to_string())
}

/// UPGRADE-ONLY model routing: a `strong` pass on a haiku base is lifted to the strong tier; a sonnet/opus
/// base is left alone (never downgraded) and a `cheap`/unknown tag is untouched. Applied at the single run
/// choke point, so it covers every caller and is idempotent. `SEAM_STRONG_MODEL=""` disables it.
/// Port of `_route_model`.
pub fn route_model(tag: Option<&str>, base: &str) -> String {
    let strong = strong_model();
    if strong.is_empty() || tag.map(tier_of) != Some(Tier::Strong) {
        return base.to_string();
    }
    if base.to_lowercase().contains("haiku") { strong } else { base.to_string() }
}

// ── backend location ─────────────────────────────────────────────────────────────────────────────────────
const VSCODE_EXT_GLOB_PREFIX: &str = "anthropic.claude-code-";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    Claude,
    Copilot,
}

impl Backend {
    pub fn as_str(self) -> &'static str {
        match self {
            Backend::Claude => "claude",
            Backend::Copilot => "copilot",
        }
    }
}

fn is_file(p: &str) -> bool {
    Path::new(p).is_file()
}

fn which(bin: &str) -> Option<String> {
    let out = std::process::Command::new(if cfg!(windows) { "where" } else { "which" }).arg(bin).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let first = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim().to_string();
    (!first.is_empty()).then_some(first)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME").ok().or_else(|| std::env::var("USERPROFILE").ok()).map(PathBuf::from)
}

/// `CLAUDE_BIN` → PATH → the newest VS Code extension's bundled binary. Port of `_locate_claude`.
fn locate_claude() -> Option<String> {
    if let Ok(env) = std::env::var("CLAUDE_BIN") {
        if is_file(&env) {
            return Some(env);
        }
    }
    if let Some(p) = which("claude") {
        return Some(p);
    }
    let ext_dir = home_dir()?.join(".vscode").join("extensions");
    let mut matches: Vec<String> = std::fs::read_dir(&ext_dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with(VSCODE_EXT_GLOB_PREFIX))
        .map(|e| e.path().join("resources").join("native-binary").join("claude").to_string_lossy().into_owned())
        .filter(|p| is_file(p))
        .collect();
    matches.sort();
    matches.pop() // the highest-sorting version
}

fn locate_copilot() -> Option<String> {
    if let Ok(env) = std::env::var("COPILOT_BIN") {
        if is_file(&env) {
            return Some(env);
        }
    }
    which("copilot")
}

/// The backend to use: an explicit override (which must EXIST — a typo'd path is an error, never a silent
/// fallback), else claude, else copilot. Port of `resolve_backend`.
pub fn resolve_backend(claude_override: Option<&str>) -> R<(Backend, String)> {
    if let Some(o) = claude_override.filter(|s| !s.is_empty()) {
        return if is_file(o) { Ok((Backend::Claude, o.to_string())) } else { err(format!("--claude-bin not found: {o}")) };
    }
    if let Some(c) = locate_claude() {
        return Ok((Backend::Claude, c));
    }
    if let Some(c) = locate_copilot() {
        return Ok((Backend::Copilot, c));
    }
    err("Could not find an LLM CLI. Install the `claude` CLI (Claude Code subscription) or the \
         GitHub `copilot` CLI, put one on PATH, or set CLAUDE_BIN / COPILOT_BIN.")
}

/// Is a backend reachable at all? The gate every flywheel axis checks before spending a cold pass.
pub fn available(claude_override: Option<&str>) -> bool {
    resolve_backend(claude_override).is_ok()
}

// ── JSON-array extraction ────────────────────────────────────────────────────────────────────────────────
/// The model's reply → a JSON array: the bare value, else a ```-fenced block, else the LONGEST bracketed span
/// that parses. Longest-first because a reply that narrates around its answer often contains short bracketed
/// fragments (`[0, 1]` in prose) that would otherwise win. Port of `extractJsonArray`.
pub fn extract_json_array(text: &str) -> R<Vec<serde_json::Value>> {
    let mut t = text.trim();
    let stripped;
    if t.starts_with("```") {
        let after = t.trim_start_matches("```");
        let after = after.strip_prefix("json").unwrap_or(after);
        stripped = after.trim_start().trim_end_matches("```").trim().to_string();
        t = &stripped;
    }
    if let Ok(serde_json::Value::Array(v)) = serde_json::from_str::<serde_json::Value>(t) {
        return Ok(v);
    }
    // every `[`…`]` span, longest first
    let bytes = t.as_bytes();
    let opens: Vec<usize> = bytes.iter().enumerate().filter(|(_, c)| **c == b'[').map(|(i, _)| i).collect();
    let closes: Vec<usize> = bytes.iter().enumerate().filter(|(_, c)| **c == b']').map(|(i, _)| i).collect();
    let mut spans: Vec<(usize, usize)> = Vec::new();
    for &o in &opens {
        for &c in closes.iter().rev() {
            if c > o {
                spans.push((o, c + 1));
            }
        }
    }
    spans.sort_by_key(|(o, c)| std::cmp::Reverse(c - o));
    for (o, c) in spans {
        if let Some(sub) = t.get(o..c) {
            if let Ok(serde_json::Value::Array(v)) = serde_json::from_str::<serde_json::Value>(sub) {
                return Ok(v);
            }
        }
    }
    err(format!("No JSON array in model reply: {:?}", &t.chars().take(200).collect::<String>()))
}

// ── usage metering ───────────────────────────────────────────────────────────────────────────────────────
/// What the flywheel SPENT this process — so a caller can report the cost of a cold run. Mirrors `UsageMeter`.
#[derive(Clone, Debug, Default)]
pub struct Usage {
    pub calls: usize,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub duration_ms: u64,
}

static USAGE: Lazy<Mutex<Usage>> = Lazy::new(|| Mutex::new(Usage::default()));

pub fn get_usage() -> Usage {
    USAGE.lock().unwrap().clone()
}
pub fn reset_usage() {
    *USAGE.lock().unwrap() = Usage::default();
}

// ── running a pass ───────────────────────────────────────────────────────────────────────────────────────
struct ProcResult {
    status: i32,
    stdout: String,
    stderr: String,
}

/// HANG GUARD — a per-call wall-clock ceiling. Without it a stalled backend (a rate-limited CLI, a wedged
/// local model) blocks the pipeline FOREVER: the pass cannot fail, so the caller never reaches its floor.
/// On timeout the child is KILLED and the non-zero status degrades the pass, exactly like any other failure.
fn timeout_ms() -> u64 {
    std::env::var("SEAM_LLM_TIMEOUT_MS").ok().and_then(|v| v.parse::<u64>().ok()).filter(|v| *v > 0).unwrap_or(180_000).max(100)
}

fn spawn_capture(bin: &str, args: &[String], input: Option<&str>, env: &[(String, String)]) -> R<ProcResult> {
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(bin);
    cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| LlmError(format!("failed to spawn {bin}: {e}")))?;
    if let Some(text) = input {
        // Write on a thread: a large prompt can exceed the pipe buffer, and the child may not drain it until
        // it has started producing output — writing inline would deadlock.
        let mut stdin = child.stdin.take().unwrap();
        let owned = text.to_string();
        std::thread::spawn(move || {
            let _ = stdin.write_all(owned.as_bytes());
        });
    } else {
        drop(child.stdin.take());
    }
    let deadline = Instant::now() + Duration::from_millis(timeout_ms());
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return err(format!("{bin} timed out after {}ms", timeout_ms()));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return err(format!("{bin} wait failed: {e}")),
        }
    }
    let out = child.wait_with_output().map_err(|e| LlmError(format!("{bin} output failed: {e}")))?;
    Ok(ProcResult {
        status: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

fn claude_args(model: &str) -> Vec<String> {
    ["-p", "--output-format", "json", "--model", model, "--strict-mcp-config"].iter().map(|s| s.to_string()).collect()
}

fn parse_claude(p: &ProcResult) -> R<String> {
    if p.status != 0 {
        return err(format!("claude CLI failed (exit {}): {}", p.status, p.stderr.trim().chars().take(300).collect::<String>()));
    }
    let envelope: serde_json::Value = serde_json::from_str(&p.stdout)
        .map_err(|_| LlmError(format!("claude CLI did not return JSON: {:?}", p.stdout.chars().take(200).collect::<String>())))?;
    if envelope.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false) {
        return err(format!("claude CLI reported error: {}", envelope.get("result").and_then(|v| v.as_str()).unwrap_or("")));
    }
    {
        let mut u = USAGE.lock().unwrap();
        u.calls += 1;
        if let Some(usage) = envelope.get("usage") {
            u.input_tokens += usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            u.output_tokens += usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        }
        u.cost_usd += envelope.get("total_cost_usd").and_then(|v| v.as_f64()).unwrap_or(0.0);
        u.duration_ms += envelope.get("duration_ms").and_then(|v| v.as_u64()).unwrap_or(0);
    }
    Ok(envelope.get("result").and_then(|v| v.as_str()).unwrap_or("").to_string())
}

/// `thinking` tokens → copilot's `--effort`. `COPILOT_EFFORT` overrides ("off"/"none"/"" disables the flag).
/// Port of `_thinking_to_effort`.
fn thinking_to_effort(thinking: Option<i64>) -> Option<String> {
    if let Ok(o) = std::env::var("COPILOT_EFFORT") {
        let level = o.trim().to_lowercase();
        return if matches!(level.as_str(), "off" | "none" | "") { None } else { Some(level) };
    }
    match thinking {
        None => Some("high".into()),
        Some(0) => Some("low".into()),
        Some(_) => Some("medium".into()),
    }
}

// copilot has no `--strict-mcp-config`, so a plain `copilot -p` boots the user's FULL MCP config on EVERY pass
// — every server reconnected per call, including Seam's OWN MCP server (a recursion hazard). The only lever it
// exposes is `--config-dir`, so point it at a scratch dir that SHADOWS mcp-config.json with `{}` while
// SYMLINKING the auth/settings FILES through, so login keeps working in every auth mode. Best-effort: any
// failure → no flag → the un-isolated call, rather than risk breaking auth. `SEAM_COPILOT_ISOLATE=0` disables.
static COPILOT_CFG_DIR: Lazy<Option<String>> = Lazy::new(|| {
    let off = std::env::var("SEAM_COPILOT_ISOLATE").unwrap_or_default().trim().to_lowercase();
    if matches!(off.as_str(), "0" | "off" | "false" | "no") {
        return None;
    }
    let src = std::env::var("COPILOT_CONFIG_DIR").ok().map(PathBuf::from).or_else(|| home_dir().map(|h| h.join(".copilot")))?;
    let iso = std::env::temp_dir().join(format!("seam-copilot-cfg-{}", std::process::id()));
    std::fs::create_dir_all(&iso).ok()?;
    if let Ok(entries) = std::fs::read_dir(&src) {
        for e in entries.flatten() {
            let name = e.file_name();
            if name == "mcp-config.json" || !e.path().is_file() {
                continue;
            }
            #[cfg(unix)]
            let _ = std::os::unix::fs::symlink(e.path(), iso.join(&name));
        }
    }
    std::fs::write(iso.join("mcp-config.json"), "{}").ok()?; // shadow the user's MCP servers (incl. Seam itself)
    Some(iso.to_string_lossy().into_owned())
});

fn copilot_args(prompt_path: &str, thinking: Option<i64>) -> Vec<String> {
    let pointer = format!(
        "Read the file {prompt_path} and follow the instructions it contains exactly. Output only what those instructions ask for."
    );
    let mut cmd: Vec<String> = vec!["-p".into(), pointer, "-s".into(), "--no-ask-user".into(), "--allow-all-tools".into()];
    if let Some(dir) = COPILOT_CFG_DIR.as_ref() {
        cmd.push("--config-dir".into());
        cmd.push(dir.clone());
    }
    if let Ok(m) = std::env::var("COPILOT_MODEL") {
        cmd.push("--model".into());
        cmd.push(m);
    }
    if let Some(e) = thinking_to_effort(thinking) {
        cmd.push("--effort".into());
        cmd.push(e);
    }
    cmd
}

fn parse_copilot(p: &ProcResult) -> R<String> {
    if p.status != 0 {
        return err(format!("copilot CLI failed (exit {}): {}", p.status, p.stderr.trim().chars().take(300).collect::<String>()));
    }
    if p.stdout.trim().is_empty() {
        return err(format!("copilot CLI returned no output: {:?}", p.stderr.trim().chars().take(200).collect::<String>()));
    }
    Ok(p.stdout.clone())
}

/// One pass's knobs. `model` defaults to the cheap tier; `tag` selects the tier routing; `thinking` is the
/// claude thinking-token budget (`Some(0)` = thinking OFF, the flywheel's default — these are mechanical
/// extraction passes, not reasoning ones).
#[derive(Clone, Debug, Default)]
pub struct PassOpts {
    pub model: Option<String>,
    pub tag: Option<String>,
    pub thinking: Option<i64>,
    pub claude_bin: Option<String>,
}

/// Run one pass and return the model's raw text. THE choke point: backend resolution, tier routing, spawn,
/// timeout, envelope parsing and metering all happen here, so every flywheel axis gets identical behaviour.
/// Port of `run_pass` + `runPassRaw`.
pub fn run_pass(prompt: &str, opts: &PassOpts) -> R<String> {
    let (backend, bin) = resolve_backend(opts.claude_bin.as_deref())?;
    let base = opts.model.clone().unwrap_or_else(|| "claude-haiku-4-5".to_string());
    let model = route_model(opts.tag.as_deref(), &base);
    let thinking = opts.thinking.or(Some(0));
    match backend {
        Backend::Claude => {
            let env: Vec<(String, String)> = thinking.map(|t| vec![("MAX_THINKING_TOKENS".to_string(), t.to_string())]).unwrap_or_default();
            parse_claude(&spawn_capture(&bin, &claude_args(&model), Some(prompt), &env)?)
        }
        Backend::Copilot => {
            // copilot reads the prompt from a FILE — it can exceed argv limits.
            let dir = std::env::temp_dir().join(format!("seam-copilot-prompt-{}-{:?}", std::process::id(), std::thread::current().id()));
            std::fs::create_dir_all(&dir).map_err(|e| LlmError(format!("prompt dir: {e}")))?;
            let path = dir.join("prompt.txt");
            std::fs::write(&path, prompt).map_err(|e| LlmError(format!("prompt write: {e}")))?;
            let out = spawn_capture(&bin, &copilot_args(&path.to_string_lossy(), thinking), None, &[]);
            let _ = std::fs::remove_file(&path);
            parse_copilot(&out?)
        }
    }
}

/// `run_pass` → a JSON array, the shape every flywheel pass asks for.
pub fn run_pass_json(prompt: &str, opts: &PassOpts) -> R<Vec<serde_json::Value>> {
    extract_json_array(&run_pass(prompt, opts)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_a_bare_array() {
        assert_eq!(extract_json_array("[1, 2]").unwrap().len(), 2);
    }

    #[test]
    fn extracts_a_fenced_array() {
        assert_eq!(extract_json_array("```json\n[{\"a\":1}]\n```").unwrap().len(), 1);
    }

    #[test]
    fn prefers_the_longest_bracketed_span_over_a_prose_fragment() {
        // the short `[0, 1]` in the narration must not win over the real answer
        let reply = "I checked rows [0, 1] and concluded:\n[{\"kind\":\"db-table\",\"value\":\"booking\"}]";
        let v = extract_json_array(reply).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].get("value").and_then(|x| x.as_str()), Some("booking"));
    }

    #[test]
    fn a_reply_with_no_array_is_an_error_not_an_empty_answer() {
        assert!(extract_json_array("I could not determine any keys.").is_err());
    }

    #[test]
    fn routing_upgrades_only_a_weak_base_on_a_strong_tag() {
        std::env::set_var("SEAM_STRONG_MODEL", "claude-sonnet-4-6");
        assert_eq!(route_model(Some("classify-receivers"), "claude-haiku-4-5"), "claude-sonnet-4-6");
        assert_eq!(route_model(Some("classify-receivers"), "claude-opus-4-1"), "claude-opus-4-1"); // never downgrade
        assert_eq!(route_model(Some("cluster"), "claude-haiku-4-5"), "claude-haiku-4-5"); // cheap tag untouched
        assert_eq!(route_model(None, "claude-haiku-4-5"), "claude-haiku-4-5");
    }
}
