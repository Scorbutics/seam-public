# Framework plugins

Seam's framework knowledge is **data + small adapters**, not engine internals. You can teach it a new framework
without forking or recompiling, via two extension points loaded at startup. Both live under a plugin root:

- **User-global (trusted):** `~/.config/seam/` — always loaded (override with `SEAM_CONFIG_HOME`).
- **Repo-local:** `<repo>/.seam/` — the **manifest** (data) always loads; **code adapters** load only under
  `SEAM_REPO_PLUGINS=1` (a repo you clone could ship a malicious plugin, so code from a repo is opt-in).

## 1. Declarative manifest — `frameworks.json` (the 80% case)

Most "add a framework" is vocabulary: *which annotations declare an HTTP route, and which verb each implies.*
That's data. Drop `~/.config/seam/frameworks.json`:

```json
{
  "routeAnnotations": [
    { "annotation": "MyGet",  "httpMethod": "GET",  "framework": "myfw" },
    { "annotation": "MyPost", "httpMethod": "POST", "framework": "myfw" },
    { "annotation": "MyRoute", "framework": "myfw" }
  ]
}
```

`annotation` is the bare decorator/annotation name (no `@`). `httpMethod` is optional (omit for a base path like
JAX-RS `@Path` / Spring `@RequestMapping` where the verb is elsewhere). Seam's route scan is already
framework-agnostic on *shape* (`@Name("/literal")`, class+method path composition) — the manifest only supplies
the names and verbs, so `@MyGet("/users/{id}")` grounds to a `fetch("/users/…")` **with** its method.

## 2. Code adapter — `plugins/*.mjs` (the 20% case)

For a novel structural shape a name table can't express (a custom client call, an ORM idiom, a message bus),
write a `KeyKind`: a self-contained module (no engine import) default-exporting `{ kind, nodeKind, produceEdge,
consumeEdge, scan }`. Drop it in `~/.config/seam/plugins/`:

```js
// ~/.config/seam/plugins/acme_bus.mjs — `bus.topic("name")` → a queue produce key.
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
```

Each `scan` returns `KeyHit[]` — `{ kind, value, line, produces, label?, method? }`. `produces:true` = this file
*emits/serves/writes* the key; `false` = it *consumes/reads* it. Two files that share the same `(kind, value)`
across the boundary become a coupling crossing. Reuse a builtin `kind` (`http-route`/`db-table`/`queue`/…) to
plug into existing boundary semantics, or introduce your own (it gets generic edges).

Registered plugins show up in `seam-adapters` and are folded into the coupling cache key, so adding one
invalidates stale caches automatically.
