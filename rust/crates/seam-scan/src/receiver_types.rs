//! FACTORY-NARROWED receiver types for the receiver-agnostic call-site pass. Port of
//! `codebase/scan/up/receiver_types.ts` — see that file for the full rationale.
//!
//! A receiver obtained from a FACTORY / DI getter (`const svc = getThingService();`) carries no annotation and
//! no `new T()`, so the type pass resolves NOTHING and the site stays an honest `RESOLVED_PARTIAL` lead —
//! which is right when the type is genuinely unknowable, and WRONG when it is statically written down one hop
//! away, on the factory's own return-type annotation. This resolves exactly that hop, framework-agnostically:
//! binder → the unqualified call it is initialised from → that function's DECLARED RETURN TYPE → the class
//! that declares it. No container/DI vocabulary is involved; a plain `function makeThing(): Thing` narrows
//! identically.
//!
//! SAFETY — the type is reported ONLY when it is provably a dispatch target of its own: the binder must be
//! bound ONCE from ONE unqualified call; the return type must be a LONE type reference; and the resolved type
//! must be a CONCRETE CLASS that DECLARES the called method. Anything short of that returns None and the lead
//! survives as `RESOLVED_PARTIAL`.

use crate::def_resolve::{resolve_def_file, DEF_FUNC_KINDS};
use crate::util::read;
use seam_lang::{ast, Ctx};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// (repo, file, binder, method) → the narrowed class name, or None. The call-site pass asks the same question
/// once per candidate consumer per up-build, and the hops involve two module resolutions.
fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static C: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn reset_factory_types() {
    cache().lock().unwrap().clear();
}

pub fn factory_receiver_type(repo: &str, from_file: &str, ctx: &Ctx, binder: &str, method: &str) -> Option<String> {
    let key = format!("{repo}\0{from_file}\0{binder}\0{method}");
    if let Some(hit) = cache().lock().unwrap().get(&key) {
        return hit.clone();
    }
    let out = resolve(repo, from_file, ctx, binder, method);
    cache().lock().unwrap().insert(key, out.clone());
    out
}

fn resolve(repo: &str, from_file: &str, ctx: &Ctx, binder: &str, method: &str) -> Option<String> {
    // not call-bound, or bound ambiguously
    let callee = ast::call_bound_binders(ctx).get(binder)?.clone()?;
    let fac_file = resolve_def_file(repo, from_file, &callee, DEF_FUNC_KINDS, 0)?;
    let (ftext, flang) = read(repo, &fac_file)?;
    let fctx = Ctx::parse(&ftext, &flang)?;
    // no declared return type → unknowable, keep the lead
    let ty = ast::declared_return_type(&fctx, &callee)?;
    let def_file = resolve_def_file(repo, &fac_file, &ty, crate::def_resolve::DEF_TYPE_KINDS, 0)?;
    let (dtext, dlang) = read(repo, &def_file)?;
    let dctx = Ctx::parse(&dtext, &dlang)?;
    // a concrete class owning the method = a provable target
    ast::class_owns_method(&dctx, &ty, method).then_some(ty)
}

