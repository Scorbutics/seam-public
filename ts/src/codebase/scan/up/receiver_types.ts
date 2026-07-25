// SCAN phase — FACTORY-NARROWED receiver types for the receiver-agnostic call-site pass.
//
// The call-site pass grounds a `<receiver>.m()` site by resolving the receiver's TYPE: a type annotation or
// a `new T()` (scan/ast_class `_instance_types`). A receiver obtained from a FACTORY / DI getter
// (`const svc = getThingService();`) has neither, so it resolves to NOTHING and the site stays an honest
// RESOLVED_PARTIAL lead — which is right when the type is genuinely unknowable, and WRONG (an asserted false
// caller) when it is statically written down one hop away, on the factory's own return-type annotation.
//
// This resolves exactly that hop, framework-agnostically: binder → the unqualified call it is initialised
// from → that function's DECLARED RETURN TYPE → the class that declares it. No container/DI vocabulary is
// involved; a plain `function makeThing(): Thing` narrows identically.
//
// SAFETY (never trade a false positive for a false negative) — the type is reported ONLY when it is provably
// a dispatch target of its own:
//   * the initializer must be the WHOLE value and the binder bound once, from one callee (ast_class);
//   * the return type must be a LONE type reference (a `Promise<T>` / union / generic is refused);
//   * the resolved type must be a CONCRETE CLASS (never an interface — the anchor's class may implement it)
//     that declares the called METHOD ITSELF, so the call has a real target that is not the anchor.
// Anything short of that returns null and the lead survives as RESOLVED_PARTIAL.
import { type Ctx, makeCtx } from "../../atoms.js";
import { _read } from "../ast_units.js";
import { _call_bound_binders, _declared_return_type, _class_owns_method } from "../ast_class.js";
import { resolveDefFile, DEF_FUNC_KINDS } from "../def_resolve.js";

// (repo, file, binder, method) → the narrowed class name, or null. The call-site pass asks the same
// question once per candidate consumer per up-build, and the hops involve two module resolutions.
const _cache = new Map<string, string | null>();
export function resetFactoryTypes(): void { _cache.clear(); }

export async function factoryReceiverType(repo: string, fromFile: string, ctx: Ctx,
    binder: string, method: string): Promise<string | null> {
  const key = `${repo}\0${fromFile}\0${binder}\0${method}`;
  const hit = _cache.get(key);
  if (hit !== undefined) return hit;
  const out = await _resolve(repo, fromFile, ctx, binder, method);
  _cache.set(key, out);
  return out;
}

async function _resolve(repo: string, fromFile: string, ctx: Ctx, binder: string, method: string): Promise<string | null> {
  const callee = _call_bound_binders(ctx).get(binder);
  if (!callee) return null;                                    // not call-bound, or bound ambiguously
  const facFile = await resolveDefFile(repo, fromFile, callee, DEF_FUNC_KINDS);
  if (!facFile) return null;
  const fr = _read(repo, facFile); if (!fr) return null;
  const fctx = await makeCtx(fr[0], fr[1]); if (!fctx) return null;
  const type = _declared_return_type(fctx, callee);
  if (!type) return null;                                      // no declared return type → unknowable, keep the lead
  const defFile = await resolveDefFile(repo, facFile, type);
  if (!defFile) return null;
  const dr = _read(repo, defFile); if (!dr) return null;
  const dctx = await makeCtx(dr[0], dr[1]); if (!dctx) return null;
  return _class_owns_method(dctx, type, method) ? type : null; // a concrete class owning the method = a provable target
}
