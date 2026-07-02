// CLOSED SIDE-CONCERN VOCABULARY — the source of truth for the taxonomy the intent border drops. A
// side-concern is machinery a flow triggers ALONG THE WAY that is not what the intent is ABOUT (logging,
// audit, notifications…), as opposed to a PEER DOMAIN (billing off a booking flow — a different subject, not
// a concern). This registry — NOT prompt prose — defines the set: the border prompt's DROP sentence is
// DERIVED from it (concernDropSentence), and the learned per-repo concern map labels each module against it,
// so prompt, learning, and gate can never drift (CLAUDE.md: a closed structural set comes from a registry).
export interface ConcernKind { name: string; blurb: string; }

export const CONCERNS: ConcernKind[] = [
  { name: "logging", blurb: "diagnostic logging / tracing" },
  { name: "audit", blurb: "audit trails / activity records" },
  { name: "notification", blurb: "notifications / broadcast to users or channels" },
  { name: "messaging", blurb: "message bus / queue plumbing not carrying the intent's own payload" },
  { name: "auth", blurb: "authentication / authorization / permission checks" },
  { name: "config", blurb: "configuration / feature flags / environment wiring" },
  { name: "export/integration", blurb: "exports / third-party integrations / webhooks out" },
  { name: "search/indexing", blurb: "search indexing / reindexing" },
  { name: "rendering/analytics", blurb: "rendering / charts / analytics / metrics" },
];

export const CONCERN_VOCAB_VERSION = "v1";
// The closed label set an LLM may return for a module (+ `none` for "not a side-concern": the mechanism or a
// peer domain). Used to VALIDATE a learned label — an out-of-set label is discarded (grounding, not trust).
export const CONCERN_LABELS: ReadonlySet<string> = new Set([...CONCERNS.map((c) => c.name), "none"]);
export const isConcernLabel = (s: unknown): s is string => typeof s === "string" && CONCERN_LABELS.has(s) && s !== "none";

// The border prompt's DROP sentence, DERIVED from the registry (so prompt ⇄ taxonomy can't drift).
export function concernDropSentence(): string {
  const list = CONCERNS.map((c) => c.name).join(" / ");
  return `DROP a SIDE-CONCERN even though on-intent code calls it — ${list}, or an unrelated domain. These are `
    + "triggered BY the flow but are not the flow.";
}

// The vocabulary block fed to the module-labelling LLM pass (name — blurb, one per line).
export function concernVocabList(): string {
  return CONCERNS.map((c) => `- ${c.name}: ${c.blurb}`).join("\n");
}
