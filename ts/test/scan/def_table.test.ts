// def_table: enumerate top-level defs + class methods with enclosing class, for embedding recall.
import { describe, expect, test } from "bun:test";
import { defs_in_file, embedString } from "../../src/codebase/scan/def_table.js";

const SRC = `
export class SupabaseWeeklyTaskRepository {
  async save(task: WeeklyTask): Promise<void> { /* … */ }
  getByMemberAndWeek(memberId: string, week: number) { return null; }
}
export function generateMemberMissions() { return []; }
const formatDate = (d: Date): string => d.toISOString();
`;

describe("def_table enumeration", () => {
  const defs = defs_in_file("scoring-cycle/repositories.ts", SRC);
  const by = (n: string) => defs.find((d) => d.name === n);

  test("captures classes, functions, const-arrows, and methods", () => {
    expect(by("SupabaseWeeklyTaskRepository")?.kind).toBe("class");
    expect(by("generateMemberMissions")?.kind).toBe("function");
    expect(by("formatDate")?.kind).toBe("function");
    expect(by("save")?.kind).toBe("method");
  });

  test("a method carries its enclosing class (the domain signal the bare name lacks)", () => {
    expect(by("save")?.enclosing).toBe("SupabaseWeeklyTaskRepository");
    expect(embedString(by("save")!)).toContain("in SupabaseWeeklyTaskRepository");
    expect(embedString(by("save")!)).toContain("scoring-cycle/repositories.ts");
    // a control-flow keyword inside a method body is NOT mistaken for a method def
    expect(by("if")).toBeUndefined();
  });
});

// BODY passage — the calls/identifiers AROUND a callable (the concept the signature+doc omit). Callables
// only; bounded; brace-only/comment/blank lines skipped. This is what answers "are you using the passage
// around each symbol" for the embedding ranking.
describe("def_table body passage (callables only, bounded)", () => {
  const SRC2 = `
export function memberBookings(adviserId) {
  // fetch the adviser's bookings
  const rows = bookingRepository.findByAdviser(adviserId);
  return rows.map(mapBookingToDto);
}
export class Role {
  ADMINISTRATOR;
}
`;
  const defs = defs_in_file("svc/bookings.ts", SRC2);
  const by = (n: string) => defs.find((d) => d.name === n);

  test("a callable embeds the calls in its body (the salient 'what it does')", () => {
    const e = embedString(by("memberBookings")!);
    expect(e).toContain("bookingRepository.findByAdviser");
    expect(e).toContain("mapBookingToDto");
  });
  test("body is brace/comment-free and bounded (no lone `}`, no doc-comment line)", () => {
    const b = by("memberBookings")!.body!;
    expect(b).not.toMatch(/^[{}]|[{}]$/);            // no leading/trailing brace
    expect(b).not.toContain("fetch the adviser");    // comment line skipped
    expect(b.length).toBeLessThanOrEqual(240);       // SCAN.bodyCap
  });
  test("a CONTAINER (class/enum) has NO body — its members are relevance noise", () => {
    expect(by("Role")?.kind).toBe("class");
    expect(by("Role")?.body).toBeUndefined();
  });
});

// DESCRIPTOR-MAP entries — a config-driven client / route table lists its OPERATIONS as object KEYS whose value
// is a descriptor (`createBooking: { endpoint, method }`), not as functions. Those keys must be anchor
// candidates. Recognition is purely STRUCTURAL (key → object value, inside a value-position object literal) —
// NO endpoint/method vocabulary — so it survives `{uri, httpMethod}`, other-language keys, and multi-line
// entries; the embedder ranks which entries are real operations. A class/interface field with a nested-object
// TYPE is NOT an operation and must be excluded.
describe("def_table descriptor-map entries (vocabulary-free, structural)", () => {
  test("single-line and multi-line descriptor keys in a named object literal are anchorable defs", () => {
    const SRC = `
export const bookingApi = {
  createBooking: { endpoint: baseUrl, method: 'post' },
  updateBooking: {
    endpoint: baseUrl + '/{id}',
    verb: 'put'
  },
};
`;
    const defs = defs_in_file("web/bookingApi.ts", SRC);
    const by = (n: string) => defs.find((d) => d.name === n);
    expect(by("createBooking")?.kind).toBe("function");        // single-line descriptor
    expect(by("updateBooking")?.kind).toBe("function");        // MULTI-line descriptor (was invisible to the same-line regex)
    expect(by("createBooking")?.enclosing).toBe("bookingApi"); // the map name is the domain signal
    // the body window carries the descriptor's route/verb — the seed the embedder ranks on (no vocabulary in the extractor)
    expect(embedString(by("createBooking")!)).toContain("endpoint");
    expect(embedString(by("updateBooking")!)).toContain("verb");   // an alternate vocabulary a keyword list would miss
  });

  test("a NON-route descriptor map still anchors (proves no domain vocabulary is required)", () => {
    // `{uri, httpMethod}` — an alternate convention the old endpoint/method keyword list would have skipped.
    const defs = defs_in_file("web/client.ts", `const api = {\n  fetchUser: { uri: '/u', httpMethod: 'GET' },\n};\n`);
    expect(defs.find((d) => d.name === "fetchUser")?.kind).toBe("function");
  });

  test("a nested-object TYPE field in a class/interface is NOT mistaken for an operation (type noise excluded)", () => {
    const SRC = `
export interface ApiConfig {
  createBooking: { endpoint: string; method: string };
}
export class Settings {
  layout: { rows: number } = { rows: 3 };
}
`;
    const names = defs_in_file("web/types.ts", SRC).map((d) => d.name);
    expect(names).not.toContain("createBooking");   // interface field, not a value-position operation
    expect(names).not.toContain("layout");          // class field type annotation
    expect(names).toContain("ApiConfig");
    expect(names).toContain("Settings");
  });
});

// enumerate_defs `files` filter — the footprint-scoped embedding lever (#3). annotateIntentRelevance only
// needs the seams' OWN files, so we embed just those, not a whole-repo tree-sitter walk. The emitted
// Def.file stays the canonical rel (we FILTER candidate_source_files), so cache keys match the unscoped pass.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enumerate_defs } from "../../src/codebase/scan/def_table.js";

describe("enumerate_defs files-scope", () => {
  const repo = mkdtempSync(join(tmpdir(), "seam-defscope-"));
  writeFileSync(join(repo, "alpha.ts"), "export function alpha() { return 1; }\n");
  writeFileSync(join(repo, "beta.ts"), "export function beta() { return 2; }\n");

  test("no files arg → all files' defs", async () => {
    const names = (await enumerate_defs(repo)).map((d) => d.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
    rmSync(repo, { recursive: true, force: true });
  });
  test("files set → only those files' defs, with the canonical rel preserved", async () => {
    const repo2 = mkdtempSync(join(tmpdir(), "seam-defscope2-"));
    writeFileSync(join(repo2, "alpha.ts"), "export function alpha() { return 1; }\n");
    writeFileSync(join(repo2, "beta.ts"), "export function beta() { return 2; }\n");
    const scoped = await enumerate_defs(repo2, 4000, new Set(["alpha.ts"]));
    expect(scoped.map((d) => d.name)).toEqual(["alpha"]);
    expect(scoped[0].file).toBe("alpha.ts");   // canonical rel (cache parity with the unscoped recall pass)
    rmSync(repo2, { recursive: true, force: true });
  });
});

// FILE-LEVEL def — a file whose identity is NOT a named symbol (a module.exports/Vue-plugin/config) must
// still be a recall candidate. The reported miss: a bookingService.js Vue plugin whose only extracted def
// was a nested `transformResultError` arrow, so the booking entry was never listed.
import { module_def } from "../../src/codebase/scan/def_table.js";

describe("module_def — file identity as a candidate (the bookingService.js miss)", () => {
  const SVC = `const apiWrapper = require("../utils/apiWrapper");
/**
 * Service for booking-related API calls.
 */
module.exports = {
  install( Vue ) {
    const transformResultError = ( result ) => { if (result.error) return result; };
  }
};
`;
  test("names the file, kind=module, carries the leading doc", () => {
    const md = module_def("web-acmecheck/bookingService.js", SVC);
    expect(md.name).toBe("bookingService");
    expect(md.kind).toBe("module");
    expect(md.doc).toContain("booking-related API calls");
  });
  test("object-literal methods ARE extracted (the fix); moduleDefs still adds file identity", async () => {
    const repo = mkdtempSync(join(tmpdir(), "seam-moddef-"));
    writeFileSync(join(repo, "bookingService.js"), SVC);
    const plain = (await enumerate_defs(repo)).map((d) => d.name);
    expect(plain).toContain("install");              // the object-literal method is now visible (was the miss)
    expect(plain).toContain("transformResultError");
    const withMod = await enumerate_defs(repo, 4000, undefined, { moduleDefs: true });
    expect(withMod.some((d) => d.name === "bookingService" && d.kind === "module")).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });
  test("a service object's real async CRUD methods are extracted (the declarative-client anchor unlock)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "seam-svc-"));
    writeFileSync(join(repo, "bookingService.js"),
      `module.exports = { install( Vue ) {\n` +
      `  const baseUrl = '/acme/rest/member/booking/v1';\n` +
      `  Vue.prototype.bookingService = {\n` +
      `    async createBooking( vm, data ) { return Vue.http.post( baseUrl, data ); },\n` +
      `    async updateBooking( vm, id, data ) { return Vue.http.put( baseUrl + '/' + id, data ); }\n` +
      `  };\n} };\n`);
    const names = new Set((await enumerate_defs(repo)).map((d) => d.name));
    expect(names.has("createBooking")).toBe(true);   // the real async object methods — anchorable now
    expect(names.has("updateBooking")).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });
});

// RETRIEVE-then-rerank pre-filter — narrows a large def set to the M most intent-overlapping BEFORE the
// (expensive) embed, so cold cost is bounded by M not the repo size. The relevant def must SURVIVE even when
// buried among many low-overlap ones; pure + LLM-free.
import { lexicalPreFilter } from "../../src/codebase/scan/def_embed.js";
import type { Def } from "../../src/codebase/scan/def_table.js";

describe("lexicalPreFilter (retrieve-then-rerank candidate generation)", () => {
  const d = (name: string, doc = ""): Def => ({ name, kind: "function", file: `${name}.ts`, signature: `function ${name}()`, enclosing: "", doc });
  const terms = ["adviser", "manages", "bookings", "database"];

  test("a buried high-overlap def survives over many low-overlap ones (the monorepo case)", () => {
    const defs = [
      ...Array.from({ length: 500 }, (_, i) => d(`renderWidget${i}`)),   // zero overlap, sorted first
      d("bookingService", "fetch the adviser's bookings from the database"),   // high overlap, LAST
    ];
    const kept = lexicalPreFilter(defs, terms, 50);
    expect(kept.some((x) => x.name === "bookingService")).toBe(true);   // not crowded out despite being last
    expect(kept.length).toBe(50);                                       // bounded to M
  });
  test("prefix overlap bridges morphology (booking ↔ bookings)", () => {
    const defs = [d("listBookingsForAdviser"), ...Array.from({ length: 100 }, (_, i) => d(`misc${i}`))];
    expect(lexicalPreFilter(defs, terms, 5)[0].name).toBe("listBookingsForAdviser");   // ranks first by overlap
  });
  test("small sets (≤M) pass through untouched; no terms → no filtering", () => {
    const defs = [d("a"), d("b")];
    expect(lexicalPreFilter(defs, terms, 50)).toHaveLength(2);
    expect(lexicalPreFilter(Array.from({ length: 100 }, (_, i) => d(`f${i}`)), [], 50)).toHaveLength(50);
  });
});

// The whole-repo def LIMIT truncates ALPHABETICALLY — the monorepo recall trap: a module sorted late
// (web-acmecheck after web-manage) is cut off and never becomes an anchor candidate. The limit is the
// knob (SEAM_DEF_LIMIT in embedScoreDefs) — raising it recovers the late module.
describe("enumerate_defs limit truncates alphabetically (the SEAM_DEF_LIMIT trap)", () => {
  const repo = mkdtempSync(join(tmpdir(), "seam-deflimit-"));
  // sorts first, fills the budget:
  writeFileSync(join(repo, "web-manage.ts"), "export function m1(){}\nexport function m2(){}\nexport function m3(){}\n");
  // sorts LATE — the symbol the user expects:
  writeFileSync(join(repo, "web-acmecheck.ts"), "export function bookingService(){}\n");

  test("a low limit drops the late-sorted module's symbol", async () => {
    const names = (await enumerate_defs(repo, 3)).map((d) => d.name);
    expect(names).not.toContain("bookingService");   // cut off — exactly the reported failure
  });
  test("raising the limit recalls it", async () => {
    const names = (await enumerate_defs(repo, 100)).map((d) => d.name);
    expect(names).toContain("bookingService");
    rmSync(repo, { recursive: true, force: true });
  });
});
