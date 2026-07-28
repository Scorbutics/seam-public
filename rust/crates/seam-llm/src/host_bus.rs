//! THE HOST BUS — serving a pass from the CALLER's model instead of a spawned binary.
//!
//! When the caller already has a model (a Claude Code skill, the VS Code extension, an MCP client that
//! supports sampling), the engine should borrow it rather than spawn a second one: no API key, no duplicate
//! subscription, and in the editor's case the user's own configured model. TypeScript has always had this —
//! `set_host_bus(...)` and `--emit-prompts` / `--inject-llm`. The Rust core did not, so every pass it owned
//! was reachable ONLY through a local `claude`/`copilot` binary, and an injected model was invisible to it.
//!
//! WHY THIS IS RECORD-AND-REPLAY AND NOT A CALLBACK. The JavaScript thread is BLOCKED inside the synchronous
//! napi call for the whole time the core runs. A callback into JS — a threadsafe function, a `Ref<JsFunction>`,
//! anything — would queue work onto an event loop that cannot turn until the core returns. That is a deadlock,
//! not a slow path, and it would present as a hang with no error. So the core RECORDS the prompts it wants and
//! returns; the caller serves them with its own model and calls back in with the answers; the core re-runs and
//! this time the answers are there. Rounds repeat while new prompts appear — which is what makes an ITERATIVE
//! pass work, where round N's prompt depends on round N-1's answer.
//!
//! Answers are keyed by a CONTENT HASH of `(tag, prompt)`, not by call order. Order-keying would silently
//! misalign the moment a round-1 side effect changed round 2's call sequence, and the failure would be a
//! plausible-looking wrong answer rather than a crash. Content-keying makes a changed prompt simply a new
//! question, asked in the next round.
//!
//! A recorded-but-unanswered pass returns an ERROR, deliberately — not an empty array. Every flywheel caller
//! treats an error as "no backend" and persists nothing, whereas an empty array is a real verdict ("not a
//! carrier", "no keys here") that would be cached and never re-asked. Round 1 must leave no trace.

use crate::{LlmError, R};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Mutex;

/// One pass the core wanted to run and could not answer from the supplied answers.
#[derive(Clone, Debug)]
pub struct RecordedPass {
    /// content hash of `(tag, prompt)` — the key the answer must come back under
    pub key: String,
    pub tag: String,
    pub prompt: String,
    /// the model the core WOULD have used (after tier routing) — the host may honour or ignore it
    pub model: String,
    pub thinking: Option<i64>,
}

#[derive(Default)]
struct BusState {
    answers: HashMap<String, String>,
    /// insertion-ordered, deduped by key — the caller serves these in the order the core asked
    recorded: Vec<RecordedPass>,
}

static BUS: Lazy<Mutex<Option<BusState>>> = Lazy::new(|| Mutex::new(None));

/// `sha1(tag \u{1} prompt)` — cheap, stable, and collision-resistant enough for a within-run key.
pub fn pass_key(tag: &str, prompt: &str) -> String {
    use sha1::{Digest, Sha1};
    let mut h = Sha1::new();
    h.update(tag.as_bytes());
    h.update([0x01]);
    h.update(prompt.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Install the bus with the answers gathered so far. Clears anything recorded by a previous round — the
/// caller has just consumed it.
pub fn install(answers: HashMap<String, String>) {
    *BUS.lock().unwrap() = Some(BusState { answers, recorded: Vec::new() });
}

/// Remove the bus. The core goes back to spawning a local binary (or to having no backend at all).
pub fn uninstall() {
    *BUS.lock().unwrap() = None;
}

/// Is a host bus serving passes right now? `available()` consults this: with a bus installed there IS a
/// backend, even with no `claude`/`copilot` on PATH — and a flywheel axis that checked only for a binary
/// would skip its work while a perfectly good model was waiting.
pub fn active() -> bool {
    BUS.lock().unwrap().is_some()
}

/// Take everything recorded this round, leaving the bus installed and empty.
pub fn take_recorded() -> Vec<RecordedPass> {
    let mut g = BUS.lock().unwrap();
    match g.as_mut() {
        Some(s) => std::mem::take(&mut s.recorded),
        None => Vec::new(),
    }
}

/// Serve one pass from the bus, if one is installed. `None` = no bus (the caller spawns a binary as before);
/// `Some(Ok(text))` = answered; `Some(Err(..))` = recorded, ask again next round.
pub fn serve(tag: &str, prompt: &str, model: &str, thinking: Option<i64>) -> Option<R<String>> {
    let mut g = BUS.lock().unwrap();
    let s = g.as_mut()?;
    let key = pass_key(tag, prompt);
    if let Some(answer) = s.answers.get(&key) {
        return Some(Ok(answer.clone()));
    }
    if !s.recorded.iter().any(|r| r.key == key) {
        s.recorded.push(RecordedPass {
            key,
            tag: tag.to_string(),
            prompt: prompt.to_string(),
            model: model.to_string(),
            thinking,
        });
    }
    Some(Err(LlmError("host bus: prompt recorded, awaiting the caller's answer".into())))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The bus is process-global, so these run as ONE test rather than racing each other under the parallel
    // runner — a shared global split across #[test]s is a flake generator.
    #[test]
    fn records_then_replays_by_content() {
        uninstall();
        assert!(serve("t", "p", "m", None).is_none(), "no bus installed → the caller spawns a binary");

        install(HashMap::new());
        assert!(active());
        // First ask: recorded, and ERRORS rather than answering "[]" — an empty array is a verdict, and a
        // verdict cached from a round that never reached a model is how the wheel learns a lie.
        assert!(serve("discover-keys-batch", "PROMPT A", "haiku", Some(0)).unwrap().is_err());
        // Asking again in the SAME round must not double-record it.
        assert!(serve("discover-keys-batch", "PROMPT A", "haiku", Some(0)).unwrap().is_err());
        let rec = take_recorded();
        assert_eq!(rec.len(), 1);
        assert_eq!(rec[0].tag, "discover-keys-batch");
        assert_eq!(rec[0].prompt, "PROMPT A");
        assert_eq!(rec[0].thinking, Some(0));
        assert!(take_recorded().is_empty(), "taking twice must not re-yield");

        // Round 2: the answer comes back under the content key.
        install(HashMap::from([(rec[0].key.clone(), "[{\"id\":\"k1\"}]".to_string())]));
        assert_eq!(serve("discover-keys-batch", "PROMPT A", "haiku", Some(0)).unwrap().unwrap(), "[{\"id\":\"k1\"}]");
        assert!(take_recorded().is_empty(), "an ANSWERED pass is not re-recorded");

        // A different prompt under the SAME tag is a different question — the batching passes chunk, so
        // tag-keying (which is what the TypeScript `answers` map does) would give every chunk chunk one's reply.
        assert!(serve("discover-keys-batch", "PROMPT B", "haiku", Some(0)).unwrap().is_err());
        assert_eq!(take_recorded().len(), 1);

        uninstall();
        assert!(!active());
        assert!(serve("t", "p", "m", None).is_none());
    }
}
