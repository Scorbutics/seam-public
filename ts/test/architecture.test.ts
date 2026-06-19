// ARCHITECTURE BOUNDARY TEST — enforces the loose-coupling layering as a unit test (this project has no
// ESLint toolchain; a bun:test that scans imports gives the same teeth with zero new dependencies). The
// module dependency DAG must have NO back-edges: a layer may depend DOWNWARD only. So an accidental
// re-coupling (e.g. `coupling/` reaching up into `scan/`, or `core/` importing `codebase/`) fails here.
// FORWARD "friend" imports (anchor → scan/def_table) are allowed — only the listed back-edges are banned.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}
const FILES = walk(SRC).map((f) => f.replace(/\\/g, "/"));
function importsOf(file: string): string[] {
  const out: string[] = [];
  for (const m of readFileSync(file, "utf-8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) out.push(m[1]);
  return out;
}

// A layer = files whose path contains `dir`. `forbidden` = import paths it must NEVER reference (an
// upward/back edge). `allow` = an escape hatch for a legitimate cross (a language IMPLEMENTS the carrier
// provider INTERFACE that lives in coupling — impl→interface is a valid downward dependency).
const RULES: { name: string; dir: string; forbidden: RegExp; allow?: RegExp }[] = [
  { name: "core/ must not import codebase/", dir: "/src/core/", forbidden: /codebase\// },
  { name: "languages/ must not import codebase/ (except the carrier provider interface)", dir: "/src/languages/", forbidden: /codebase\//, allow: /coupling\/carrier\/provider/ },
  { name: "coupling/ must not import scan|grow|anchor (it is the DAG leaf)", dir: "/src/codebase/coupling/", forbidden: /\/(scan|grow|anchor)\// },
  { name: "scan/ must not import grow|anchor", dir: "/src/codebase/scan/", forbidden: /\/(grow|anchor)\// },
  { name: "grow/ must not import anchor", dir: "/src/codebase/grow/", forbidden: /\/anchor\// },
];

describe("module layering (loose-coupling boundaries)", () => {
  for (const rule of RULES) {
    test(rule.name, () => {
      const violations: string[] = [];
      for (const f of FILES) {
        if (!f.includes(rule.dir)) continue;
        for (const imp of importsOf(f)) {
          if (rule.forbidden.test(imp) && !(rule.allow && rule.allow.test(imp))) violations.push(`${f.split("/src/")[1]} → ${imp}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }
});
