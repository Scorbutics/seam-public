// C6 gate: the Resolver strategy + headless LSP stack. Port of eval/resolver_test.py. The hermetic
// tests (no server, no network) cover the abstraction: make_resolver, the registry, the deterministic
// floor, the injection seam, and the `auto` fallback (LSP unavailable → floor). One GATED integration
// test drives a REAL typescript-language-server (run with SEAM_LSP_IT=1 — needs bun + a writable tmp).
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { make_resolver, DeterministicResolver } from "../../src/core/resolve/resolver.js";
import { set_resolver, _resolve, type Resolver } from "../../src/core/resolve/consumers.js";
import { spec_for_file, language_id_for } from "../../src/core/resolve/languages/index.js";

const FIX = "test/fixtures/scan-repo";
const CHECKOUT = "apps/web/checkout.ts";
const PKG = "@demo/lib/payments";
const endsPayments = (s: string | null) => !!s && s.replace(/\\/g, "/").endsWith("payments.ts");

describe("resolver strategy — hermetic", () => {
  test("make_resolver det is null", async () => {
    expect(await make_resolver("det")).toBeNull();   // det = the scan's built-in floor, no override
  });

  test("make_resolver lsp/auto → DaemonResolver", async () => {
    const { DaemonResolver } = await import("../../src/core/resolve/lsp/resolver.js");
    expect(await make_resolver("lsp")).toBeInstanceOf(DaemonResolver);
    const r = (await make_resolver("auto")) as InstanceType<typeof DaemonResolver>;
    expect(r).toBeInstanceOf(DaemonResolver);
    expect(r.fallback).toBe(true);
  });

  test("registry maps extension → language", () => {
    expect(spec_for_file("a/b/c.tsx")?.language).toBe("typescript");
    expect(spec_for_file("x.py")?.language).toBe("python");
    expect(spec_for_file("x.kt")?.language).toBe("kotlin");
    expect(spec_for_file("x.cpp")?.language).toBe("cpp");
    expect(spec_for_file("x.rb")?.language).toBe("ruby");
    expect(spec_for_file("README.md")).toBeNull();   // unsupported → caller keeps the floor
  });

  test("registry language id per file", () => {
    const ts = spec_for_file("x.ts")!;
    expect(language_id_for(ts, "a.tsx")).toBe("typescriptreact");
    expect(language_id_for(ts, "a.ts")).toBe("typescript");
    expect(language_id_for(ts, "a.jsx")).toBe("javascriptreact");
  });

  test("DeterministicResolver matches the floor", async () => {
    expect(endsPayments(await new DeterministicResolver().resolve_module(FIX, CHECKOUT, PKG))).toBe(true);
  });

  test("injection seam uses the active resolver (async)", async () => {
    const stub: Resolver = { async resolve_module() { return "STUB"; } };
    set_resolver(stub);
    try { expect(await _resolve("r", "f", "s")).toBe("STUB"); }
    finally { set_resolver(null); }
    expect(endsPayments(await _resolve(FIX, CHECKOUT, PKG))).toBe(true);    // default = the floor
  });

  test("auto falls back to the floor when no server", async () => {
    const { LspResolver } = await import("../../src/core/resolve/lsp/resolver.js");
    const r = new LspResolver(true);
    (r.pool as any).client_for = async () => [null, null, FIX];   // no server obtainable
    try { expect(endsPayments(await r.resolve_module(FIX, CHECKOUT, PKG))).toBe(true); }
    finally { r.pool.shutdown_all(); }
  });

  test("lsp-only returns null without a server", async () => {
    const { LspResolver } = await import("../../src/core/resolve/lsp/resolver.js");
    const r = new LspResolver(false);
    (r.pool as any).client_for = async () => [null, null, FIX];
    try { expect(await r.resolve_module(FIX, CHECKOUT, PKG)).toBeNull(); }   // lsp-only, no fallback
    finally { r.pool.shutdown_all(); }
  });
});

// --------------------------------------------------------------------- gated integration (real LSP)
const IT = !!process.env.SEAM_LSP_IT;

// A tmp TS project (a.ts imports ./b) with a real `typescript` peer — what tsserver needs to resolve.
function buildFixture(name: string): string {
  const repo = join(tmpdir(), name);
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "a.ts"), 'import { b } from "./b";\nexport const a = b + 1;\n');
  writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
  writeFileSync(join(repo, "tsconfig.json"), '{"compilerOptions":{"moduleResolution":"node"}}\n');
  const bun = existsSync(`${process.env.HOME}/.bun/bin/bun`) ? `${process.env.HOME}/.bun/bin/bun` : "bun";
  spawnSync(bun, ["add", "typescript"], { cwd: repo, stdio: "ignore" });
  return repo;
}

describe("headless LSP — real typescript-language-server", () => {
  test.skipIf(!IT)("resolves a relative import; node_modules is the external boundary", async () => {
    const repo = buildFixture("seam-lsp-it");
    const { LspResolver } = await import("../../src/core/resolve/lsp/resolver.js");
    const r = new LspResolver(false);
    try {
      expect(await r.resolve_module(repo, "a.ts", "./b")).toBe("b.ts");
      expect(await r.resolve_module(repo, "a.ts", "react")).toBeNull();   // external boundary
    } finally { r.pool.shutdown_all(); }
  }, 90_000);

  test.skipIf(!IT)("daemon warm servers reused across invocations (the index is paid once)", async () => {
    const repo = buildFixture("seam-lsp-it-daemon");
    const sock = join(tmpdir(), `seam-lsp-test-${process.pid}.sock`);
    const { DaemonResolver } = await import("../../src/core/resolve/lsp/resolver.js");
    const { call } = await import("../../src/core/resolve/lsp/daemon.js");
    try {
      const t0 = Date.now();
      expect(await new DaemonResolver(false, sock).resolve_module(repo, "a.ts", "./b")).toBe("b.ts");
      const first = Date.now() - t0;
      const t1 = Date.now();
      // a SECOND (fresh) resolver hits the same warm daemon → no re-index.
      expect(await new DaemonResolver(false, sock).resolve_module(repo, "a.ts", "./b")).toBe("b.ts");
      const second = Date.now() - t1;
      expect(second).toBeLessThan(first);            // warm reuse: the 2nd invocation didn't re-index
    } finally {
      try { await call(sock, { op: "shutdown" }); } catch { /* already down */ }
    }
  }, 90_000);
});
