// A community code adapter: `bus.topic("name")` → a queue produce key. Self-contained KeyKind (no engine import).
const RE = /bus\.topic\(\s*["'`]([^"'`\s]+)["'`]/g;
export default {
  kind: "queue", nodeKind: "topic", produceEdge: "queue-publish", consumeEdge: "queue-subscribe",
  name: "acme-bus", blurb: "bus.topic('x') → queue publish",
  scan(file, text) {
    const out = []; let m; RE.lastIndex = 0;
    while ((m = RE.exec(text))) out.push({ kind: "queue", value: m[1], line: text.slice(0, m.index).split("\n").length - 1, produces: true });
    return out;
  },
};
