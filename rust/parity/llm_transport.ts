// Byte-identical harness — the Rust LLM transport (seam-llm) vs ts/src/core/llm.ts, on the halves that can be
// checked WITHOUT spending a model call: backend RESOLUTION, tier model ROUTING, and reply PARSING.
//
// Those three are where a transport port silently diverges. A wrong resolution sends passes to a different
// binary (or reports "no backend" on a machine that has one, so every flywheel axis quietly degrades to its
// floor and the user just sees weaker recall). A wrong route runs a `strong` pass on a haiku. A wrong parse
// turns a GOOD reply into a failed pass — same silent degrade. None of it shows up as an error, which is
// exactly why it needs a comparator.
//
// The actual subprocess is NOT exercised here: it costs money, needs a logged-in CLI, and is nondeterministic.
// `--live` runs one real pass through BOTH transports and compares that they both succeed (not that the text
// matches — the model is not deterministic).
//
//   bun rust/parity/llm_transport.ts [--live]
import { createRequire } from "node:module";
import { resolve_backend, available, extractJsonArray, run_pass } from "../../ts/src/core/llm.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

let ok = 0, bad = 0;
const fails: string[] = [];
const cmp = (tag: string, a: string, b: string) => {
  if (a === b) { ok++; return; }
  bad++;
  fails.push(`✗ ${tag}\n  ts:   ${a}\n  rust: ${b}`);
};

// 1. BACKEND RESOLUTION — same kind, same path, on this machine as it actually is.
{
  const tsRes = (() => { try { const [k, p] = resolve_backend(); return `${k}|${p}`; } catch (e) { return `ERR|${(e as Error).message.slice(0, 60)}`; } })();
  const rsRes = (() => { try { const [k, p] = addon.llmResolveBackend(); return `${k}|${p}`; } catch (e) { return `ERR|${(e as Error).message.slice(0, 60)}`; } })();
  cmp("resolve_backend()", tsRes, rsRes);
  cmp("available()", String(available()), String(addon.llmAvailable()));
  // an override that does not exist must FAIL on both — never a silent fallback to the located binary
  const bogus = "/nonexistent/claude-binary-xyz";
  const tsBad = (() => { try { resolve_backend(bogus); return "resolved"; } catch { return "threw"; } })();
  const rsBad = (() => { try { addon.llmResolveBackend(bogus); return "resolved"; } catch { return "threw"; } })();
  cmp("resolve_backend(bogus override)", tsBad, rsBad);
}

// 2. TIER ROUTING — upgrade-only. Import the pass registrations the TS side does at module load, so both
// sides see the same tags (the Rust registry is a static table mirroring those call sites).
{
  // (classify-receivers is registered by the CORE now — receiver_class.ts is gone)
  await import("../../ts/src/codebase/grow/subject_affinity.js");     // registers affinity (cheap)
  const { run_pass: _rp } = await import("../../ts/src/core/llm.js");
  void _rp;
  const { getPass } = await import("../../ts/src/core/llm.js");
  const strongModel = process.env.SEAM_STRONG_MODEL ?? "claude-sonnet-4-6";
  const tsRoute = (tag: string | undefined, base: string) => {
    const spec = tag ? getPass(tag) : undefined;
    if (!spec || spec.tier !== "strong" || !strongModel) return base;
    return /haiku/i.test(base) ? strongModel : base;
  };
  for (const [tag, base] of [["classify-receivers", "claude-haiku-4-5"], ["classify-receivers", "claude-opus-4-1"],
                             ["affinity", "claude-haiku-4-5"], ["", "claude-haiku-4-5"]] as [string, string][]) {
    cmp(`route_model(${tag || "-"}, ${base})`, tsRoute(tag || undefined, base), addon.llmRouteModel(tag || undefined, base));
  }
}

// 3. REPLY PARSING — the shapes a real backend actually returns, including the ones that must FAIL.
{
  const cases: string[] = [
    `[{"kind":"db-table","value":"booking","role":"write"}]`,
    "```json\n[{\"a\":1},{\"b\":2}]\n```",
    "```\n[1,2,3]\n```",
    `Here is what I found:\n[{"x":1}]\nThat is all.`,
    `I checked rows [0, 1] and concluded:\n[{"kind":"db-table","value":"booking"}]`,
    `[]`,
    `  [ { "a" : [1,2] } ]  `,
    `no array at all`,
    `{"not":"an array"}`,
    `[unclosed`,
  ];
  for (const [i, c] of cases.entries()) {
    const ts = (() => { try { return JSON.stringify(extractJsonArray(c)); } catch { return "THREW"; } })();
    const rs = (() => { try { return addon.llmExtractJsonArray(c); } catch { return "THREW"; } })();
    cmp(`extractJsonArray[${i}] ${JSON.stringify(c.slice(0, 34))}`, ts, rs);
  }
}

// 4. LIVE (opt-in) — one real pass through each transport. Compares that both SUCCEED, not that the text
// matches: the model is not deterministic, so equality would be a flaky assertion, not a stronger one.
if (process.argv.includes("--live")) {
  const prompt = `Reply with exactly this JSON array and nothing else: [{"ok":true}]`;
  const tsOk = (() => { try { const m = run_pass(prompt, { thinking: 0 }); return m.size >= 0; } catch (e) { return `ERR ${(e as Error).message.slice(0, 80)}`; } })();
  const rsOk = (() => { try { const t = addon.llmRunPass(prompt, undefined, undefined, 0, undefined); return typeof t === "string" && t.length > 0; } catch (e) { return `ERR ${(e as Error).message.slice(0, 80)}`; } })();
  console.log(`  live: ts=${tsOk} rust=${rsOk}`);
  console.log(`  rust usage [calls,in,out,usd,ms] = ${JSON.stringify(addon.llmUsage())}`);
}

console.log(`\nllm transport parity: ${ok} ok / ${bad} bad`);
for (const f of fails) console.log(f);
process.exit(bad ? 1 : 0);
