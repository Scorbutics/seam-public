import { Client } from "./client";

// Exported dispatcher: the only caller of the private fromStripe/fromExternal helpers, in this file.
export async function enrich(client: Client, external: boolean) {
  return external ? fromExternal(client) : fromStripe(client);
}

// Private — never exported, never imported anywhere. Its sole consumer is `enrich`, same file.
function fromStripe(client: Client) {
  return client.charge();
}

function fromExternal(client: Client) {
  return client.refund();
}

// Same-file NON-call reference: fromStripe is stored in a dispatch table here, not invoked. The
// import scan can't see it and it isn't a call — a heuristic name match → RESOLVED_PARTIAL.
export function register(map: Record<string, unknown>) {
  map["stripe"] = fromStripe;
}
