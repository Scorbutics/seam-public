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
pub fn embed_many(texts: &[String]) -> Vec<Vec<f32>> {
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

    #[test]
    fn the_field_is_optional_and_says_so() {
        // `available()` is the router's gate: it must answer without panicking whether or not a model is there
        let _ = available();
    }

    #[test]
    fn scoring_without_a_field_returns_empty_rather_than_guessing() {
        std::env::set_var("SEAM_EMBED_MODEL", "does/not-exist");
        // a missing model must not fabricate scores — the caller falls back to the deterministic fanout
        assert!(embed_score_strings("an intent", &["a".to_string()]).is_empty());
        std::env::remove_var("SEAM_EMBED_MODEL");
    }

    #[test]
    fn cosine_of_normalised_vectors_is_the_dot_product() {
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
    }
}
