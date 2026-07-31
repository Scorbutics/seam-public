# Seam — the couplings your language server can't see

Seam answers structural questions about a codebase: *who calls this, what breaks if I change it, what is this
module's contract, and — the part nothing else does — **what is connected to this through a database table, an
HTTP route or a config key, with no import and no call between them.***

Offline and deterministic by default. No API key, no index server, no model required.

```bash
seam --repo . --scan --query coupling --anchor-file app/api/admin/report-snapshots/route.ts
```

```
# Coupling of route (cross-stack data boundary)
anchor: route | shape: coupling | shared keys: 2 | counterpart sites: 2

## db-table "report_snapshots"  — anchor reads
  ← upsertReportSnapshots (backend/supabase/functions/_shared/partner/snapshots.ts:61)  [function, writes report_snapshots]
        60│ const { data, error } = await serviceClient
        61>   .from('report_snapshots')
        62│   .upsert(rows, {

## http-route "/api/admin/report-snapshots"  — anchor writes
  → fetchAdminReportSnapshots (lib/services/admin-referrals.ts:315)  [function, reads /api/admin/report-snapshots]
        314│   const headers = await authHeader()
        315>   const res = await fetch("/api/admin/report-snapshots", { headers })
```

Two real edges from one command, and neither is reachable by "go to references": the writer is a **Deno edge
function under a directory `tsconfig.json` excludes** — the language server cannot even load that file — and the
reader reaches this route over HTTP with no symbol in common.

---

## The honest headline: on call sites, a language server ties us

We built a benchmark to try to kill this tool. It mutates a real exported function, compiles with `tsc`, and
treats the compiler's error set as ground truth — so "who calls this" has an unarguable answer. Three arms, same
question, 120 symbols of a real repo:

| arm | exact | under-claims | false files |
|---|---|---|---|
| `grep` | 102/120 (85%) | **6** | 30 |
| **TypeScript language service** | **120/120 (100%)** | 0 | 0 |
| **Seam** | **120/120 (100%)** | 0 | 0 |

**On TypeScript call sites Seam has no accuracy advantage over a tool you already have.** That goes first because
it is true, and because it frames everything else: the value is not "better references". It is the class of
question where `getReferencesAtPosition` returns *nothing at all*.

For that class, the judge is **git history** — neither Seam nor a compiler, and written by people who never heard
of this tool. If two files are genuinely coupled, engineers had to change them together:

| corpus | Seam pairs co-change | name-search | random (distance-matched) |
|---|---|---|---|
| a 400-commit product repo | **80.0%** | 45.3% | 8.2% |
| keycloak (2881 commits) | **31.5%** | 16.0% | 3.6% |

Per mechanism — and **watch the same-language column**, because that is the point:

| corpus | kind | co-changed | same-language? |
|---|---|---|---|
| product repo | `http-route` | 39/39 (**100%**) | all 39 |
| product repo | `db-table` | 19/28 (**67.9%**) | all 28 |
| keycloak | `db-table` | 48/134 (**35.8%**) | all 134 |
| keycloak | `http-route` | 7/42 (16.7%) | **0** — every pair crosses Java↔TypeScript |

A DB table couples two files **in the same language** and a language server still returns nothing: one `.ts`
writing `work_orders` and another `.ts` reading it share no import and no call. That case is the bulk of the
result. Method, controls and the places the tool loses: [`bench/`](bench/).

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/Scorbutics/seam/main/install.sh | bash
#   …| bash -s -- --skill          # + the Claude / Copilot skills
#   …| bash -s -- --branch <ref>   # track a specific branch or tag
```

Installs a `seam` shim to `~/.local/bin/seam`; re-run any time to update. It fetches a **prebuilt native core**
for your platform (linux x64/arm64, macOS arm64/x64) and falls back to building it with `cargo` if there is no
prebuilt. If neither is possible it says so loudly and tells you what to install — it will not leave you with a
tool that crashes on the first query.

<details>
<summary>From source (development)</summary>

```bash
make install                                  # bun deps
cd rust && cargo build --release -p seam-napi && cp target/release/libseam_napi.so seam_core.node
bun ts/src/cli/decompose.ts --help
```
</details>

---

## Codebase mode — the CLI

Everything here is offline and deterministic. `--scan` walks the repo; `--repo` defaults to the cwd.

### `seam --help`

Routes by **question**, not by flag — and tells you when *not* to reach for Seam. If you want a single fact and
you know the name, `rg` is the right tool, and the help says so.

### `--query coupling` — the differentiator

*What is connected to this with no code edge?*

```bash
seam --repo ~/keycloak --scan --query coupling \
     --anchor-file js/libs/keycloak-admin-client/src/resources/authenticationManagement.ts \
     --symbol AuthenticationManagement
```

```
anchor: AuthenticationManagement | shape: coupling | shared keys: 24 | counterpart sites: 85

## http-route "/authenticator-providers"  — anchor reads
  ← getAuthenticatorProviders (integration/admin-client/…/AuthenticationManagementResource.java:55)  [method, writes /authenticator-providers]
        55> @Path("/authenticator-providers")
        56│ @GET
  ← getAuthenticatorProviders (services/src/main/java/…/AuthenticationManagementResource.java:144)  [method, writes /authenticator-providers]
       144> @Path("/authenticator-providers")
       145│ @GET
```

A TypeScript admin client and the Java resources that serve it. **No import, no call, no shared symbol** — they
meet only at the route string. `←` writes what the anchor reads; `→` reads what the anchor writes. Config keys
are symmetric (both sides merely read the same setting) and the output says so rather than inventing a direction.

Provenance is `RESOLVED_PARTIAL` by design: the access is grounded, but whether *this particular field* matters to
your change is yours to judge. Seam does not pretend otherwise.

### `--query contract` — a module's real boundary

*What does this module expose, who consumes it, and how is it actually called?*

```bash
seam --repo ~/cal.com --scan --query contract --center packages/lib/availability.ts
```

```
provides: 5 | unused exports: 3 | depends: 6 | fan-in: 20 consuming files | fan-out: 4 dependency files

## Provides (inbound — exports consumed elsewhere)
- getAvailabilityFromSchedule(schedule: Schedule): Availability[] [function] — 12 consuming files
    observed: 14 call sites — 14×1arg
      verify: rg -o '\bgetAvailabilityFromSchedule\(' --glob '!node_modules' | wc -l   (expect 15 textual hits…)
    ← postHandler (apps/api/v1/pages/api/schedules/_post.ts)
    ← createHandler (packages/trpc/server/routers/viewer/availability/schedule/create.handler.ts)
```

Both halves of a contract: the **declared** signature and what call sites **observe**. A 5-parameter function
every caller invokes with 2 arguments has three parameters nobody exercises; `unused exports: 3` is dead public
API. Every count ships with a `verify:` command, so no number has to be taken on trust.

Follows re-export barrels — named (`export { x } from`), renaming (`export { a as b }`) and star (`export *`) —
which is exactly where hand-rolled reference counting silently under-reports.

### `--query impact` — blast radius

```bash
seam --repo ~/keycloak --scan --query impact \
     --anchor-file services/src/main/java/…/AuthenticationManagementResource.java \
     --symbol getAuthenticatorProviders
```

```
impacted: 267 | files: 105 | surface: 44 | cross-stack: 1 | gaps: 1 | truncated: yes
```

Transitive, with **cross-stack** broken out and `gaps` naming what could not be resolved statically instead of
quietly omitting it.

### The rest

| command | question |
|---|---|
| `--query consumers` | who calls this, as resolved edges |
| `--query dependencies` | what this needs, including DI wiring |
| `--query reaches --to-symbol X` | is there a path from here to X, and what is it |
| `--query refactor` | everything needed before changing a symbol, in one call |
| `--query brief` | the one-call structural bundle |
| `--query writers` | who writes the state this reads |
| `--locate <name>` | where does this name live? Prints **all** definitions — it resolves an address, it does not pick your center |
| `--locate-intent "…" [--scope <dir>]` | you have a task, not a name: ranked candidate anchors for a phrase. Deterministic and offline (lexical overlap, then fan-in) — it ranks addresses, it does not pick your center |
| `--query ask --ask "…"` | natural-language routing to the shapes above (needs a `claude` CLI) |

Render views apply to any of them: `--format llm-context`, `--format waves`, `--format scenarios` (Mermaid).

### Languages

TypeScript/JavaScript, Java, Ruby, Python, C, C++ via vendored tree-sitter grammars. Coupling adapters are
language-agnostic where the mechanism is — raw SQL, config keys and HTTP routes are matched as strings, so one
adapter covers every host language at once.

---

## What it is measured against

Three benchmarks, in [`bench/`](bench/). They exist to find where the tool loses, and they have:

- **[`oracle/`](bench/oracle/)** — correctness judged by `tsc`; `compare.ts` runs grep and the TypeScript language
  service on the same probe. **This harness has falsely accused the engine three times**, each documented in
  place. Falsify a benchmark before believing it.
- **[`coupling/`](bench/coupling/)** — capability and precision on cross-stack mechanisms, with **decoys** (a
  same-named column on a different table; a table name in prose), because a fixture written by the tool's own
  author proves nothing without them. It found a missing config-key adapter on its first run.
- **[`cochange/`](bench/cochange/)** — the co-change numbers above, judged by git history.
- **[`recall/`](bench/recall/)** — what it MISSES, judged by real commits. It shipped with a broken baseline arm
  that scored 0.0% because it threw and was caught; a dead baseline manufactures a win, so it now warns loudly.

### Known limits

- **Recall is now measured, and it is additive rather than dominant.** [`bench/recall`](bench/recall/) replays real
  multi-file commits: show one changed file, ask what else must change, score against the commit. Coupling ALONE
  recalls less than the import graph (8.2% vs 20.0% on one repo; 2.3% vs 7.7% on another) — most files that change
  together are linked by an ordinary import. Its value is the files imports cannot reach: adding it lifts recall
  **20.0% → 26.6%** and **7.7% → 9.8%**, replicated on two corpora. Absolute recall is low because a commit bundles
  unrelated work, which depresses every arm equally — read the arms against each other, never the raw percentage.
- **Route coupling is ASYMMETRIC, and that is a live defect.** Querying the two ends of the same pair can give
  two different answers: on keycloak, `partial-export` resolves from the Java resource to the TypeScript client
  but not the other way, and **20 of 25 route keys on `realms.ts` report no counterpart** despite the counterpart
  existing. The cause is that each side searches for the key as IT spells it (`/partial-export` vs
  `/*/partial-export`). Two contributing gates are fixed; a third has not been found, and the direction that
  breaks flips between repos. See [`bench/coupling`](bench/coupling/) for the full negative result. The flagship
  example above is a case that works — it is not evidence the general case does.
- **Cross-language co-change rests on 42 pairs** in one repo — directionally supported, thinly sampled.
- **The oracle is TypeScript-only** (its judge is `tsc`) and covers `export function`, not arrow exports.
  Correctness on the Java/Ruby/Python sides is not measured by it.
- Coupling edges are `RESOLVED_PARTIAL`: a grounded shared key, never an asserted call.

---

## How it works

1. **Parse** — vendored tree-sitter grammars, one per language, behind a `LanguageProvider` trait.
2. **Resolve** — imports, exports, barrels, DI wiring, per-language module resolution.
3. **Ground** — the coupling floor scans every file for shared keys (tables, routes, config keys, data files)
   through isolated framework adapters; a repo-wide index pairs each key's producers with its consumers.
4. **Project** — every shape is a pure projection over that graph.

The engine is Rust (`rust/crates/seam-*`) behind a thin TypeScript CLI over napi. Framework knowledge lives only
in `seam-couple/src/adapters/`; adding one is a module plus a registry line.

---

## Experimental

### Diff mode

The original entry point, now an addon rather than the main surface. It decomposes a patch into **seams** — units
of one intent — labelling each hunk core/link/environment/test/noise with its wiring:

```bash
seam --file sample.patch --classifier det --format ascii
seam --git main..HEAD --repo . --classifier det
```

`--classifier hybrid|llm` adds product-intent labels via a local `claude`/`copilot` binary when present. Kept
because it is useful for review — but the codebase shapes above are the maintained surface.

### The bridge

`--review` cross-checks a change against the structure it perturbs: a backend-only diff touching a shared table
whose front-end reader is not in the PR gets flagged.

### VS Code extension — DEPRECATED (2026-07-31)

Unused, and no longer built by CI or attached to releases. The source stays in `vscode-extension/` and
`make vsix` still builds it locally, but it is not maintained and its version has drifted from the engine's —
`v0.3.0` shipped a `0.2.4`-versioned `.vsix`, which is what prompted retiring it. Use the CLI.

---

## Contributing

Issues and PRs welcome. If you add a coupling adapter, add its positive case to `bench/coupling/truth.json`
**first** and watch it fail — a gap deleted from a benchmark is a gap nobody measures.
