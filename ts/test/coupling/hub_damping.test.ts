// HUB DAMPING: a shared-key whose far-side fan-in exceeds COUPLING.hubFan is infrastructure (a shared
// EntityManager / audit log touched by half the codebase), not a domain channel — it floods the footprint
// (and COMPOUNDS through grow re-anchoring). So it materializes only hubReaderCap complement(s), while a
// low-fan-in DOMAIN table keeps its complements. This is the globex `mMongoEntityManager` fan. Structural
// (degree), not a name match. Guards on tree-sitter (needs it for the floor scan + complement units).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "hub-damp-"));
  // anchor writes a DOMAIN table (bookings) AND a HUB table (audit). Supabase floor adapter → both ground.
  w("src/anchor.ts", `export async function createBooking(){ await supabase.from('bookings').insert({}); await supabase.from('audit').insert({}); }\n`);
  // the domain counterpart — low fan-in on 'bookings' (anchor + this = 2)
  w("src/reader.ts", `export async function readBookings(){ return supabase.from('bookings').select('*'); }\n`);
  // the HUB fan: 20 unrelated files all touching 'audit' → fan-in 20 > hubFan(16)
  for (let i = 1; i <= 20; i++) w(`src/h${i}.ts`, `export async function audit${i}(){ return supabase.from('audit').select('*'); }\n`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("hub damping bounds a high-fan-in shared key", () => {
  test("the audit hub (fan-in 20) is damped well below readerCap; the domain counterpart survives", async () => {
    if (!available()) return;
    const [data] = await grow_to_terminals(REPO, "src/anchor.ts", "createBooking", { maxSteps: 6, dataCoupling: true });
    const auditFan = data.nodes.filter((n: any) => /^src\/h\d/.test(n.file ?? "")).length;
    // readerCap is 6; the 20-fan-in hub being cut to ~hubReaderCap(1) is the whole point — undamped it would be 6.
    expect(auditFan).toBeLessThanOrEqual(2);
    // the low-fan-in DOMAIN table (bookings, fan-in 2) is NOT a hub → its counterpart still materializes.
    expect(data.nodes.some((n: any) => n.file === "src/reader.ts")).toBe(true);
  });
});
