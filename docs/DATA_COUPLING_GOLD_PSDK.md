# Gold spec — homemade-framework data-coupling (pokemonsdk `.rxdata`)

Status: **SPEC, not yet a runnable gold** (2026-06-18). Blocked on the Ruby **qualified-call /
method-call resolution** gap in the resolver (memory `bidirectional-policy-flow.md`) — teacher 1
(carrier-tracing) can't follow `vd.write_data` → `Yuki::VD#write_data` until that lands. This file is
the harness target to materialize *once it does*. Grounds the **teacher architecture** (memory
`teacher-architecture.md`).

## Why this corpus

PSDK's pokemonsdk is a **homemade data framework** in Ruby: all game data lives in `.rxdata`
(uncompiled) / `.dat` (compiled VD container) files, written and read by in-repo primitives. It is the
canonical test that **the homemade framework is the *easy* case for carrier-tracing** (the wrapper
bodies are in the repo and bottom out at a known sink), and it contains — in real code, not a toy — a
clean ladder of all four key-forms, one per teacher/provenance tier.

Repo: `/home/scorbutics/dev/PSDKTechnicalDemo/pokemonsdk` (also `lethalmon/pokemonsdk`).
Use the **PSDK Ruby game engine** (pokemonsdk), NOT the PSDK app or LiteRGSS (no stored data).

## The carrier stack (what teacher 1 must learn)

Every carrier is in-repo and reaches a `Marshal`/`File.binwrite` sink — so direction + medium are
recoverable deterministically by tracing-to-sink:

| Carrier | Def | Sink reached | Direction / medium |
|---|---|---|---|
| `load_data(filename)` | `scripts/tools/GameLoader/40_load_data_uncompiled.rb:4` | `Marshal.load(File.binread(filename))` | READ / file |
| `save_data(data, filename)` | `…/40_load_data_uncompiled.rb:11` | `File.binwrite(filename, Marshal.dump(data))` | WRITE / file |
| `load_data` (compiled) | `…/41_load_data_compiled.rb:7` | routes by prefix → `load_data_vd` → `Marshal.load` | READ / VD container |
| `Yuki::VD#read_data` / `#write_data` | `scripts/0 Dependencies/900 Yuki__VD.rb:98` / `:84` | `Marshal.load(@file)` / `@file.write(Marshal.dump(@hash))` | READ / WRITE, VD |

Note the **dual implementation**: uncompiled (`40_…`) and compiled (`41_…`) `load_data` defs are the
same logical channel selected at build time — both bottom out at `Marshal`, so trace-to-sink handles
both. A channel can have multiple carrier implementations.

## The four key-form cases (one per teacher)

### Case 1 — literal key → `RESOLVED` (teacher 1: literal index + carrier-trace)
Consumer:
```ruby
# scripts/4 Systems/003 Map Engine/1 Graphics/320 Sprite_Character.rb:156
$data_animations ||= load_data('Data/Animations.rxdata')
```
Expected: literal `'Data/Animations.rxdata'` keys the channel; `load_data` traces to `Marshal.load`
⇒ READ carrier. **Provenance `RESOLVED`.** (Producer here is *non-code* — see blindspot B.)

### Case 2 — constant ↔ literal → `RESOLVED` (teacher 1 + constant propagation)
Writer (constant) vs writer (literal) on the same channel:
```ruby
# scripts/tools/Tiled2Rxdata/Tiled2Rxdata.rb:11 + :64
ANIMATED_TILES_FILENAME = 'Data/AnimatedTiles.rxdata'
File.binwrite(ANIMATED_TILES_FILENAME, Marshal.dump(ANIMATED_COUNTS))
# scripts/4 Systems/001 Title/002 Scene_Title.rb:122
File.binwrite('Data/AnimatedTiles.rxdata', Marshal.dump({}))
```
Expected: constant resolves to its literal; both key the same channel. **Provenance `RESOLVED`.**

### Case 3 — interpolated / prefix / glob → `RESOLVED_PARTIAL` (teacher 2: string analysis)
> ✅ **Pattern recovery MET (2026-06-18).** `coupling/carrier_channel.ts` recovers the family pattern
> from an interpolated carrier key (`load_data("Data/Text/#{lang}.dat")` → `Data/Text/*.dat`) and couples
> it to matching literals/patterns (symmetric glob expansion). Validated on the real repo (pattern key
> `Data/Text/*.dat` surfaced). It's read-only there because that family's PRODUCER is the compile-time
> `Dir[...]` glob tooling, not a carrier call (blindspot B) — coupling the glob-producer side is future work.
```ruby
# consumer — scripts/tools/Text2CSV.rb:9
Marshal.load(Zlib::Inflate.inflate(load_data("Data/Text/#{lang}.dat")))
# loader routing — scripts/tools/GameLoader/41_load_data_compiled.rb:9
... if filename.start_with?('Data/Text')
# producer registry — scripts/tools/Compilation/project_compilation.rb:228
add_data_files(2) { Dir['Data/Text/Dialogs/*.dat'] }
```
Expected: string analysis yields the family `Data/Text/*.dat` (not an exact literal); producer glob +
loader prefix match at the **family** level. **Provenance `RESOLVED_PARTIAL`** (a partial/prefix key,
honestly not asserted as an exact match).

### Case 4 — runtime-computed interior key → `SUGGESTED` / `OBSERVED` (teacher 2 tail → teacher 3)
The hard case — and **not** metaprogramming (the load path has no `define_method`/`method_missing`);
the obstacle is a **computed string key into a runtime registry**:
```ruby
# reader — scripts/tools/GameLoader/41_load_data_compiled.rb:33
Marshal.load(::Kernel::Loaded[vdfilename].read_data(File.basename(filename).downcase))
# writer — scripts/tools/Compilation/project_compilation_data_builder.rb:44-45
basename = ... File.basename(filename)
vd.write_data(basename.downcase, File.binread(filename))
```
Both sides apply the **same transform** `File.basename(x).downcase`, but neither key is a literal and
the container is a runtime lookup (`::Kernel::Loaded[vdfilename]`). Expected: carrier-tracing still
recovers direction+medium (both reach `Marshal`); the **specific producer→consumer instance** match is
NOT statically provable. **Provenance `SUGGESTED`** (LLM) — or **`OBSERVED`** via the constrained-test
runtime teacher: a `prepend`/`TracePoint` spy on `Yuki::VD#read_data/#write_data` captures the exact
basename pairing in one frame (the symmetric transform makes this the textbook runtime-teacher target).

## Two genuine blindspots to label (distinct kinds)

- **A — runtime-computed interior key** (case 4): the channel abstraction resolves; the exact instance
  does not. Target of teacher 2's string-analysis tail and teacher 3 (runtime).
- **B — non-code producer**: `Data/Animations.rxdata` (uncompiled source asset) has **no in-repo
  writer** — authored by an external editor (Studio/RPG Maker). No teacher recovers a producer that
  isn't code. Deserves a first-class label distinct from "opaque carrier".

## Acceptance (when the gold is materialized)

1. ✅ **MET (2026-06-18).** Teacher 1 (carrier-tracing, deterministic) recovers READ/WRITE + file medium
   for all four carriers on the real repo — `Yuki::VD#write_data→write`, `#read_data→read`,
   `Object#save_data→write[file,serialized]`, `Object#load_data→read[serialized,file]` (6 hops). Built in
   `ts/src/codebase/{ruby_dispatch,carrier_trace}.ts` (slices 1a–1c). The compiled-VD path correctly
   surfaces as the only blindspot (`::Kernel::Loaded[vdfilename].read_data`) = case 4 below.
2. Cases 1–2 resolve to `RESOLVED` deterministically (literal + constant propagation).
3. Case 3 resolves to `RESOLVED_PARTIAL` via string analysis (family match, not exact).
4. Case 4 is honestly `SUGGESTED` (or `OBSERVED` with the runtime teacher), never asserted as exact.
5. Blindspot B (non-code producer) is labelled, not silently dropped.

## Teacher 3 — LLM carrier synthesis (opaque carriers)

Built 2026-06-18 (`coupling/carrier_synth.ts`). For a carrier deterministic tracing leaves OPAQUE
(delegates to an external object → `CarrierEffect.external`, no sink), the LLM reads the method once and
emits a CONSTRAINED signature IR `{direction, medium, keyArg}` — content-hash cached (drift-safe),
grounded to known direction/medium sets (invalid → "not a carrier"), opt-in (`--data-coupling llm`) +
budgeted, served via the shared run_pass LLM seam (host-bus in tests, no API key). This addresses the
OPAQUE-CARRIER class generally; the case-4 runtime-key *instance* match (which specific packed entry)
still needs the runtime teacher. Tests: `ts/test/carrier_synth.test.ts` (opacity signal, IR parse/reject,
opt-in coupling). REMAINING: the harness accept/reject loop (synthesize → run → recover gold edges) ties
into eval/harness.ts — the synthesis + grounding + cache primitives are built; the eval wiring is not.
