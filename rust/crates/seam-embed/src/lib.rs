//! THE INTENT FIELD — sentence embeddings in the core. Port of `ts/src/codebase/scan/def_embed.ts`.
//!
//! This is the last thing the Rust engine could not do, and the reason the router kept intent-shaped grows on
//! TS. It runs the SAME artifact transformers.js runs — the quantized `all-MiniLM-L6-v2` ONNX model and its
//! tokenizer.json — because the grow's containment depends on these scores: a field computed from a different
//! model, or with different pooling, would move the soft border and the tier gate silently. Same weights, same
//! tokenizer, same mean-pool-then-L2-normalise, same cosine.
//!
//! DEGRADES, NEVER FAILS. Every entry point returns an empty/absent result when the model is not present, and
//! the caller falls back to the deterministic fanout — exactly as the TS side does when transformers.js is not
//! installed. An intent field is a RANKING improvement; the structural answer stands without it.

use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// The model id, matching TS's `SEAM_EMBED_MODEL || "Xenova/all-MiniLM-L6-v2"` — the cache is keyed by it, so
/// two models never share vectors (different dims, different geometry).
pub fn model_id() -> String {
    std::env::var("SEAM_EMBED_MODEL").unwrap_or_else(|_| "Xenova/all-MiniLM-L6-v2".to_string())
}

/// BGE-family retrieval models want an instruction prefix on the QUERY (never the passages); a generic model
/// (MiniLM/mpnet) wants none. Applied to the intent only. Port of `QUERY_PREFIX`.
pub fn query_prefix() -> &'static str {
    if model_id().to_lowercase().contains("bge") {
        "Represent this sentence for searching relevant passages: "
    } else {
        ""
    }
}

/// Where the model lives. Preference order mirrors what a machine running this engine already has:
/// an explicit `SEAM_EMBED_DIR`, then the transformers.js cache (the SAME files the TS path downloaded — so a
/// repo that has run the TS engine needs no second download), then the HF hub cache.
fn model_dir() -> Option<PathBuf> {
    let id = model_id();
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(d) = std::env::var("SEAM_EMBED_DIR") {
        roots.push(PathBuf::from(d));
    }
    let home = std::env::var("HOME").ok().map(PathBuf::from);
    // transformers.js caches under <pkg>/.cache/<org>/<model>. Walk UP from the working directory: the addon is
    // loaded from `rust/`, the cache lives in `ts/`, so checking only the cwd finds nothing — the two are
    // siblings under the repo root, not nested.
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        let mut p: Option<&std::path::Path> = Some(cwd.as_path());
        while let Some(d) = p {
            bases.push(d.to_path_buf());
            p = d.parent();
        }
    }
    if let Some(h) = home.clone() {
        bases.push(h);
    }
    for base in bases {
        roots.push(base.join("ts/node_modules/@xenova/transformers/.cache").join(&id));
        roots.push(base.join("node_modules/@xenova/transformers/.cache").join(&id));
    }
    if let Some(h) = home {
        roots.push(h.join(".cache/huggingface/hub").join(format!("models--{}", id.replace('/', "--"))));
    }
    roots.into_iter().find(|r| r.join("tokenizer.json").is_file())
}

fn onnx_path(dir: &PathBuf) -> Option<PathBuf> {
    // WHICH WEIGHTS decides whether the two engines agree. transformers.js loads the INT8-quantized file by
    // default, and int8 kernels differ between execution providers (onnxruntime-web/WASM vs native ORT) by
    // ~1e-2 on a cosine — enough to swap near-ties in the ranking, which is the only thing the grow reads.
    // `SEAM_EMBED_QUANTIZED=0` selects the fp32 weights; both engines must make the SAME choice.
    let quantized = std::env::var("SEAM_EMBED_QUANTIZED").map(|v| v != "0").unwrap_or(true);
    let order: &[&str] = if quantized {
        &["onnx/model_quantized.onnx", "onnx/model.onnx", "model_quantized.onnx", "model.onnx"]
    } else {
        &["onnx/model.onnx", "model.onnx", "onnx/model_quantized.onnx", "model_quantized.onnx"]
    };
    for p in order {
        let c = dir.join(p);
        if c.is_file() {
            return Some(c);
        }
    }
    None
}

/// `model_max_length` from `tokenizer_config.json` — the length transformers.js truncates at (512 for the
/// MiniLM family). Falls back to 512, the model's `max_position_embeddings`.
fn model_max_length(dir: &std::path::Path) -> usize {
    std::fs::read_to_string(dir.join("tokenizer_config.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("model_max_length").and_then(|m| m.as_u64()))
        .map(|v| v as usize)
        .filter(|v| *v > 0 && *v <= 8192)
        .unwrap_or(512)
}

struct Embedder {
    session: ort::session::Session,
    tokenizer: tokenizers::Tokenizer,
}

static EMBEDDER: Lazy<Mutex<Option<Option<Embedder>>>> = Lazy::new(|| Mutex::new(None));

fn with_embedder<T>(f: impl FnOnce(&mut Embedder) -> Option<T>) -> Option<T> {
    let mut slot = EMBEDDER.lock().ok()?;
    if slot.is_none() {
        // built ONCE per process, and a failure is cached as "absent" so a missing model costs one probe, not
        // one per call
        *slot = Some((|| {
            let dir = model_dir()?;
            let mut tokenizer = tokenizers::Tokenizer::from_file(dir.join("tokenizer.json")).ok()?;
            // SEQUENCE LENGTH IS PART OF THE CONTRACT. `tokenizer.json` carries `truncation.max_length = 128`
            // and `padding = Fixed(128)`, and the Rust `tokenizers` crate HONOURS both. transformers.js does
            // not: it ignores that section and truncates at `model_max_length` (512), padding to the longest
            // item in the batch. So the same text produced two different token sequences, and the mean-pooled
            // vectors diverged — invisibly, because both engines "worked".
            //
            // It only shows on LONG inputs, which is why embed.ts (short symbol names) measured agreement to
            // 3.7e-7 while the real field disagreed by ~3e-2: `embedString` is signature + enclosing + path +
            // doc + BODY and routinely exceeds 128 tokens. Measured on `_patch.ts`: TS 0.2744, Rust 0.2410
            // against a 0.25 margin — a borderline complement kept by one engine and dropped by the other.
            // Padding is turned OFF here because this module builds its own batch-longest padding below.
            tokenizer.with_truncation(Some(tokenizers::TruncationParams { max_length: model_max_length(&dir), ..Default::default() })).ok()?;
            tokenizer.with_padding(None);
            // read the file ourselves: `commit_from_file` is not in this ort release's builder, and loading from memory
            // also keeps the model path out of ort's own resolution logic
            let bytes = std::fs::read(onnx_path(&dir)?).ok()?;
            let session = ort::session::Session::builder().ok()?.commit_from_memory(&bytes).ok()?;
            Some(Embedder { session, tokenizer })
        })());
    }
    slot.as_mut()?.as_mut().and_then(f)
}

/// Is the intent field available at all? The gate the router asks before treating a grow as intent-shaped —
/// the counterpart of TS's `transformersAvailable()`.
pub fn available() -> bool {
    with_embedder(|_| Some(true)).unwrap_or(false)
}

/// Embed a batch: tokenize → run → MEAN-POOL over the attention mask → L2-normalise. That pooling is the
/// contract `pipeline(..., { pooling: "mean", normalize: true })` implements on the TS side; changing it would
/// change every score while still "working".
/// How many texts go into ONE forward pass.
///
/// MEASURED, not guessed. Embedding is called with every cache MISS at once -- up to the 800-def prefilter
/// cap -- and one pass allocates activations proportional to `batch x heads x seq^2`. On Keycloak (800
/// misses, seq 199, MiniLM 6 layers x 12 heads) a single attention matrix is already ~1.5 GB and the pass
/// peaked at 7.2 GB, which on a 15 GB machine is what turned a slow grow into an OOM kill. Chunked: the same
/// call now peaks at 470 MB (15x less) and the whole grow at 1.9 GB instead of 14.2 GB.
const EMBED_BATCH: usize = 32;

/// Embed a batch: tokenize -> run -> MEAN-POOL over the attention mask -> L2-normalise. That pooling is the
/// contract `pipeline(..., { pooling: "mean", normalize: true })` implements on the TS side; changing it would
/// change every score while still "working".
///
/// Chunked at `EMBED_BATCH`. Padding is per-CHUNK (`seq` is the chunk's own longest text), so chunking also
/// stops one 199-token def from padding 799 short ones. NOTE it therefore changes vectors slightly -- but a
/// vector already depended on its batch-mates before this (see `chunk_tests`), so the baseline was never
/// stable; this narrows the padding, it does not introduce the sensitivity.
pub fn embed_many(texts: &[String]) -> Vec<Vec<f32>> {
    if texts.len() <= EMBED_BATCH {
        return embed_one_batch(texts);
    }
    let mut out: Vec<Vec<f32>> = Vec::with_capacity(texts.len());
    for chunk in texts.chunks(EMBED_BATCH) {
        let got = embed_one_batch(chunk);
        // the caller zips `missing` with this result POSITIONALLY, so a short return would misattribute every
        // vector after the gap -- worse than returning nothing.
        if got.len() != chunk.len() {
            return Vec::new();
        }
        out.extend(got);
    }
    out
}

fn embed_one_batch(texts: &[String]) -> Vec<Vec<f32>> {
    if texts.is_empty() {
        return Vec::new();
    }
    with_embedder(|e| {
        let encs = e.tokenizer.encode_batch(texts.to_vec(), true).ok()?;
        let (batch, seq) = (encs.len(), encs.iter().map(|x| x.len()).max().unwrap_or(0));
        if seq == 0 {
            return None;
        }
        let mut ids = vec![0i64; batch * seq];
        let mut mask = vec![0i64; batch * seq];
        let types = vec![0i64; batch * seq];
        for (i, enc) in encs.iter().enumerate() {
            for (j, (&id, &m)) in enc.get_ids().iter().zip(enc.get_attention_mask()).enumerate() {
                ids[i * seq + j] = id as i64;
                mask[i * seq + j] = m as i64;
            }
        }
        let shape = [batch, seq];
        let inputs = ort::inputs![
            "input_ids" => ort::value::Tensor::from_array((shape, ids)).ok()?,
            "attention_mask" => ort::value::Tensor::from_array((shape, mask.clone())).ok()?,
            "token_type_ids" => ort::value::Tensor::from_array((shape, types)).ok()?,
        ];
        let out = e.session.run(inputs).ok()?;
        let (odim, data) = out[0].try_extract_tensor::<f32>().ok()?;
        let dim = *odim.last()? as usize;
        let mut vecs = Vec::with_capacity(batch);
        for i in 0..batch {
            let mut v = vec![0f32; dim];
            let mut n = 0f32;
            for j in 0..seq {
                if mask[i * seq + j] == 0 {
                    continue; // padding contributes nothing — that is what makes it MASKED mean pooling
                }
                n += 1.0;
                let base = (i * seq + j) * dim;
                for (k, slot) in v.iter_mut().enumerate() {
                    *slot += data[base + k];
                }
            }
            if n > 0.0 {
                for slot in v.iter_mut() {
                    *slot /= n;
                }
            }
            let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            if norm > 0.0 {
                for slot in v.iter_mut() {
                    *slot /= norm;
                }
            }
            vecs.push(v);
        }
        Some(vecs)
    })
    .unwrap_or_default()
}

/// Cosine of two L2-NORMALISED vectors — a plain dot product, as on the TS side.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

static STR_VEC: Lazy<Mutex<HashMap<String, Vec<f32>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static INTENT_VEC: Lazy<Mutex<Option<(String, Vec<f32>)>>> = Lazy::new(|| Mutex::new(None));

/// Drop every memo — the built embedder and both vector caches — so a test can control the model state it
/// asserts about. `EMBEDDER` is built once per PROCESS from `SEAM_EMBED_MODEL`, so without this a test that
/// points the env var at a missing model still gets whichever embedder another test built first.
#[cfg(test)]
fn reset_memos_for_test() {
    *EMBEDDER.lock().unwrap() = None;
    STR_VEC.lock().unwrap().clear();
    *INTENT_VEC.lock().unwrap() = None;
}

/// value → cosine(intent, value), for the key-ranking hook. Dedupes and embeds only the uncached values in ONE
/// batched pass, and memoises the intent vector — the caller asks the same intent many times per run.
/// Port of `embedScoreStrings`. Empty map = no field; the caller falls back to fanout order.
pub fn embed_score_strings(intent: &str, values: &[String]) -> HashMap<String, f32> {
    let mut out = HashMap::new();
    if intent.is_empty() || values.is_empty() || !available() {
        return out;
    }
    let ivec = {
        let mut slot = INTENT_VEC.lock().unwrap();
        if slot.as_ref().map(|(i, _)| i.as_str()) != Some(intent) {
            let v = embed_many(&[format!("{}{}", query_prefix(), intent)]).into_iter().next();
            match v {
                Some(v) => *slot = Some((intent.to_string(), v)),
                None => return out,
            }
        }
        slot.as_ref().unwrap().1.clone()
    };
    let missing: Vec<String> = {
        let cache = STR_VEC.lock().unwrap();
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        values.iter().filter(|v| seen.insert(v.as_str()) && !cache.contains_key(*v)).cloned().collect()
    };
    if !missing.is_empty() {
        let vecs = embed_many(&missing);
        let mut cache = STR_VEC.lock().unwrap();
        for (v, vec) in missing.iter().zip(vecs) {
            cache.insert(v.clone(), vec);
        }
    }
    let cache = STR_VEC.lock().unwrap();
    for v in values {
        if let Some(vec) = cache.get(v) {
            out.insert(v.clone(), cosine(&ivec, vec));
        }
    }
    out
}

/// value → its embedding VECTOR. The vector half of `embed_score_strings`, sharing the same `STR_VEC` cache:
/// the region-centroid border needs the vectors themselves, and re-embedding for that would double the cold
/// cost of every intent grow. Values already scored come back free; only genuinely new ones are embedded.
/// Counterpart of the `vec` field TS's `embedScoreDefs` returns alongside the score.
pub fn embed_vecs(values: &[String]) -> HashMap<String, Vec<f32>> {
    let mut out = HashMap::new();
    if values.is_empty() || !available() {
        return out;
    }
    let missing: Vec<String> = {
        let cache = STR_VEC.lock().unwrap();
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        values.iter().filter(|v| seen.insert(v.as_str()) && !cache.contains_key(*v)).cloned().collect()
    };
    if !missing.is_empty() {
        let vecs = embed_many(&missing);
        let mut cache = STR_VEC.lock().unwrap();
        for (v, vec) in missing.iter().zip(vecs) {
            cache.insert(v.clone(), vec);
        }
    }
    let cache = STR_VEC.lock().unwrap();
    for v in values {
        if let Some(vec) = cache.get(v) {
            out.insert(v.clone(), vec.clone());
        }
    }
    out
}

/// The per-(repo, model) vector cache path — the same shape TS uses, so the two engines can share a warm cache
/// on the same machine rather than each paying the embedding cost once.
pub fn cache_path(repo: &str) -> PathBuf {
    use sha1::{Digest, Sha1};
    let mut h = Sha1::new();
    h.update(format!("{repo}|{}", model_id()).as_bytes());
    let hash: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".cache/seam/embed").join(format!("{}.json", &hash[..16]))
}

#[cfg(test)]
mod tests {
    use super::*;

    // `SEAM_EMBED_MODEL` and the built embedder are PROCESS-global, and cargo runs these tests on threads of
    // one process. Without this lock the model test raced `available()`: whichever ran first won the single
    // `EMBEDDER` build, so on a machine WITH a model installed the missing-model assertion intermittently saw
    // a real embedder and got real scores back. Same process-global-state class as the coupling suite's lock.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn the_field_is_optional_and_says_so() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // `available()` is the router's gate: it must answer without panicking whether or not a model is there
        let _ = available();
    }

    #[test]
    fn scoring_without_a_field_returns_empty_rather_than_guessing() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("SEAM_EMBED_MODEL", "does/not-exist");
        reset_memos_for_test();   // force the probe to re-run against the bogus model id
        // a missing model must not fabricate scores — the caller falls back to the deterministic fanout
        let scored = embed_score_strings("an intent", &["a".to_string()]);
        std::env::remove_var("SEAM_EMBED_MODEL");
        reset_memos_for_test();   // don't leave "absent" cached for whatever runs next
        assert!(scored.is_empty(), "a missing model fabricated scores: {scored:?}");
    }

    #[test]
    fn cosine_of_normalised_vectors_is_the_dot_product() {
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
    }

    /// A vector depends on its batch-mates ONLY UNDER int8. Root-caused, not shrugged at.
    ///
    /// Mean-pooling here is correct (it skips masked positions), so padding should be invisible — and under
    /// fp32 it IS: `SEAM_EMBED_QUANTIZED=0` makes one-big-batch and one-at-a-time agree EXACTLY. The drift is
    /// an int8 QUANTIZATION artefact: different tensor shapes take different kernels/scales, so a text's vector
    /// moves by ~0.03 per component (on components of ~0.05) depending on how long its longest batch-mate was.
    ///
    /// What that costs in practice: a def's intent score depends on which other defs missed the cache in the
    /// same run, so two machines can rank the same repo slightly differently. The per-repo disk cache pins a
    /// vector once computed, so it is stable WITHIN a machine — which is why this never surfaced as flakiness.
    ///
    /// Not "fixed" here because the remedy is a product trade: fp32 buys exactness at ~4x the weights and a
    /// slower pass, and the alternative (pad every text to a fixed bucket so its padding depends only on its
    /// own length) buys it while keeping int8. Both are real choices; silently switching either is not.
    #[test]
    fn batch_composition_moves_a_vector_only_under_int8() {
        if !available() {
            return; // no embedding runtime here
        }
        let texts: Vec<String> = (0..70)
            .map(|i| if i % 7 == 0 {
                format!("function handlePaymentIntent{i} validates the booking, charges the card, and writes the ledger row for reconciliation")
            } else {
                format!("fn f{i}")
            })
            .collect();
        let single: Vec<Vec<f32>> = texts.iter().map(|t| embed_one_batch(std::slice::from_ref(t)).pop().unwrap_or_default()).collect();
        let worst = |a: &[Vec<f32>]| -> f32 {
            a.iter().zip(&single).flat_map(|(x, y)| x.iter().zip(y).map(|(p, q)| (p - q).abs())).fold(0f32, f32::max)
        };
        let unchunked = worst(&embed_one_batch(&texts));
        let chunked = worst(&embed_many(&texts));

        if std::env::var("SEAM_EMBED_QUANTIZED").as_deref() == Ok("0") {
            // fp32: padding is genuinely invisible, which is what proves the pooling and the mask are right.
            assert!(unchunked < 1e-5, "fp32 should be padding-invariant, saw {unchunked}");
            assert!(chunked < 1e-5, "fp32 chunking should be exact, saw {chunked}");
            return;
        }
        // int8: drift exists, and chunking must not make it WORSE than the batching it replaced.
        assert!(unchunked > 0.0, "int8 stopped drifting — re-check whether the quantised kernels changed");
        assert!(chunked <= unchunked * 1.5 + 1e-3, "chunking drifted further than one big batch: {chunked} vs {unchunked}");
    }

    /// DOES THE int8 DRIFT ACTUALLY CHANGE THE ANSWER? Per-component drift is not the product question —
    /// the scores feed a RANKING (spine/supporting/off), and 384 dimensions of noise partly cancel in a
    /// cosine. So measure the ranking, not the vector. Diagnostic: prints top-k overlap and max rank shift.
    #[test]
    fn report_whether_int8_drift_reorders_the_ranking() {
        if !available() || std::env::var("SEAM_EMBED_RANK_REPORT").is_err() {
            return; // opt-in diagnostic, not an assertion
        }
        let corpus: Vec<String> = (0..120)
            .map(|i| match i % 4 {
                0 => format!("fn createBooking{i}(memberId: string) persists a booking row and emits confirmation"),
                1 => format!("fn renderChart{i}(data) draws the analytics histogram for the dashboard"),
                2 => format!("class PaymentProcessor{i} captures the card charge and reconciles the ledger"),
                _ => format!("fn util{i}(x)"),
            })
            .collect();
        let intent = embed_one_batch(&[format!("{}how is a booking confirmed", query_prefix())]).pop().unwrap_or_default();
        let cos = |v: &[f32]| -> f32 { v.iter().zip(&intent).map(|(a, b)| a * b).sum() };
        let rank = |vs: &[Vec<f32>]| -> Vec<usize> {
            let mut idx: Vec<usize> = (0..vs.len()).collect();
            idx.sort_by(|a, b| cos(&vs[*b]).partial_cmp(&cos(&vs[*a])).unwrap_or(std::cmp::Ordering::Equal));
            idx
        };
        let a = rank(&embed_one_batch(&corpus));                       // one big batch
        let b = rank(&embed_many(&corpus));                            // chunks of 32
        let c: Vec<Vec<f32>> = corpus.iter().map(|t| embed_one_batch(std::slice::from_ref(t)).pop().unwrap_or_default()).collect();
        let c = rank(&c);                                              // one at a time
        let overlap = |x: &[usize], y: &[usize], k: usize| -> usize {
            let sy: std::collections::HashSet<_> = y[..k].iter().collect();
            x[..k].iter().filter(|i| sy.contains(i)).count()
        };
        let pos = |r: &[usize]| -> Vec<usize> { let mut p = vec![0; r.len()]; for (rank, &i) in r.iter().enumerate() { p[i] = rank; } p };
        let (pa, pc) = (pos(&a), pos(&c));
        let max_shift = pa.iter().zip(&pc).map(|(x, y)| (*x as i64 - *y as i64).abs()).max().unwrap_or(0);
        eprintln!("RANK REPORT (n={}): top10 overlap big-vs-single={}/10  chunked-vs-single={}/10  top25={}/25  max rank shift={}",
            corpus.len(), overlap(&a, &c, 10), overlap(&b, &c, 10), overlap(&a, &c, 25), max_shift);
    }

    #[test]
    fn every_input_gets_its_own_vector_across_chunk_boundaries() {
        if !available() {
            return;
        }
        let texts: Vec<String> = (0..EMBED_BATCH * 2 + 5).map(|i| format!("fn symbol{i}")).collect();
        let out = embed_many(&texts);
        assert_eq!(out.len(), texts.len());
        assert!(out.iter().all(|v| !v.is_empty()));
        assert_ne!(out[0], out[EMBED_BATCH + 1], "distinct inputs collapsed to one vector");
    }
}
