//! The ALT landmark table — the heuristic that turns the grow's flood into a goal-directed search.
//!
//! ADMISSIBILITY IS THE ONLY PROPERTY THAT MATTERS HERE. A* with an overestimating `h` silently returns a
//! non-shortest path, which for this engine means a corridor that misses the flow while looking like an answer.
//! The table is built from an OVER-approximate graph precisely so that its distances underestimate the real
//! ones, but that graph is missing edge kinds the grow can traverse (no `import`, `type-ref`,
//! `interface-impl`), so the bound is verified rather than assumed.

use seam_grow::landmarks::LandmarkIndex;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Repo(PathBuf);
impl Repo {
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn repo(files: &[(&str, &str)]) -> Repo {
    static N: AtomicUsize = AtomicUsize::new(0);
    let d = std::env::temp_dir().join(format!("seam-lm-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    fs::write(d.join("package.json"), r#"{ "name": "lm", "version": "1.0.0" }"#).unwrap();
    for (rel, text) in files {
        let p = d.join(rel);
        fs::create_dir_all(Path::new(&p).parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }
    Repo(d)
}

/// A cross-language flow: a TS client fetching a route, and the Java resource serving it. The two halves share
/// no call and no import — only the route key — so this fixture is also the check that the coupling floor's
/// edges are what connect them.
fn fixture() -> Repo {
    // Wide enough that the admissibility sweep checks a few hundred pairs rather than a handful: a chain of
    // callers into the client, several sibling resources, and a second route so more than one key edge exists.
    let mut files: Vec<(String, String)> = Vec::new();
    for i in 0..10 {
        files.push((format!("src/caller{i}.ts"), format!("import {{ repo }} from './repo';\nexport function caller{i}() {{ return repo({i}); }}\n")));
        files.push((format!("src/sib{i}.ts"), format!("export function sib{i}(x: any) {{ return fetch('/api/sib{i}'); }}\n")));
    }
    files.push((
        "server/src/main/java/api/SibResource.java".into(),
        "package api;\npublic class SibResource {\n    @GET\n    @Path(\"/api/sib0\")\n    public Response get() { return Response.ok().build(); }\n}\n".into(),
    ));
    let mut all: Vec<(&str, &str)> = files.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    let base: Vec<(&str, &str)> = vec![
        ("src/service.ts", "import { repo } from './repo';\nexport function createBooking(x: any) { return repo(x); }\n"),
        ("src/repo.ts", "export function repo(x: any) { return fetch('/api/bookings', { method: 'POST' }); }\n"),
        (
            "server/src/main/java/api/BookingsResource.java",
            "package api;\npublic class BookingsResource {\n    @POST\n    @Path(\"/api/bookings\")\n    public Response create(BookingRepresentation rep) {\n        return Response.ok().build();\n    }\n}\n",
        ),
    ];
    all.extend(base);
    repo(&all)
}

#[test]
fn it_builds_and_picks_landmarks() {
    let d = fixture();
    LandmarkIndex::reset(None);
    let idx = LandmarkIndex::build(d.path().to_str().unwrap());
    assert!(!idx.is_empty(), "the landmark graph is empty — no defs, no keys, nothing to search");
    assert!(!idx.landmarks.is_empty(), "no landmark was selected, so `h` can only ever return 0");
}

/// DETERMINISM. The landmark set decides the expansion order and so the corridor; if it varied between builds
/// the same query would return different answers on the same source.
#[test]
fn the_landmark_set_is_deterministic() {
    let d = fixture();
    let r = d.path().to_str().unwrap();
    LandmarkIndex::reset(None);
    let a = LandmarkIndex::build(r);
    LandmarkIndex::reset(None);
    let b = LandmarkIndex::build(r);
    assert_eq!(a.landmarks, b.landmarks, "farthest-point selection is not deterministic");
}

/// h(x, x) = 0, and an unknown node yields None rather than a guess — the caller degrades to h=0 (the flood it
/// already had), which is always safe; a fabricated estimate is not.
#[test]
fn the_estimate_is_zero_at_the_goal_and_absent_off_the_table() {
    let d = fixture();
    LandmarkIndex::reset(None);
    let idx = LandmarkIndex::build(d.path().to_str().unwrap());
    let some = idx.landmarks[0].clone();
    assert_eq!(idx.h(&some, &some), Some(0), "the estimate at the goal itself must be 0");
    assert_eq!(idx.h("no/such/file.ts#nope", &some), None, "an unknown node must not be estimated");
}

/// THE BOUND, checked exhaustively against the table's OWN graph: for every pair of nodes reachable from a
/// landmark, `h` must not exceed the true hop distance. Run over all pairs from several sources, not a sample.
#[test]
fn the_estimate_never_exceeds_the_true_distance() {
    let d = fixture();
    LandmarkIndex::reset(None);
    let idx = LandmarkIndex::build(d.path().to_str().unwrap());
    let (keys, adj) = idx.debug_graph();

    let bfs = |src: usize| -> HashMap<usize, usize> {
        let mut dist = HashMap::from([(src, 0usize)]);
        let mut q = VecDeque::from([src]);
        while let Some(u) = q.pop_front() {
            let du = dist[&u];
            for &v in &adj[u] {
                if !dist.contains_key(&(v as usize)) {
                    dist.insert(v as usize, du + 1);
                    q.push_back(v as usize);
                }
            }
        }
        dist
    };

    let mut checked = 0usize;
    for src in 0..keys.len().min(40) {
        let truth = bfs(src);
        for (&dst, &real) in &truth {
            let est = idx.h(&keys[src], &keys[dst]).unwrap_or(0) as usize;
            assert!(
                est <= real,
                "INADMISSIBLE: h({}, {}) = {est} exceeds the true distance {real}. A* would return a \
                 non-shortest corridor. The cure is an EDGE this graph is missing, never a looser check.",
                keys[src],
                keys[dst]
            );
            checked += 1;
        }
    }
    assert!(checked > 50, "only {checked} pairs were checked — the fixture graph is too small to mean anything");
}

/// THE POINT OF THE WHOLE THING: the estimate has to be INFORMATIVE, not merely admissible. h == 0 everywhere
/// is perfectly admissible and turns A* back into the flood this exists to replace.
#[test]
fn the_estimate_is_informative_not_merely_admissible() {
    let d = fixture();
    LandmarkIndex::reset(None);
    let idx = LandmarkIndex::build(d.path().to_str().unwrap());
    let (keys, _) = idx.debug_graph();
    let far = keys
        .iter()
        .filter_map(|k| idx.h(&keys[0], k).map(|h| (h, k)))
        .max_by_key(|(h, _)| *h);
    let (h, _) = far.expect("no pair produced an estimate at all");
    assert!(h > 0, "every estimate is 0 — the landmarks carry no information and A* degrades to blind BFS");
}

/// The cross-language edge. Without the coupling floor the TS and Java halves are separate components and every
/// cross-stack estimate is `None`, which is exactly the query this engine exists to answer.
#[test]
fn the_two_language_halves_are_connected_through_the_route_key() {
    let d = fixture();
    LandmarkIndex::reset(None);
    let idx = LandmarkIndex::build(d.path().to_str().unwrap());
    let (keys, adj) = idx.debug_graph();
    let ix = |needle: &str| keys.iter().position(|k| k.contains(needle));
    let (Some(ts), Some(java)) = (ix("src/repo.ts"), ix("BookingsResource.java")) else {
        panic!("fixture files are missing from the graph: {:?}", keys.iter().take(20).collect::<Vec<_>>());
    };
    let mut seen = HashSet::from([ts]);
    let mut q = VecDeque::from([ts]);
    while let Some(u) = q.pop_front() {
        for &v in &adj[u] {
            if seen.insert(v as usize) {
                q.push_back(v as usize);
            }
        }
    }
    assert!(
        seen.contains(&java),
        "the Java handler is unreachable from the TS caller — the coupling-floor key edges are not in the graph, \
         so no cross-stack query can ever get an estimate"
    );
}

/// THE REAL REPO, gated on it being present (skipped in CI, run locally). Two things the fixture cannot show:
/// whether the index BUILDS at repo scale, and whether the bound survives a graph assembled from the cached
/// indexes rather than a handful of files.
#[test]
fn keycloak_scale_build() {
    let repo = "/home/scorbutics/dev/keycloak";
    if !Path::new(repo).exists() {
        return;
    }
    LandmarkIndex::reset(None);
    let t = std::time::Instant::now();
    let idx = LandmarkIndex::build(repo);
    let secs = t.elapsed().as_secs_f64();
    let (keys, adj) = idx.debug_graph();
    let edges: usize = adj.iter().map(Vec::len).sum::<usize>() / 2;
    eprintln!("[landmarks] {} nodes, {edges} edges, {} landmarks, built in {secs:.1}s", keys.len(), idx.landmarks.len());
    assert!(keys.len() > 1000, "only {} nodes at keycloak scale — the graph did not build", keys.len());
    assert!(!idx.landmarks.is_empty());

    // the bound, sampled across the graph (an exhaustive sweep here is O(n^2) and this is a scale check)
    let bfs = |src: usize| -> HashMap<usize, usize> {
        let mut dist = HashMap::from([(src, 0usize)]);
        let mut q = VecDeque::from([src]);
        while let Some(u) = q.pop_front() {
            let du = dist[&u];
            for &v in &adj[u] {
                if !dist.contains_key(&(v as usize)) {
                    dist.insert(v as usize, du + 1);
                    q.push_back(v as usize);
                }
            }
        }
        dist
    };
    let (mut checked, mut viol, mut sum, mut n) = (0usize, 0usize, 0f64, 0usize);
    for src in (0..keys.len()).step_by(keys.len() / 12 + 1) {
        for (&dst, &real) in &bfs(src) {
            let est = idx.h(&keys[src], &keys[dst]).unwrap_or(0) as usize;
            checked += 1;
            if est > real {
                viol += 1;
            }
            if real > 0 {
                sum += est as f64 / real as f64;
                n += 1;
            }
        }
    }
    eprintln!("[landmarks] {checked} pairs checked, {viol} violations, mean h/d* = {:.3}", sum / n.max(1) as f64);
    assert_eq!(viol, 0, "INADMISSIBLE at repo scale on {checked} pairs — A* would return non-shortest corridors");
}
