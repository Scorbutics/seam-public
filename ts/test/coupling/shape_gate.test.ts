// The coupling flywheel's SHAPE GATE (SEAM_COUPLING_SHAPE_GATE=1, opt-in). A floor-blind file with a data-access
// SHAPE — a member chain (`recv.x.verb()`) or a string-keyed call (`f('k')`) — has a SUSPECTED edge and is worth an
// LLM matcher pass; a file with none (a pure DTO/serializer/entity — the infra flood) does not, and `clusterBlindFiles`
// marks it `shaped:false` so the caller skips it. This pins that classification (the caller-side skip is exercised
// by the llm_key_index tests). Default-OFF: with the gate disabled every file is `shaped:true` (no behaviour change).
// Guards on tree-sitter (the shape is read from the grammar; unavailable → everything kept).
import { describe, expect, test, afterEach } from "bun:test";
import { clusterBlindFiles } from "../../src/codebase/coupling/key_cluster.js";
import { available } from "../../src/codebase/atoms.js";

const shaped = { file: "store.ts", text: "export const read = () => localStorage.getItem('compactMode');\n" };   // string-keyed call → suspected edge
const infra = { file: "UserDto.ts", text: "export interface UserDto { id: string; name: string; roles: string[]; }\n" };   // pure type — no data-access

afterEach(() => { delete process.env.SEAM_COUPLING_SHAPE_GATE; });

describe("coupling shape gate — only files with a suspected data-access edge are learnt", () => {
  test("GATE ON: the shaped file is kept, the shapeless infra file is marked shaped:false (skipped)", async () => {
    if (!available()) return;
    process.env.SEAM_COUPLING_SHAPE_GATE = "1";
    const byFile = new Map((await clusterBlindFiles([shaped, infra])).map((c) => [c.rep.file, c]));
    // find the cluster each file lands in (a shapeless file is its own singleton)
    const shapedC = [...byFile.values()].find((c) => c.members.some((m) => m.file === "store.ts"))!;
    const infraC = [...byFile.values()].find((c) => c.members.some((m) => m.file === "UserDto.ts"))!;
    expect(shapedC.shaped).toBe(true);
    expect(infraC.shaped).toBe(false);
  });

  test("GATE OFF (default): every file is shaped:true — no dropping, behaviour unchanged", async () => {
    if (!available()) return;
    const clusters = await clusterBlindFiles([shaped, infra]);
    expect(clusters.every((c) => c.shaped)).toBe(true);
  });
});
