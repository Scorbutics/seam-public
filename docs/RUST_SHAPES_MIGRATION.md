# Migrating the SHAPES + coupling overlay to the Rust core

Working plan. Written 2026-07-26 at commit `077215d`. Everything below was measured, not assumed —
re-measure before trusting it, the commands are given so you can.

---

## 1. Where the strangler actually stands

**Rust serves exactly ONE runtime path: the deterministic structural grow.**

```
ts/src/codebase/grow/orchestrate.ts:1227
if (rustCoreEnabled() && deterministic && !intentShapesGrow
    && rustCanParse(anchorFile) && rustCanServeRepo(repo))
  return growViaRust(repo, anchorFile, symbol, opts);
```

Four gates, each load-bearing (the comment above it explains why): the addon has no embedding field, so an
intent-shaped grow routed there silently returns a different region; streaming grows stay in TS; and an
unparseable anchor or repo degrades *silently* rather than erroring, so `rustCanParse` / `rustCanServeRepo`
fence it.

Everything else is TS: all 10 `--query` shapes, the render layer, diff mode, the CLI.

| Path | Engine today |
|---|---|
| `--auto` grow (structural, parseable, non-streaming) | **Rust** |
| all `--query` shapes | TS |
| shape cross-stack overlay (`coupling/bridge.ts`) | TS |
| intent-shaped / streaming / unparseable grow | TS |
| diff mode, render, CLI | TS |

Sizes: TS engine 30,817 lines / 186 files. Rust 17,500 lines across 9 crates.

**Coupling IS ported** — `seam-couple` is 5,777 lines (46 files: `adapters/`, `frameworks/`, `ground/`,
`learn/`) against TS coupling's 6,358 (44 files). `seam-grow` calls `resolve_coupling_scoped`, and napi
exposes `scan_file_keys`, `adapter_keys`, `floor_base_index`, `mask_comments`, `builtin_adapters`,
`other_side`. So when a grow routes to Rust, coupling runs in Rust including the flywheel replay.
(An earlier assessment in-session said coupling had "no Rust counterpart" — that was wrong, from listing
TS dirs without checking the crates. Don't repeat it.)

**Shapes in Rust**: `seam-shapes` is 1,027 lines — `project_set.rs`, `impact.rs`, `contract.rs`,
`neighborhood.rs`, `compare.rs`, `reach.rs`, `refactor_facts.rs`, `collate.rs`.
napi exposes 6: `project_impact`, `project_contract`, `project_consumer_set`, `project_dependency_set`,
`project_neighborhood`, `project_compare`. ~~**No napi for `reaches` or `refactor`**~~ — WRONG when written:
`find_reach` and `gather_refactor_facts` were already exported (that is how `rust/parity/reach.ts` and
`shapes_set.ts`'s refactor block run at all). Verify with `node -e "console.log(Object.keys(require('./rust/seam_core.node')))"`
before believing any list here. ~~**`writers` and `coupling` shapes have no Rust at all.**~~ — ported in
Step 3 (`seam-shapes/src/writers.rs`, `coupling_shape.rs`).

**As of Step 3 every shape has a Rust implementation AND a napi entry.** What remains before wiring is Step 4
(flip one shape at a time behind the grow's guard) — plus the LLM-side gaps named below, which stay on TS.

---

## 2. THE GATE — run this first, every time

```bash
cd /home/scorbutics/seam-phase0
bun rust/parity/shapes_set.ts /home/scorbutics/dev/cal.com 40 "*.ts"
```

Measured at `077215d`: **90 ok / 4 bad**. It must reach **94/0 before anything is wired.**

There are ~50 more harnesses in `rust/parity/` (`otherside.ts`, `consumersgraph_ts.ts`, `impact.ts`,
`contract.ts`, `reach.ts`, `neighborhood.ts`, `compare.ts`, `resolvecoupling.ts`, `growfull.ts`, …).
They are byte-identical comparators, not smoke tests — use them as the acceptance criteria.

**Cache trap:** a warm `.seam/rust` replays a pre-fix grow and makes a fix look like a no-op. This cost real
time twice. Bump `ENGINE_EPOCH` in the Rust core whenever addon behaviour changes (the auto-derived hash
covers `ts/src` only, not the addon), and `rm -rf <repo>/.seam` when measuring cold.

---

## 3. Order of work — this order is not optional

### Step 1 — mirror the TS fixes Rust is behind on. **Prerequisite for everything.** ✅ DONE

**Measured at the Step-1 commit: `shapes_set.ts` 94 ok / 0 bad, `consumersgraph_ts` 22/22, `contract` 200/200,
`impact` 23/23, `reach` 72/72, `compare` 34/34, `neighborhood` 5/5, full-grow parity nodes+edges+order OK,
suite 1309 pass / 2 skip / 0 fail.** What was actually behind, which is NOT quite what §1 predicted:

- The barrel `:1` (8dccfbf) was as described — `Consumer.line`, `GraphNode.unlocated`, `start_of` in the three
  projections that fall back to a node range.
- The `contract.provides` undercount was TWO gaps, only one of them 7184ecb: the default-slot mapping in
  `scan_module_consumers` **and the default slot as an exported member** (fd61636's module-grain half,
  which needed `wrapped_impl` + `default_export_local` in `seam-lang::ast`). The remaining 2 anchors were a
  THIRD, older gap the doc did not predict: **type-level exports** (`export type|interface|enum`) had no Rust
  counterpart at all, so `provides`/`unused_exports`/`afferent` all undercounted. `consumer_count` was also
  edge-grained, not file-grained (`countUnits(cons).files`).
- Of the "check for drift" list: `a4addc2` was already ported; `572db9c`/`45f7f5e`/`2f0abc1`/`71ec09b` ported.
  **`72df701` (bare same-name call vs imported free function) was NOT** — ported here (`ref_lines_split`,
  `import_binds_elsewhere`); non-vacuous: RegularBookingService#createBooking was 9 in Rust, 8 in TS.
  **`86c503f` (the 0→1-based line contract for impact/reaches) was NOT** — ported here; impact cited every line
  one short (`633` vs TS `634`), and `reach` also had the pre-86c503f edge-line-first ordering.
- `ENGINE_EPOCH` → `rs7`. Regression test: `ts/test/grow/rust_shape_fixes.test.ts` (hermetic, addon-guarded,
  pins all four ports against the addon; verified non-vacuous — 5/5 fail against the pre-port addon).
- Still TS-only in `reach`: the COUPLING steps (`to1(hit.line)` / `to1(s.line)`) — Rust `find_reach` has no
  coupling branch at all. That belongs to Step 2/3, not to a `reaches` wiring.

Original analysis, kept for the record:


The 4 parity failures are exactly today's TS fixes not yet ported. Wiring shapes to Rust *before* this
would REGRESS the product — it reintroduces defects that cost graded benchmark rounds.

1. **Barrel re-export cited at `:1`.**
   `consumers useBooking.ts#useBooking` → TS `platform/atoms/index.ts|25`, Rust `|1`.
   Line 25 really is `export { useBooking } from "./hooks/bookings/useBooking";`; line 1 is unrelated.
   TS fix: `8dccfbf` — the `0` sentinel leaked from the edge into the *node range* and rendered as `:1`.
   Also relevant: `86c503f` (one 0→1-based conversion point, `to1`), `2e4aebd` (grow renders).
2. **`contract.provides` undercounts** (3 anchors: `getAllPossibleWebsiteValuesFromEmailDomain` 1 vs 0,
   `getDynamicEventName` 4 vs 3, `processWorkingHours` 9 vs 6).
   TS fix: `7184ecb` (module contract dropped EVERY default-import consumer — the reported set was
   *disjoint* from the real one) and `fd61636` (`export default wrapper(fn)` reported "No callers"; the old
   test was a name regex, which is the brittle-proxy antipattern CLAUDE.md warns about).

Other TS fixes to check for Rust drift while you are in there — all landed today, all in scan/consumers:
`572db9c` (call-line grounding), `a4addc2` (factory/DI receiver narrowing), `72df701` (bare same-name call
vs imported free function), `45f7f5e` (bound self-member `this._m.bind(this)`), `2f0abc1` (DI-injected
member calls — already mirrored, epoch rs3), `71ec09b` (field-bound function members in the class method
set — already mirrored, epoch rs6).

**Exit criterion:** `shapes_set.ts` → 94/0, and `consumersgraph_ts.ts` stays green (it reports 22/22 on its
default keycloak args, not the 39/39 quoted above — re-measure, don't chase the number).

### Step 2 — port the cross-stack overlay to the Rust shapes. ✅ DONE

`seam_couple::coupling_other_sides` (`crates/seam-couple/src/apply/bridge.rs`) + `grep_files` + a `BridgeCtx`
carrying the three per-run pieces TS keeps on `EngineCtx` (file→keys memo, candidate scan budget,
truncations). napi: `couplingOtherSides(repo, file, symbol) -> { sides, truncations }`.

**Measured: `shapes_set` 214 ok / 0 bad** (was 94 checks, now 214 — each anchor also runs `data_coupling` ON
and the overlay + its truncations), `couplingsides` 50/50, `otherside` 2594/0, `resolvecoupling` 119/0, suite
1313 pass / 2 skip / 0 fail. On the flagship anchor the two engines agree exactly, truncation included:

```
getBusyTimes → 6 crossings (db-table booking, all db-write), identical files/symbols/edge kinds
              trunc: db-table booking, scanned 462 of 1147, reason reader-cap
```

Both of the fixes the plan said to carry ARE carried, and both were verified NON-VACUOUSLY:
- `9dade09` (path-sorted `grep_files`) — with the sort removed, 3 identical runs of that anchor gave scanned
  276 / 518 / 346 and DIFFERENT crossing sets; restored, 462 every time. The lottery is real, and the sort is
  the whole fix.
- `45f7b7e` (bound COST, not input) — no candidate cap; the budget is charged only on a cache MISS, so it
  bounds work, not list length. `READER_CAP=6` stands, and the truncation is emitted with kind/value/scanned/
  total/reason.

TWO THINGS TO KNOW BEFORE STEP 4:
- The overlay is NOT part of `project_consumer_set`, on either engine, and should not become part of it. The
  structural set is coupling-free BY CONTRACT (queries.ts: per-node coupling there disabled the footprint cache
  and bought nothing) and the CLI composes set + overlay. The Rust side mirrors that separation, so the
  `data_coupling` parameter on `project_consumer_set` still means "build the footprint with the coupling
  overlay", NOT "attach cross-stack".
- ~~`data_coupling: true` LOSES a resolved structural member~~ — FIXED (the `merge_resolved` last-wins identity
  bug; see §7). The comparator that found it stays: it pins the two engines agreeing at the same flag setting.
- The LLM anchor-key proposal (`--data-coupling llm` → `anchorProposedKeys`) has NO Rust counterpart YET, so
  the Rust bridge is the `SEAM_COUPLING=floor` answer. Wiring must keep an LLM-requested overlay on TS until
  §6b/B2 lands — that is scheduled, not permanent.

Regression test: `ts/test/coupling/rust_bridge_cross_stack.test.ts` (hermetic, addon-guarded) — finds the
crossing nothing links, byte-identical to TS, states its bound, and is identical across repeated runs.

Original analysis, kept for the record:

```ts
addon.projectConsumerSet(repo, "packages/features/busyTimes/services/getBusyTimes.ts",
                         "getBusyTimes", /*data_coupling*/ true)
```
returns the **same 4 structural members** as `false`. TS returns `resolved: 4 | cross-stack: 6` — the six
real `prisma.booking.update` writers. The flag is accepted and ignored.

Rust has the *primitive* (`seam_couple::other_side`, floor-index key→counterparts) but not the TS
*strategy*: `couplingOtherSides` in `ts/src/codebase/coupling/bridge.ts` finds the anchor's keys, targeted-
greps candidates, then materialises counterparts. Port that, and carry BOTH of today's fixes with it or you
will reintroduce them:

- `9dade09` — `grepFiles` must return **path-sorted** output. `rg -l` emits in thread-completion order, and
  a bounded scan over an unordered list is a lottery (the same query answered 1–6 crossings run to run).
- `45f7b7e` — `_TARGETED_CAND_CAP = 200` capped the *input* when it meant to bound *cost*; removed, with a
  per-run scan budget and a stated truncation line. Recall on `db-table booking` went 2 → 6.
- `READER_CAP = 6` still bounds materialisation; 20 of 26 writers remain unlisted **by design**, and the
  truncation must stay stated (honesty contract).

Gate: `rust/parity/otherside.ts` and `rust/parity/resolvecoupling.ts`, plus a new shapes-with-coupling
comparator (extend `shapes_set.ts` to run each anchor with `data_coupling` on and off).

### Step 3 — fill the missing shapes. ✅ DONE

**Step 3a was already done before this session started** — `find_reach` and `gather_refactor_facts` have had
napi entries all along; §1's "no napi for reaches or refactor" was simply wrong (`rust/parity/reach.ts` calls
`addon.findReach`, and it reports 72/72). Nothing to do; §1 corrected.

**Step 3b — `writers` + `coupling` ported.** They live in the CLI on the TS side (`runWritersSet` /
`runCouplingSet` in `ts/src/cli/queries.ts`), so the Rust port is the MODEL half only (render stays TS):
`seam-shapes/src/writers.rs`, `seam-shapes/src/coupling_shape.rs`, napi `projectWriters` / `projectCoupling`.
Two primitives had to come with them — `symbol_span` and `accessColumns` — now in
`seam-couple/src/apply/columns.rs`.

**Measured: `rust/parity/writers_coupling.ts` 60 ok / 0 bad over 30 anchors** (29 non-trivial, 9 exercising
COLUMN grain — the harness reports that count, because a sample that never reaches the column intersection
would otherwise read green while proving nothing). Also cold: `shapes_set` 214/0, `reach` 72/72,
`couplingsides` 24/0, suite 1323 pass / 2 skip / 0 fail.

The harness's ORACLE is the CLI itself (`--emit-seams`), since these shapes have no importable model module —
stricter than importing a helper, because it pins the whole answer a user receives. Two CLI bugs fell out of
building it, both fixed here:
- `--emit-seams` was SILENTLY IGNORED on both shapes' empty path (`return 0` before the emit), so a
  programmatic caller could not tell "reads no table" from "the query crashed" — no file either way.
- the `writers` empty model omitted `columnGrain`/`filterColumns`, which the non-empty one carries and the
  renderer reads unconditionally. A consumer should not have to special-case the shape of an empty answer.

Regression test: `ts/test/coupling/rust_writers_coupling_shapes.test.ts` (hermetic, addon-guarded). Its
expectations were verified against the TS engine on the SAME fixture, so it pins shared behaviour rather than
a Rust quirk: writer found across files nothing links; column grain drops a writer that touches only
un-filtered columns and KEEPS an opaque one flagged unverified; both roles; and the honest empty.

### Step 4 — wire, one shape at a time.
Reuse the grow's guard verbatim — `rustCoreEnabled() && rustCanParse(anchorFile) && rustCanServeRepo(repo)`
— in `ts/src/cli/queries.ts`. Each shape flips only when its comparator is byte-identical. Keep the TS
implementation until every shape is green: it is the parity oracle.

---

## 4. Invariants — violating any of these has already cost a graded round

- **Never fabricate a line.** Internal values are 0-based; anything rendered `file:line` is 1-based via the
  single `to1` (`ts/src/core/lines.ts`). An unlocated node renders with NO line, never `:0`/`:1`.
- **Never turn a capability gap into an empty answer.** A parser outage, an undeclared anchor, or an
  unresolvable default export must FAIL LOUDLY (exit 2), not render "nothing calls this". Guards:
  `2c8b996`, `51f8189`, `fd61636`. But *preserve* the honest empty: a declared, genuinely-uncalled symbol
  must still report "No callers" — that proof-of-absence won a benchmark round.
- **No repo-wide name fallback.** Only emit an edge when the receiver/type genuinely resolves. Five pinned
  tests guard removed false positives: `callsite_factory_receiver`, `intrafile_name_collision`,
  `spine_partial_edge`, `injected_member_call`, `field_fn_member_consumers`.
- **Suppress by hub-ness, never coupling in general.** A narrow shared key is the highest-value thing Seam
  produces (it is what text search cannot find, and it won B2 by surfacing a Postgres denormalization
  trigger). Only ubiquity gets demoted.
- **State every bound.** Truncation/suppression must say so and how to raise it.
- **Determinism.** 3 cold runs (`rm -rf <repo>/.seam`) byte-identical, or it is not done.

---

## 5. Standing collateral checks (run after every change)

```bash
cd /home/scorbutics/seam-phase0/ts
# 36 grammars, or the engine silently returns zero for everything
ls node_modules/tree-sitter-wasms/out/ | wc -l

R=/home/scorbutics/dev/cal.com
bun src/cli/decompose.ts --scan --repo $R --query consumers \
  --center "packages/features/busyTimes/services/getBusyTimes.ts#getBusyTimes" --format llm-context
#   → 4 usage sites (2 consuming symbols in 2 files) | cross-stack: 6, at lines 582/66/94/116

bun src/cli/decompose.ts --scan --repo $R --query consumers \
  --center "packages/features/bookings/lib/service/RegularBookingService.ts#createBooking" --format llm-context
#   → 8 usage sites   (MORE than 8 = new false positives)

bun src/cli/decompose.ts --scan --repo $R --query impact \
  --center "packages/trpc/server/routers/viewer/slots/util.ts#_getAvailableSlots" --format llm-context
#   → impacted: 31 | files: 29, with 15 apps/api/v2 lines incl. both slots controllers
#     (30|28 above was pre-fd61636; that commit documents 31|29 as a TRUE POSITIVE — re-measured, it holds)

bun src/cli/decompose.ts --scan --repo $R --query consumers \
  --center "packages/features/schedules/lib/slots.ts#getSlots" --format llm-context
#   → 45 usage sites in 3 files  (wrapped default export; was "No callers")

bun test        # 1304 pass / 2 skip / 0 fail at 077215d
```

Env canary (a broken `node_modules` symlink once made every query silently return zero for an hour):
`/tmp/.../scratchpad/eval/canary.sh` — grammars + fixture + a real cal.com alias resolution. Rebuild it if
the scratchpad is gone; the fixture alone is NOT sufficient, it passed throughout that outage.

---

## 6. Do NOT

- **Do not remove the TS engine.** It is not superseded — one routing site, and the shapes/render/diff/CLI
  are TS-only. Removing it deletes the product.
- **Do not bulk-regenerate parity oracles** to make a change pass. Verify each changed value by hand against
  the fixture and say you did. Two fixtures today had encoded a bug as expected behaviour; both were
  corrected *and tightened*, not loosened.
- **Do not `git stash`** with concurrent work in the tree — it silently reverted another worker's in-flight
  edits once.
- **Do not trust a green repro after an addon change** without bumping `ENGINE_EPOCH`.

---

## 6b. THE FLYWHEEL MOVES TO RUST (decided 2026-07-26)

**Target: the Rust core is SELF-CONTAINED — it holds the whole flywheel, and no flywheel logic stays in TS.**
The core spawns the model ITSELF (decided explicitly; the alternative — keeping a thin JS driver, which is
what `discover.rs` was built for — was rejected). TS keeps render + CLI + diff only.

Where the flywheel actually lives, measured (do not trust a summary — `ls` the crates):

| axis | LEARN (cold, LLM) | REPLAY (warm, deterministic) |
|---|---|---|
| matcher rules | **Rust** `learn/discover.rs` (state machine) | **Rust** `learn/matchers.rs` |
| per-file keys | TS `llm_key_index.ts` | **Rust** `learn/key_index/files_cache.rs` |
| anchor-proposed keys | TS `anchorProposedKeys` | n/a (per-query) |
| composed routes | TS `route_composer.ts` | **Rust** `learn/key_index/compose_routes.rs` |
| receiver classification | TS `receiver_class.ts` | via the matcher store → Rust |
| carrier synth | TS `carrier/synth.ts` | — none |
| effect inference | **Rust** | **Rust** |

So every REPLAY path is already Rust; what remains is the COLD half of four axes (~1,000–1,200 lines of TS).

**A — the transport. ✅ DONE.** `crates/seam-llm` ports `ts/src/core/llm.ts`: backend resolution
(`CLAUDE_BIN` → PATH → newest VS Code extension binary → `COPILOT_BIN`/PATH, with a bad `--claude-bin` an
ERROR not a silent fallback), claude arg/env building + envelope parse + usage metering, copilot's
prompt-file + MCP-config isolation, the hang-guard timeout, upgrade-only tier routing, and
`extract_json_array`. napi: `llmResolveBackend`, `llmAvailable`, `llmRouteModel`, `llmExtractJsonArray`,
`llmRunPass`, `llmUsage`. Gate: `rust/parity/llm_transport.ts` 17/0 (resolution, routing, and 10 reply-parse
cases incl. the ones that MUST fail), plus `--live` (one real pass through both transports; it compares that
both SUCCEED, not that the text matches — the model is not deterministic). Measured live: both OK, usage
metered. 5 Rust unit tests.

**Order for the rest** (each: port the cold half as Rust-owned logic calling `seam-llm`, add a comparator,
keep the TS path until its comparator is green):
B1 per-file keys (`llmKeyIndex` llm-on) — the biggest recall lever.
B2 `anchorProposedKeys` — small, and it is what makes the Step-2 bridge's LLM mode Rust-native.
B3 `route_composer` LLM branch. B4 `receiver_class`. B5 `carrier/synth`.
Only after B1–B5 does the Step-2 caveat "an LLM-requested overlay must stay on TS" disappear.

---

## 7. Open, separate from this migration

- ~~**`--data-coupling` can DELETE a verified structural member from the consumers shape.**~~ **FIXED.** Found
  by the Step-2 comparator, on BOTH engines. Root cause was NOT the coupling scan: `merge_resolved` dedups
  nodes by content key (`file#startLine#kind`) and built that index LAST-wins, while the overlay legitimately
  mints a TWIN of a unit the structural pass already has — including the ANCHOR itself, when the anchor's own
  method is a complement of a key reached through another file. So the anchor's key resolved to the twin and
  every merged-in edge was re-pointed at it (`c1 -> n1` became `c1 -> dc6`); the projection reads edges to
  `anchor.id`, found none, and printed "## No callers". Fix: build the index FIRST-wins (the anchor is
  nodes[0], and the structural pass precedes the overlay, so the survivor is always the structural node).
  Measured on the reported anchor: `resolved: 0 usage sites / ## No callers` → `resolved: 1 usage site`, with
  cross-stack 10 unchanged. `ts/test/scan/coupling_twin_edge_capture.test.ts`.
  Still open, lower severity: the overlay mints that twin at all instead of reusing the existing node id, so a
  `--data-coupling` graph carries a redundant duplicate of any unit it re-materialises. Harmless now that
  identity is stable, but it is why the collision exists.

- **`--format concern` vs `--concern` diverge.** `isConcern` (gating `SEAM_GROW_STRUCTURAL`) reads
  `a.concern` only, so `--format concern` forces a structural grow then switches the star on afterwards —
  the two spellings grow differently for the same question. Normalising it in `parseArgs` fails 6 existing
  behavioural tests. Settle by grading a concern-shaped intent both ways BEFORE landing; do not just update
  the oracles. See memory `seam-format-cleanup`.
- **Rust↔TS depgraph parity on keycloak: 170 identical / 57 mismatches**, pre-existing and unexplained.
  Worth understanding before trusting Rust on Java.
- **The eval is 18/30 graded** (5 wins, 5 ties, 8 losses contested). A9/B9 have both answers written and
  need only graders. Blocked on the 200-subagent session cap.
