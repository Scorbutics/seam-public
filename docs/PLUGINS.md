# Framework plugins

Seam's framework knowledge is **data + small adapters**, not engine internals. You can teach it a new framework
without forking or recompiling, via two extension points loaded at startup. Both live under a plugin root:

- **User-global (trusted):** `~/.config/seam/` — always loaded (override with `SEAM_CONFIG_HOME`).
- **Repo-local:** `<repo>/.seam/` — the **manifest** (data) always loads. **Code adapters no longer load at
  all**: the floor that scans is the Rust core and a JS module cannot extend it. An adapter left in a plugins
  dir is reported inert on stderr rather than silently ignored. The old `SEAM_REPO_PLUGINS=1` opt-in is gone
  with it — it guarded against a cloned repo running arbitrary JS, and there is no longer any JS to run.

## 1. Declarative manifest — `frameworks.json` (the 80% case)

Most "add a framework" is vocabulary: *which annotations declare an HTTP route, and which verb each implies.*
That's data. Drop `~/.config/seam/frameworks.json`:

```json
{
  "routeAnnotations": [
    { "annotation": "MyGet",  "httpMethod": "GET",  "framework": "myfw" },
    { "annotation": "MyPost", "httpMethod": "POST", "framework": "myfw" },
    { "annotation": "MyRoute", "framework": "myfw" }
  ],
  "httpClients": [
    { "name": "wretch", "framework": "wretch" },
    { "name": "gaxios", "verbForms": true, "framework": "gaxios" }
  ],
  "ormMethods": [
    { "method": "scan_all", "role": "read",  "orm": "myorm" },
    { "method": "upsert_row", "role": "write", "orm": "myorm" }
  ]
}
```

Three vocabularies, all optional:

- **`routeAnnotations`** — the producer half of the HTTP-route boundary. `annotation` is the bare
  decorator/annotation name (no `@`); `httpMethod` is optional (omit for a base path like JAX-RS `@Path` / Spring
  `@RequestMapping` where the verb is elsewhere). Seam's route scan is already framework-agnostic on *shape*
  (`@Name("/literal")`, class+method path composition) — the manifest only supplies the names and verbs, so
  `@MyGet("/users/{id}")` grounds to a `fetch("/users/…")` **with** its method.
- **`httpClients`** — the consumer half: which receiver names count as a fetch-like call whose first string
  argument is a route path. `name` is the token as written (`wretch`, `$http`); set `verbForms: true` if it's
  also called as `<name>.<verb>(...)` (axios/ky-style: `gaxios.post("/x")`). A *custom instance* with an
  arbitrary receiver (`const api = axios.create(); api.get(...)`) is the LLM tier's job, not a manifest row.
- **`ormMethods`** — for an ActiveRecord-style ORM, which `Model.<method>` calls **read** vs **write** the model's
  table (table = `tableize(Model)`). `method` is the token as written (trailing `!`/`?` included); `role` is
  `"read"` or `"write"`. Keep these AR-distinctive — ambiguous names (`find`/`save`/`delete`) are deliberately
  excluded so ordinary `Const.method` (`File.delete`, `JSON.parse`) doesn't false-match a table.

All three change the coupling floor output, so adding one invalidates a stale cache automatically.

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
