//! THE P3 GATE — "is the repo-wide grounding pass (and the LLM flywheel behind it) worth running at all?"
//!
//! The pass only earns its keep when the anchor's span TOUCHES a coupling boundary: only then is there an
//! other side to find. So probe LOCALLY first — floor keys, a JPA persistence-wrapper write, param sites,
//! http I/O, an SDK resource route, the handler-file recall net, then the learned matchers. No key ⇒ skip
//! the whole repo-wide pass. That is what makes "grow from the diff" cheap: a change touching no DB/route/
//! queue/event pays ~nothing.
//!
//! `footprint_touches_boundary` folds the same gate over a floor pre-grown FOOTPRINT's nodes. The TS engine
//! drove the flywheel lazily from `resolveCoupling`, so the per-anchor gate decided it there; the Rust
//! middle runs the flywheel UP FRONT (learn-once, then the grow replays), so it has no per-anchor site to
//! gate at. The footprint's nodes ARE the anchors the lazy path would have gated. Same grounded signals,
//! same bypasses, one text read per file. Port of `footprintTouchesBoundary` + `_gateTouchesBoundary`.
//!
//! ONE deliberate narrowing against the TS original: the per-anchor LLM fallback (`anchorProposedKeys`) is
//! NOT ported. It was reachable only when `ctx.footprintFiles` was unset, and this entry point is the
//! footprint driver — it always sets it. Porting a branch its only caller cannot reach would be porting a
//! claim we cannot test.

use crate::adapters::scan_file_keys;
use crate::ground::const_keys::scan_param_sites;
use crate::ground::jpa_wrapper::{jpa_manager_index, jpa_wrapper_keys};
use crate::mask::MaskCtx;
use once_cell::sync::Lazy;
use regex::Regex;

/// Handler/controller-file recall net (SIGNAL #5), driven by each language's registered convention plus a
/// residual for stacks with no provider yet (C#, PHP, Go). A RECALL net, NOT a meaning judgement: the purest
/// implicit keys (a Rails `resources` route, a controller's convention route) have NO key literal to ground a
/// deterministic signal on, so the file's handler SHAPE is the only cheap signal it might carry a deducible
/// boundary. Deliberately broad — a false positive costs one extra probe. Port of `isHandlerFileByLanguage`.
// The union of every language provider's `handlerFileConvention` plus the residual for stacks with no
// provider (C#, PHP, Go). Read off the REGISTRY at runtime rather than transcribed from the source — the
// TypeScript entry (`^route.(ts|js)$`, the Next app-router file) is anchored at the basename start, and a
// hand-copied version of this set silently lost it.
static HANDLER_BASENAME: Lazy<Regex> = Lazy::new(|| {
    Regex::new(concat!(
        r"^route\.(?:ts|js)$",
        r"|(?:controller\.(?:ts|js|py|java|kt|cs|php)",
        r"|resource\.java",
        r"|\.handler\.(?:ts|js)",
        r"|_controller\.rb",
        r"|_handler\.go)$",
    ))
    .unwrap()
});

const HANDLER_DIRS: &[&str] = &["controllers", "controller", "handlers", "routes", "endpoints", "resolvers", "webhooks"];

/// Port of `_handlerShaped`.
pub fn handler_shaped(file: &str) -> bool {
    let lower = file.to_lowercase();
    let segs: Vec<&str> = lower.split('/').collect();
    if segs.iter().any(|s| HANDLER_DIRS.contains(s)) {
        return true;
    }
    segs.last().map(|b| HANDLER_BASENAME.is_match(b)).unwrap_or(false)
}

fn env_is(key: &str, val: &str) -> bool {
    std::env::var(key).as_deref() == Ok(val)
}

/// Does `[lo,hi]` of `file` touch a coupling boundary? Port of `_gateTouchesBoundary` on the FOOTPRINT path
/// (`footprint = true`, `stableFloor = false`).
fn gate_touches_boundary(repo: &str, file: &str, text: &str, lo: usize, hi: usize) -> bool {
    if crate::carrier::engine::carrier_provider_for(file).is_some() {
        return true; // carrier (Ruby) coupling isn't span-local
    }
    let in_span = |line: usize| line >= lo && line <= hi;

    let mask = MaskCtx::new(text);
    if scan_file_keys(file, text, &mask).iter().any(|h| in_span(h.line)) {
        return true; // 1 — floor keys
    }
    // 1b — a JPA persistence-wrapper write in the span (`mgr.customSave(entity)`)
    if file.ends_with(".java") {
        let jm = jpa_manager_index(repo);
        if !jm.managers.is_empty() && !jm.entities.is_empty() && jpa_wrapper_keys(text, &jm).iter().any(|h| in_span(h.line)) {
            return true;
        }
    }
    // 3 — getParameter(CONST)/addParameter(CONST) sites. NOTE the RAW text: the floor scan masks comments
    // first, this gate does not. Preserved deliberately — the gate is a recall net, so the more permissive
    // reading is the safe direction, and silently tightening it here would skip flywheel runs the TS engine did.
    let mut sites = Vec::new();
    scan_param_sites(text, file, &mut sites);
    if sites.iter().any(|s| in_span(s.line)) {
        return true;
    }
    // 2 — http I/O through a deduced custom client
    if crate::learn::resolve_http_call_sites(file, text, &crate::apply::effect_clients(repo)).iter().any(|h| in_span(h.line)) {
        return true;
    }
    // 2b — an SDK resource method inheriting its class base route (the `create@N` route lives here, not the span floor)
    if crate::apply::resource_routes::resolve_resource_routes(file, text).iter().any(|h| in_span(h.line)) {
        return true;
    }
    if handler_shaped(file) {
        return true; // 5 — route/handler file (the implicit-key recall net)
    }
    // 4 — learned matchers
    crate::learn::matchers::load_matchers(repo).iter().any(|m| crate::learn::matchers::run_matcher_at(m, file, text).iter().any(|h| in_span(h.line)))
}

/// Does ANY node of a (floor pre-grown) footprint touch a coupling boundary? `nodes` = `(file, range)`; an
/// absent range means the whole file. One text read per file, first hit wins.
pub fn footprint_touches_boundary(repo: &str, nodes: &[(String, Option<(usize, usize)>)]) -> bool {
    let mut texts: std::collections::HashMap<String, Option<String>> = std::collections::HashMap::new();
    for (file, range) in nodes {
        let text = texts
            .entry(file.clone())
            .or_insert_with(|| std::fs::read(format!("{repo}/{file}")).ok().map(|b| String::from_utf8_lossy(&b).into_owned()));
        let Some(text) = text.clone() else { continue };
        let (lo, hi) = range.unwrap_or((0, text.lines().count()));
        if gate_touches_boundary(repo, file, &text, lo, hi) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handler_shaped_reads_the_directory_convention_and_the_basename_convention() {
        assert!(handler_shaped("app/controllers/users.rb"));
        assert!(handler_shaped("src/routes/index.ts"));
        assert!(handler_shaped("com/acme/UserController.java"));
        assert!(handler_shaped("src/payments/payments.controller.ts")); // NestJS
        assert!(handler_shaped("app/api/admin/payments/route.ts")); // Next app-router (basename-anchored)
        assert!(handler_shaped("src/webhooks/stripe.handler.ts"));
        assert!(handler_shaped("src/hooks/stripe.handler.ts")); // handler-suffixed, no handler DIRECTORY
        assert!(handler_shaped("app/users_controller.rb"));
        assert!(handler_shaped("api/order_handler.go"));
        assert!(!handler_shaped("src/lib/util.ts"));
        assert!(!handler_shaped("src/lib/reroute.ts")); // `route.ts` is basename-ANCHORED, not a suffix
        assert!(!handler_shaped("src/models/user.rb"));
    }
}
