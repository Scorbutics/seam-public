// The public --emit-seams JSON contract. This is the stable boundary every CLIENT consumes —
// the VS Code extension, the MCP server, and (later) an IntelliJ plugin — so its shape is a
// product surface, not an internal detail. Bump SEAM_SCHEMA_VERSION on any BREAKING change
// (removed/renamed field, changed meaning); additive optional fields do NOT bump it. The schema
// itself is documented in docs/SEAM_JSON_CONTRACT.md.
export const SEAM_SCHEMA_VERSION = 1;

// Stamp the contract version onto a seam model right before it is written, so every consumer can
// detect a mismatch with one check (model.schemaVersion). Mutates and returns the same object so
// it threads through `writeFileSync(p, JSON.stringify(stampSeamModel(model)))` cleanly.
export function stampSeamModel<T extends Record<string, any>>(model: T): T {
  (model as any).schemaVersion = SEAM_SCHEMA_VERSION;
  return model;
}
