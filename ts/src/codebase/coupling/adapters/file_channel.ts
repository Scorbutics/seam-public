// FILE-CHANNEL key kind — a data file (`Data/Animations.rxdata`) shared between a writer and a reader,
// the homemade-framework data-coupling teacher 1 surfaces (a `save_data`/`Yuki::VD#write_data` carrier
// call with a literal path on one side, a `load_data` carrier on the other). Unlike the framework
// adapters, its accesses are NOT a per-file sync regex scan — they need repo-wide carrier-tracing
// (../carrier/engine.ts, async). So `scan` is empty here; registering the KIND only wires the channel
// into the rung machinery (crossing edges, flow-subject node kind, culmination produce-edge).
import type { KeyKind } from "../types.js";

export const FILE_CHANNEL: KeyKind = {
  kind: "data-file",
  nodeKind: "data-file",
  produceEdge: "file-write",
  consumeEdge: "file-read",
  name: "file-channel",
  blurb: "Shared data-file write ⇄ read (carrier-traced) — file-channel coupling",
  scan: () => [],   // carrier-traced repo-wide in ../carrier/engine.ts, fed via attach's extra accs/index
};
