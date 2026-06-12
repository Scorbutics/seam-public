// Codebase C5 gate: P5 auto-orchestration (orchestrate.ts) must match Python byte-for-byte.
// The only nondeterministic boundary is the LLM move-pick; we pin it with a host-bus canned reply,
// so the GROWN ResolvedGraph + move history are fully deterministic and oracle-comparable.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HostBus, set_host_bus } from "../src/core/llm.js";
import { auto_orchestrate, _step_prompt } from "../src/codebase/orchestrate.js";

// Paths are CWD-RELATIVE (bun test runs from ts/): the ResolvedGraph echoes the input path verbatim,
// so the oracle — generated with the same cwd-relative paths — must be compared against the same.
const oracleDir = join("test", "oracle");
const repo = join("test", "fixtures", "class-repo");
const svc = join(repo, "src/payment/service.ts");

describe("codebase auto-orchestrate (host-bus inject) vs Python", () => {
  test("grow toward intent then settle", async () => {
    const oracle = JSON.parse(readFileSync(join(oracleDir, "auto_orchestrate.json"), "utf-8"));
    const reply = '[{"id":"step","node":"PaymentService","direction":"down","done":false}]';
    set_host_bus(new HostBus({ orchestrate: reply }));
    let data: any, hist: any[];
    try { [data, hist] = await auto_orchestrate(repo, svc, "PaymentService", "how does refund work", { maxSteps: 3 }); }
    finally { set_host_bus(null); }
    expect(JSON.parse(JSON.stringify({ data, hist }))).toEqual(oracle);
  });

  test("_step_prompt (crossing branch) byte-identical to Python", () => {
    const golden = readFileSync(join(oracleDir, "orchestrate_prompt.txt"), "utf-8");
    const summary = [
      { id: "n1", symbol: "a", role: "core", file: "a.ts", crossing: false },
      { id: "n2", symbol: "b", role: "link", file: "b.ts", crossing: true },
    ];
    expect(_step_prompt("q", summary)).toBe(golden);
  });
});
