// TS/ioctopus DI BINDING RESOLUTION (framework-specific, isolated per CLAUDE.md). The dependency graph already
// resolves interface→impl edges structurally (scan/down/interface_index.ts). What it CANNOT see is WHICH impl a
// runtime DI container BINDS to a token, and under what CONDITION — the ioctopus `bind(TOKEN).toClass(Impl)` /
// `.toFactory(() => cond ? new A() : new B())` binding SITE. This module recovers exactly that, so a
// `--query dependencies` answer can say "IRedisService → RedisService when (UPSTASH…) else NoopRedisService, bound
// @ redisModule.ts:9" in ONE call instead of forcing the caller into follow-up greps.
//
// STRUCTURAL, not semantic (CLAUDE.md): the ioctopus binding forms are a CLOSED grammar (bind/toClass/toFactory/
// toValue + the type-safe bindModuleToClassOnToken helper); we walk the TREE-SITTER AST and read the literally-
// written impl class names + token — never a name guess, never a comment/string false-match. Cached per FILE via
// incrementalScanAsync (mtime/size keyed → a DI-module edit re-parses only that file), so it is edit-safe for a
// long-lived process. Gated by the caller behind SEAM_DI_RESOLVE; degrades to empty when tree-sitter is absent.
import { field } from "../../core/treesitter.js";

export interface DiBinding {
  token: string;                    // bare token name, e.g. "REDIS_CLIENT"
  kind: "toClass" | "toFactory" | "toValue";
  impls: string[];                  // concrete class name(s) the binding produces (factory may yield >1)
  condition?: string;              // the toFactory branch condition (raw), when it selects between impls
  deps?: Record<string, string>;    // toClass ctor dep map: ctorKey -> bare DEP_TOKEN
  file: string;
  line: number;                     // 1-based
}

export type DiContribution = { bindings: DiBinding[] };

export const bare = (t: string) => (t.split(".").pop() ?? t).replace(/["'\[\]]/g, "").trim();
const stripParens = (s: string) => s.replace(/^\(/, "").replace(/\)$/, "").trim();

// Textual pre-gate: a file with none of the ioctopus binding tokens cannot contribute — skip the parse (mirrors
// interface_index's impl_markers gate). SOUND: every binding form contains one of these literally.
export const DI_MARKERS = [".bind(", "bindModuleToClassOnToken"];

// Parse ONE already-parsed file → its DI bindings. PURE GRAMMAR: the caller supplies `ctx` (a tree-sitter context)
// because building one needs codebase/atoms, and languages/ must not import codebase/ (the layering rule). The
// per-file caching + repo walk that feed this live in codebase/di/index.ts.
export function scanDiBindings(rel: string, ctx: any): DiContribution {
  const bindings: DiBinding[] = [];

  // local token aliases: `const token = DI_TOKENS.REDIS_CLIENT;` → token -> "DI_TOKENS.REDIS_CLIENT"
  const alias = new Map<string, string>();
  for (const vd of ctx.collect(ctx.root, (k: string) => k === "variable_declarator")) {
    const nm = field(vd, "name"), val = field(vd, "value");
    if (nm?.type === "identifier" && val?.type === "member_expression") alias.set(nm.text, val.text);
  }
  const resolveTok = (raw: string) => bare(alias.get(raw) ?? raw);
  const argAt = (call: any, i: number) => { const a = field(call, "arguments"); return a && i < a.namedChildCount ? a.namedChild(i) : null; };
  const rowOf = (n: any) => (n.startPosition?.row ?? 0) + 1;

  // callee decomposition: a call whose function is `<object>.<method>(...)`.
  const memberCall = (call: any): { method: string; object: any } | null => {
    const fn = field(call, "function");
    if (fn?.type !== "member_expression") return null;
    const prop = field(fn, "property")?.text;
    return prop ? { method: prop, object: field(fn, "object") } : null;
  };

  for (const call of ctx.collect(ctx.root, (k: string) => k === "call_expression")) {
    const mc = memberCall(call);
    // FORM 1: X.bind(TOKEN).toClass/toFactory/toValue(...)
    if (mc && (mc.method === "toClass" || mc.method === "toFactory" || mc.method === "toValue")
        && mc.object?.type === "call_expression") {
      const inner = memberCall(mc.object);
      if (!inner || inner.method !== "bind") continue;
      const tokNode = argAt(mc.object, 0);
      if (!tokNode) continue;
      const token = resolveTok(tokNode.text);
      const line = rowOf(call);
      if (mc.method === "toClass") {
        const clsNode = argAt(call, 0);
        const cls = clsNode?.type === "identifier" ? clsNode.text : "?";
        const deps: Record<string, string> = {};
        const depNode = argAt(call, 1);
        if (depNode?.type === "object")
          for (const p of ctx.collect(depNode, (k: string) => k === "pair")) {
            const key = field(p, "key")?.text, v = field(p, "value")?.text;
            if (key && v) deps[bare(key)] = bare(v);
          }
        bindings.push({ token, kind: "toClass", impls: [cls], deps, file: rel, line });
      } else if (mc.method === "toFactory") {
        const body = argAt(call, 0);
        // SOURCE-ORDER matters: the FIRST `new X()` is the condition-true / primary branch (`if (cond) return new A()`
        // or `cond ? new A() : new B()`), the rest are fallbacks — the renderer labels impls[0] "when (cond)". collect
        // yields tree-traversal order, so sort by source position to recover the branch semantics.
        const news = body
          ? [...new Set<string>(ctx.collect(body, (k: string) => k === "new_expression")
              .sort((a: any, b: any) => (a.startIndex ?? 0) - (b.startIndex ?? 0))
              .map((n: any) => (field(n, "constructor")?.text ?? "").split("(")[0].trim()).filter(Boolean))]
          : [];
        const ifn = body ? ctx.collect(body, (k: string) => k === "if_statement")[0] : null;
        const cond = ifn ? stripParens(field(ifn, "condition")?.text ?? "") : undefined;
        bindings.push({ token, kind: "toFactory", impls: news, condition: cond, file: rel, line });
      } else {
        bindings.push({ token, kind: "toValue", impls: [], file: rel, line });
      }
      continue;
    }
    // FORM 2: bindModuleToClassOnToken({ token, classs: Impl, depsMap })
    const fn = field(call, "function");
    if (fn?.type === "identifier" && fn.text === "bindModuleToClassOnToken") {
      const obj = argAt(call, 0);
      if (obj?.type !== "object") continue;
      let tokRaw: string | undefined, cls: string | undefined;
      const deps: Record<string, string> = {};
      for (const p of ctx.children(obj).filter((c: any) => c.type === "pair" || c.type === "shorthand_property_identifier")) {
        if (p.type === "shorthand_property_identifier") { if (p.text === "token") tokRaw = "token"; continue; }
        const key = field(p, "key")?.text, val = field(p, "value");
        if (key === "token") tokRaw = val?.text;
        else if (key === "classs" && val?.type === "identifier") cls = val.text;
        else if (key === "depsMap" && val?.type === "object")
          for (const dp of ctx.collect(val, (k: string) => k === "pair")) {
            const dk = field(dp, "key")?.text, dv = field(dp, "value")?.text;
            if (dk && dv) deps[bare(dk)] = bare(dv);
          }
      }
      if (tokRaw && cls) bindings.push({ token: resolveTok(tokRaw), kind: "toClass", impls: [cls], deps, file: rel, line: rowOf(call) });
    }
  }
  return { bindings };
}

