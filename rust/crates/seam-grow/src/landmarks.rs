//! ALT LANDMARKS — an admissible distance-to-goal heuristic for a code graph.
//!
//! WHY THIS EXISTS. `phase_expand` is a budget-bounded FLOOD: it takes one anchor, computes `bfs_distance`
//! FROM it, and expands until `max_nodes` is spent. Nothing in it ever computes distance TO anything, and
//! `grow_centers` runs one such flood per center and unions the results — so two centers means two floods, not
//! one search. Measured on keycloak (`--center realms.ts#Realms` + `RealmAdminResource.java#updateRealm`): the
//! two ends are SEVEN hops apart, and the flood touched 611 files to find it. A corridor of the nodes within 3
//! hops of a shortest path is 96 files and carries the same read demand (48.9% vs 50.0% for all 611) — so 84%
//! of the flood is spent off the answer.
//!
//! The fix is goal-directed search, which needs `h(n)` = an admissible estimate of the remaining distance. A
//! code graph has no coordinates, but it does not need them: ALT (A*, Landmarks, Triangle inequality) picks K
//! landmarks, precomputes exact hop distance from each to every node, and takes
//!
//! ```text
//!     h(n) = max over landmarks L of  |d(L, goal) - d(L, n)|
//! ```
//!
//! which is a lower bound on d(n, goal) by the triangle inequality. The landmark distance vector IS the
//! coordinate system — structural (pure hop counts), not semantic.
//!
//! MEASURED, 8 landmarks over the keycloak region graph (1916 nodes): zero admissibility violations, mean
//! h/d* = 0.769, 99.8% of nodes get at least half the true distance, and h(Realms -> RealmAdminResource) = 7,
//! exactly the true distance — for the real query the estimate is tight, so a search would expand little more
//! than the path itself.
//!
//! # The graph this is built on, and why over-approximating it is REQUIRED
//!
//! The grow discovers its graph lazily — expanding a node costs parsing and resolution — so a landmark table
//! cannot be built from it without paying the very cost it exists to avoid. It is built instead from the
//! repo-wide indexes that are already cached (`enumerate_defs`, `CallsiteIndex`, `ImportIndex`, the coupling
//! floor), which yields an OVER-APPROXIMATE graph: a name-based call edge links every caller of `update` to
//! every definition of `update`, not to the one that resolution would pick.
//!
//! That over-approximation is not a defect to be tolerated, it is what makes the heuristic SOUND. Extra edges
//! can only SHORTEN paths, so d_approx <= d_real everywhere, and since
//!
//! ```text
//!     |d_approx(L,goal) - d_approx(L,n)|  <=  d_approx(n,goal)  <=  d_real(n,goal)
//! ```
//!
//! the triangle inequality holds within the approximate graph and the result still lower-bounds the real one.
//! An UNDER-approximate graph (fewer edges — e.g. only fully resolved calls) would break admissibility and let
//! A* return a non-shortest corridor. When in doubt, add the edge.
//!
//! ADMISSIBILITY IS VERIFIED, NOT PROVEN. A superset of the grow's edge kinds would give it by construction,
//! and this graph is not one — it has no `import`, `type-ref` or `interface-impl` edges, because none is
//! available from a cached index without paying for module resolution. Missing edges LENGTHEN approximate
//! distances, which is the direction that can break the bound, so `landmark_admissibility` measures it against
//! a real grow's emitted edges instead of asserting it. If that test ever reports violations, the cure is to
//! add the missing edge kind here, never to relax the check.
//!
//! A file-level projection was measured as the cheap alternative and rejected: admissible (0 violations in 1788
//! nodes) but worthless as guidance — it reports d=1 where the truth is 7, because a single route edge crosses
//! TS->Java in one file hop and every intra-file symbol chain collapses to zero.

use seam_fs::normpath;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// HOW MANY LANDMARKS — the quality knob, and the table costs K * nodes * 2 bytes.
///
/// MEASURED on keycloak (89,678 nodes / 542,376 edges, 916,319 sampled pairs, ZERO admissibility violations at
/// every K). Mean h/d* — the fraction of the true remaining distance the estimate recovers, where 0 is blind
/// BFS and 1 is a perfect oracle:
///
/// ```text
///     K=8  0.418     K=16  0.434     K=32  0.477     K=64  0.510     K=128  0.585
/// ```
///
/// It has NOT saturated at 128, but that table is 23 MB against 11 MB at 64. 64 is chosen because the search's
/// per-node cost is file parsing and resolution, which dwarfs 64 array reads by orders of magnitude — so
/// guidance is worth far more here than table size, right up until the table stops fitting comfortably on disk.
///
/// THE CEILING IS THE GRAPH, NOT K. On the emitted region subgraph (real resolved edges, 1916 nodes) 8
/// landmarks already reached 0.769. The gap is the price of over-approximation: name-based call edges link
/// every caller of `update` to every definition of `update`, and those shortcuts collapse distances, so
/// d_approx sits well under d_real and the bound goes slack. Tightening the graph — resolved call edges rather
/// than name-based ones — would buy more than any K, and costs the resolution work this index exists to avoid.
fn k() -> usize {
    std::env::var("SEAM_LANDMARKS").ok().and_then(|v| v.parse().ok()).filter(|n| *n > 0).unwrap_or(K_DEFAULT)
}
const K_DEFAULT: usize = 64;
/// `u16::MAX` is the unreachable marker, so no real distance may collide with it.
const UNREACHABLE: u16 = u16::MAX;

#[derive(Serialize, Deserialize, Default)]
pub struct LandmarkIndex {
    /// node key -> dense index. A node key is `file#symbol` for a definition, or a bare `file`.
    ids: HashMap<String, u32>,
    /// one row per landmark: hop distance from that landmark to every node, by dense index.
    dists: Vec<Vec<u16>>,
    /// the chosen landmarks' node keys — carried for observability (`--query` diagnostics, tests).
    pub landmarks: Vec<String>,
    /// the graph itself, kept for `debug_graph` (the admissibility test). Skipped on the wire: it is far larger
    /// than the distance rows and nothing on the query path reads it.
    #[serde(default, skip)]
    graph_keys: Vec<String>,
    #[serde(default, skip)]
    graph_adj: Vec<Vec<u32>>,
}

static CACHE: once_cell::sync::Lazy<Mutex<HashMap<String, Arc<LandmarkIndex>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

impl LandmarkIndex {
    pub fn cached(repo: &str) -> Arc<LandmarkIndex> {
        if let Some(i) = CACHE.lock().unwrap().get(repo) {
            return i.clone();
        }
        let i = Arc::new(Self::load_or_build(repo));
        CACHE.lock().unwrap().insert(repo.to_string(), i.clone());
        i
    }

    pub fn reset(repo: Option<&str>) {
        let mut c = CACHE.lock().unwrap();
        match repo {
            Some(r) => {
                c.remove(r);
            }
            None => c.clear(),
        }
    }

    fn shard(repo: &str, epoch: &str) -> String {
        format!("{}/rust/landmark-index-v1/{epoch}.bin", seam_fs::seam_dir(repo))
    }

    /// Epoch-keyed disk persistence, the same contract as `CallsiteIndex`: pay the build once per repo content
    /// epoch and amortize it across every grow, since a landmark table is a pure function of the source.
    fn load_or_build(repo: &str) -> Self {
        let perf = seam_fs::debug_on("perf");
        let epoch = seam_cache::epoch_of(repo);
        if !epoch.is_empty() {
            if let Ok(bytes) = std::fs::read(Self::shard(repo, &epoch)) {
                if let Ok(i) = bincode::deserialize::<LandmarkIndex>(&bytes) {
                    return i;
                }
            }
        }
        let t = std::time::Instant::now();
        let idx = Self::build(repo);
        if perf {
            eprintln!("[perf] landmark_index build {:.2}s ({} nodes, {} landmarks)", t.elapsed().as_secs_f64(), idx.ids.len(), idx.landmarks.len());
        }
        if !epoch.is_empty() {
            let dir = format!("{}/rust/landmark-index-v1", seam_fs::seam_dir(repo));
            let _ = std::fs::create_dir_all(&dir);
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for e in rd.flatten() {
                    if e.file_name().to_string_lossy() != format!("{epoch}.bin") {
                        let _ = std::fs::remove_file(e.path());
                    }
                }
            }
            if let Ok(bytes) = bincode::serialize(&idx) {
                let _ = std::fs::write(Self::shard(repo, &epoch), bytes);
            }
        }
        idx
    }

    /// The admissible estimate of the remaining hop distance from `node` to `goal`, or `None` when either end
    /// is not in the table (an unknown node must not be guessed at — the caller degrades to h=0, i.e. to the
    /// flood it already had).
    pub fn h(&self, node: &str, goal: &str) -> Option<u16> {
        let (n, g) = (*self.ids.get(node)?, *self.ids.get(goal)?);
        let mut best = 0u16;
        for row in &self.dists {
            let (dn, dg) = (row[n as usize], row[g as usize]);
            // a landmark that cannot see BOTH ends says nothing about the pair; skipping it keeps the bound
            // valid (max over fewer terms is still a lower bound).
            if dn == UNREACHABLE || dg == UNREACHABLE {
                continue;
            }
            best = best.max(dn.abs_diff(dg));
        }
        Some(best)
    }

    /// The estimate toward the NEAREST of several goals — the multi-center form. `min` over goals, because
    /// reaching any one of them ends the search, and a lower bound on the minimum is the minimum of the bounds.
    pub fn h_any(&self, node: &str, goals: &[String]) -> Option<u16> {
        goals.iter().filter_map(|g| self.h(node, g)).min()
    }

    /// The graph the table was built on — nodes and adjacency. Exists for the ADMISSIBILITY test, which has to
    /// compare `h` against true distances in the very graph the distances came from; there is no other way to
    /// check the one property the heuristic must have.
    pub fn debug_graph(&self) -> (Vec<String>, Vec<Vec<u32>>) {
        (self.graph_keys.clone(), self.graph_adj.clone())
    }

    pub fn len(&self) -> usize {
        self.ids.len()
    }
    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    pub fn build(repo: &str) -> Self {
        let (keys, adj) = build_graph(repo);
        if keys.is_empty() {
            return Self::default();
        }
        let ids: HashMap<String, u32> = keys.iter().enumerate().map(|(i, k)| (k.clone(), i as u32)).collect();
        let landmark_ix = pick_landmarks(&adj);
        let dists: Vec<Vec<u16>> = landmark_ix.iter().map(|&l| bfs(&adj, l)).collect();
        let landmarks = landmark_ix.into_iter().map(|i| keys[i].clone()).collect();
        Self { ids, dists, landmarks, graph_keys: keys, graph_adj: adj }
    }
}

/// FARTHEST-POINT landmark selection, the standard ALT choice: each new landmark is the node maximizing its
/// distance to the ones already chosen, which spreads them to the graph's extremities where the triangle
/// inequality is tightest.
///
/// DETERMINISTIC BY CONSTRUCTION — the first landmark is the highest-degree node with the lowest index (not a
/// random seed), and every later tie breaks on the lowest index. A landmark table that varied run to run would
/// make the search's expansion order, and so the answer, irreproducible.
fn pick_landmarks(adj: &[Vec<u32>]) -> Vec<usize> {
    let n = adj.len();
    let seed = (0..n).max_by_key(|&i| (adj[i].len(), std::cmp::Reverse(i))).unwrap_or(0);
    let mut chosen = vec![seed];
    let mut best = bfs(adj, seed);
    let k = k();
    while chosen.len() < k.min(n) {
        let far = (0..n)
            .filter(|i| best[*i] != UNREACHABLE)
            .max_by_key(|&i| (best[i], std::cmp::Reverse(i)));
        let Some(far) = far else { break };
        if best[far] == 0 {
            break; // every reachable node is already a landmark
        }
        chosen.push(far);
        let d = bfs(adj, far);
        for i in 0..n {
            // keep the MINIMUM distance to any chosen landmark — that is the quantity being maximized
            if d[i] < best[i] {
                best[i] = d[i];
            }
        }
    }
    chosen
}

fn bfs(adj: &[Vec<u32>], src: usize) -> Vec<u16> {
    let mut d = vec![UNREACHABLE; adj.len()];
    d[src] = 0;
    let mut q = std::collections::VecDeque::from([src as u32]);
    while let Some(u) = q.pop_front() {
        let du = d[u as usize];
        // saturate rather than wrap: a graph deeper than u16::MAX-1 would otherwise alias onto the
        // unreachable marker and silently corrupt every bound derived from it.
        if du >= UNREACHABLE - 1 {
            continue;
        }
        for &v in &adj[u as usize] {
            if d[v as usize] == UNREACHABLE {
                d[v as usize] = du + 1;
                q.push_back(v);
            }
        }
    }
    d
}

/// The over-approximate repo graph. Nodes are definitions (`file#symbol`) plus one node per FILE; edges come
/// only from indexes that are already built and cached, so this adds no resolution work of its own.
fn build_graph(repo: &str) -> (Vec<String>, Vec<Vec<u32>>) {
    let mut keys: Vec<String> = Vec::new();
    let mut ids: HashMap<String, u32> = HashMap::new();
    let mut adj: Vec<Vec<u32>> = Vec::new();
    let mut id_of = |k: &str, keys: &mut Vec<String>, adj: &mut Vec<Vec<u32>>| -> u32 {
        if let Some(i) = ids.get(k) {
            return *i;
        }
        let i = keys.len() as u32;
        ids.insert(k.to_string(), i);
        keys.push(k.to_string());
        adj.push(Vec::new());
        i
    };
    let mut link = |a: u32, b: u32, adj: &mut Vec<Vec<u32>>| {
        if a != b {
            adj[a as usize].push(b);
            adj[b as usize].push(a);
        }
    };

    // 1. DEFINITIONS, each tied to its file. The file node is what call/import/key edges attach to when only a
    //    file is known, so it doubles as the hub that keeps a file's symbols mutually reachable in 2 hops.
    let defs = seam_scan::def_table::enumerate_defs(repo, usize::MAX, None, true);
    let mut defs_by_name: HashMap<String, Vec<u32>> = HashMap::new();
    for d in &defs {
        if d.file.is_empty() || d.name.is_empty() {
            continue;
        }
        let f = normpath(&d.file);
        let fi = id_of(&f, &mut keys, &mut adj);
        let di = id_of(&format!("{f}#{}", d.name), &mut keys, &mut adj);
        link(di, fi, &mut adj);
        defs_by_name.entry(d.name.clone()).or_default().push(di);
    }

    // 2. NAME-BASED CALLS — every file that calls a name, linked to every definition of it. Deliberately
    //    unresolved (see the module note): the extra edges only shorten paths, which keeps `h` a lower bound.
    let ci = seam_resolve::CallsiteIndex::cached(repo);
    for (method, callers) in ci.callers_map() {
        let Some(targets) = defs_by_name.get(&method) else { continue };
        // a name called from hundreds of files is a hub whose edges say nothing about locality, and it costs
        // |callers| * |targets| edges; the cap keeps the graph from going quadratic on `get`/`toString`.
        if targets.len() > 32 || callers.len() > 256 {
            continue;
        }
        for c in &callers {
            let fi = id_of(&normpath(c), &mut keys, &mut adj);
            for &t in targets {
                link(fi, t, &mut adj);
            }
        }
    }

    // 3. THE COUPLING FLOOR — the shared-key sides. THIS IS WHAT MAKES THE GRAPH CROSS-LANGUAGE: a TS `fetch`
    //    and the Java handler that serves it share no call, import or symbol, only an `http-route` key, so
    //    without these edges the two halves of a full-stack flow are separate components and every cross-stack
    //    `h` is undefined. Both sides of a key are linked through one node FOR the key, not pairwise, so a key
    //    with 700 sides costs 700 edges rather than 245,000.
    let contribs = seam_couple::ground::floor::floor_contributions(repo);
    let (produced, consumed) = seam_couple::ground::floor::merge_floor(&contribs);
    for side in [&produced, &consumed] {
        for (key, sides) in side.iter() {
            let ki = id_of(&format!("key:{key}"), &mut keys, &mut adj);
            for a in sides.producers.iter().chain(sides.consumers.iter()) {
                let fi = id_of(&normpath(&a.file), &mut keys, &mut adj);
                link(ki, fi, &mut adj);
            }
        }
    }

    // dedup: `link` pushes unconditionally, and a pair reached by several edge kinds would otherwise be
    // traversed repeatedly. BFS is correctness-insensitive to this, but the table is smaller and warmer.
    for row in adj.iter_mut() {
        row.sort_unstable();
        row.dedup();
    }
    (keys, adj)
}
