// UNIVERSAL adapter: an EXTERNAL HTTP EGRESS — an outbound call to an absolute URL the repo does NOT serve. This
// is the "hot point" the flow LEAVES the system at (Microsoft Graph, an XPlan CRM API, Stripe): a terminal
// boundary with no in-repo other side. Deliberately FRAMEWORK-AGNOSTIC and CROSS-LANGUAGE — it grounds on two
// UNIVERSAL primitives, never an HTTP-client API name (no `client.target`, no `fetch`, no `RestTemplate`), so it
// works the same for Java/Ruby/JS/Python/C without a per-framework floor:
//   1. an ABSOLUTE URL literal (`https?://host[/path]`) — an internal route is a relative `/path` (that's
//      http_route's job); an absolute URL with a host names an EXTERNAL system (RFC-3986, not a framework value).
//   2. the URL sits in CALL-ARGUMENT position — immediately after `(` or `,` — which is what makes it an outbound
//      CALL and not an XML/RDF namespace or a config constant (`namespace = "http://…"`, `@WebService(targetNamespace=…)`
//      are `=`-preceded and excluded). Purely structural: the same shape in every language.
// The key is the HOST (the external system), so all calls to `graph.microsoft.com/*` couple to one boundary.
// Produce-only (the code calls out); there is no consumer to grow into. This is the deterministic FLOOR for the
// obvious egresses (a URL literal); a config-injected base URL with no literal is left to the LLM flywheel.
import type { KeyHit, KeyKind, MaskCtx } from "../types.js";
import { lineOf, maskComments } from "./util.js";
import { httpClientVarArgRegex } from "../frameworks/http_clients.js";

export const HTTP_EGRESS_META = { kind: "egress", nodeKind: "egress", produceEdge: "egress-call", consumeEdge: "egress-return" } as const;

// A URL literal in CALL-ARGUMENT position: preceded (across the opening quote) by `(` or `,` and optional space.
// Captures the scheme+host; the path is dropped (the boundary is the external SYSTEM, keyed by host).
const EGRESS_CALL = /[(,]\s*["'`]\s*(https?:\/\/[A-Za-z0-9.-]+)(?:[/:?#][^"'`\s]*)?["'`]/g;

function scan(file: string, text: string, masked?: MaskCtx): KeyHit[] {
  text = masked?.comments ?? maskComments(text);   // a URL in a comment is not a real egress (shared mask across adapters)
  const out: KeyHit[] = [];
  let m: RegExpExecArray | null;
  EGRESS_CALL.lastIndex = 0;
  while ((m = EGRESS_CALL.exec(text)) !== null) {
    const host = m[1].replace(/^https?:\/\//, "").toLowerCase();   // the external host — the boundary identity
    if (!host || !host.includes(".")) continue;                    // must be a real host (has a dot); a bare word is not
    out.push({ kind: "egress", value: host, line: lineOf(text, m.index), produces: true, label: host });
  }
  // VARIABLE-URL egress (the webhook shape the literal floor misses: `fetch(subscriberUrl)`, `axios.get(webhook.url)`).
  // Here the URL isn't a literal at the site, so an ABSOLUTE-URL test can't fire — instead we ground on the OTHER
  // closed primitive: the callee is a KNOWN HTTP client (fetch/axios/… from the http_clients REGISTRY, a runtime
  // primitive that ALWAYS does HTTP), so `<client>(<expr>)` IS an outbound call regardless of what the URL variable
  // holds. Keyed by the arg expression's last segment (`subscriberUrl`, `url`) as a descriptive boundary label —
  // terminal/produce-only, so no cross-file consumer merge to worry about. This stays framework-agnostic in spirit:
  // the seed is the registry client set, never a hand-matched URL name.
  const varRe = httpClientVarArgRegex();
  varRe.lastIndex = 0;
  while ((m = varRe.exec(text)) !== null) {
    const expr = m[1];
    const seg = expr.slice(expr.lastIndexOf(".") + 1);             // last member segment — the URL variable's name
    if (!seg) continue;
    out.push({ kind: "egress", value: seg, line: lineOf(text, m.index), produces: true, label: seg });
  }
  return out;
}

export const HTTP_EGRESS: KeyKind = { ...HTTP_EGRESS_META, name: "http-egress", blurb: "outbound call to an absolute external URL (any language) — a terminal HTTP egress boundary", scan };
