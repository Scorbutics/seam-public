# Stress test: cal.com, Keycloak, private-app

Ran the CLI surface (9 query shapes, decompose, module mode, depth-2, `--ask`, and the three grow paths —
`grow_intent`, `grow_from`, `concern`, plus center-first `concern`) against three real repos.

| repo | tracked files | dominant | result |
|---|---|---|---|
| private-app | 472 | 249 tsx / 187 ts | **17/17 pass** |
| cal.com | 10,349 | 5,692 ts / 1,677 tsx | 16/17 (one OOM, see below) |
| Keycloak | 12,896 | 8,141 java | **10/17** — 2 timeouts, 3 OOM kills, 2 SIGBUS |

Anchors were chosen as the real fan-in hubs, not guesses: `KeycloakSession` (9,941 resolved consumers),
`customPrisma` (a file imported 1,020×), `lib/utils.ts#cn` (247 consumers).

## DEFECT 1 — `--max-nodes` does not bound the answer

`--max-nodes 5` on `KeycloakSession` returns a **6,365-node** answer. The phase trace shows why:

    [phase] after seed+phase_coupling: 6128 nodes (803 coupling)
    [phase] after phase_expand:        6128 nodes (803 coupling)   <- the flood added ZERO
    [phase] after wave+fan_couple:     6365 nodes (1040 coupling)

`phase_seed` materialises the anchor's whole consumer closure BEFORE any budget applies, then
`phase_expand`'s `while flood_n(&data) < opts.max_nodes` is already false and runs zero steps. The cap only
ever bounded the flood — orchestrate.rs says so ("`max_nodes` bounds the STRUCTURAL FLOOD, not the whole
graph") — but on a hub anchor the seed IS the answer, so the cap does nothing whatsoever.

Measured, same anchor, coupling on: `--max-nodes 5` -> 14.4 GB, `20` -> 14.2 GB, `80` -> 14.4 GB. Memory is
**independent of the cap**.

## DEFECT 2 — per-node memory ~2 MB, so a hub anchor exhausts the machine

6,365 nodes -> 14.2 GB RSS. For contrast, on the SAME anchor a plain `--scan` decompose emits **9,926
symbols in 805 MB**, i.e. 18x less memory for a larger result. So it is not the graph size as such — the grow
path holds something per node that the decompose path does not.

Memory tracks the anchor's consumer set, not the answer:

| anchor | consumers | coupling | RSS |
|---|---|---|---|
| `ValidationResult` | 1 | floor | 1.6 GB |
| `ValidationResult` | 1 | none | 0.7 GB |
| `KeycloakSession` | 9,941 | floor | 14.4 GB (any cap) |
| `KeycloakSession` | 9,941 | none | 14.2 GB |

Coupling roughly doubles the small case but is NOT the cause; the large case is ~14 GB either way. On a 15 GB
machine, whether the OOM killer fires is luck — which is why the same command was seen to exit 0, exit 137
(SIGKILL) and exit 135 (SIGBUS) across runs. The non-determinism is a symptom, not a separate bug.

## DEFECT 3 — a Rust-core change does not invalidate the on-disk cache

`engineEpoch()` (footprint_cache.ts) hashes `ts/src/{codebase,core,languages}/**/*.ts`. The engine is now
Rust, so a core change leaves the epoch untouched and cached answers computed by the PREVIOUS core are served
as current. Demonstrated on `writers-repo`:

| step | core | cache | answer |
|---|---|---|---|
| 1 | current | cleared | 2 write sites |
| 2 | **mutated** (dropped `update` from the db-table WRITE_VERBS) | warm | **2** — stale |
| 3 | mutated | cleared | 1 — the mutation IS observable |

This is the same root cause as the CLI-gate blind spot found earlier (docs/SEAM_FLAGS_AUDIT.md): caches keyed
on repo source, never on engine source. It means a user who upgrades Seam keeps the old engine's answers.

## What is NOT wrong

  * Center detection is cheap: source-dir listing 49 MB/1.3s, candidate recall 63 MB/0.7s on cal.com.
  * The structural decompose scales fine — 9,926 symbols in 805 MB.
  * private-app passes the entire surface, and `depth 2` genuinely differs there (332 vs 248 symbols), so
    the ripple works on a real repo even though no fixture can show it.
  * cal.com's single OOM was `concern` center-first. It did NOT reproduce after the cache was cleared
    (63 s / 453 MB cold, 0.75 s / 193 MB warm), and the original cache state was destroyed before it could be
    captured — so that one is unexplained rather than diagnosed. Given DEFECT 3, a cache written by an older
    engine is the leading suspect.

## Proposed fixes, in order

1. **Bound the seed, honestly.** Cap the consumer closure `phase_seed` materialises and record the truncation
   as a blindspot ("9,941 consumers, showing N"). Silent truncation would be worse than the OOM; the answer
   must say it was cut. This changes answers on hub anchors, so it needs its own gate case.
2. **Find the per-node 2 MB.** 18x the decompose path for the same anchor is not inherent. Prime suspects:
   the graph crossing napi as one JSON blob (nodes + edges + per-node coupling deltas) and its JS-side copies.
   Streaming the wave (`grow_to_terminals_streaming` already exists) or returning a compact columnar DTO
   would both attack it.
3. **Key the caches on engine source.** Include the addon's build id / a hash of the Rust sources in the
   epoch, so a rebuilt core invalidates. This also restores the CLI gate's ability to see core changes.
