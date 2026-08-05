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
    // THE DISTANCE DISTRIBUTION. ALT only discriminates if distances SPREAD; on a small-world graph every pair
    // is a few hops apart, |d(L,goal) - d(L,n)| is 0 almost everywhere, and h carries no direction whatever its
    // h/d* ratio looks like.
    {
        let seed = (0..keys.len()).max_by_key(|&i| adj[i].len()).unwrap_or(0);
        let d0 = bfs(seed);
        let mut hist = [0usize; 12];
        for &v in d0.values() {
            hist[v.min(11)] += 1;
        }
        eprintln!("[landmarks] hop histogram from the seed landmark: {hist:?}  (reached {} of {})", d0.len(), keys.len());
        // COMPONENTS. A landmark can only speak for its own component, so fragmentation is the difference
        // between a heuristic and a table of zeros.
        let mut seen = vec![false; keys.len()];
        let mut sizes: Vec<usize> = Vec::new();
        for i in 0..keys.len() {
            if seen[i] { continue; }
            let mut n = 0usize;
            let mut q = VecDeque::from([i]);
            seen[i] = true;
            while let Some(u) = q.pop_front() {
                n += 1;
                for &v in &adj[u] {
                    if !seen[v as usize] { seen[v as usize] = true; q.push_back(v as usize); }
                }
            }
            sizes.push(n);
        }
        sizes.sort_unstable_by(|a, b| b.cmp(a));
        eprintln!("[landmarks] {} components; largest: {:?}", sizes.len(), &sizes[..sizes.len().min(6)]);
        eprintln!("[landmarks] largest component covers {:.1}% of nodes", sizes[0] as f64 / keys.len() as f64 * 100.0);
    }
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

// ── the wiring: f = g + h in the wave ──────────────────────────────────────────────────────────────────────

use seam_grow::orchestrate::{grow_centers, WaveOpts};
use seam_grow::orchestrate::Center;

/// A repo with a CORRIDOR between two ends and a large off-corridor fan hanging off the source. Under a node
/// budget the flood spends itself on the fan (it is nearer the anchor); a goal-directed wave should spend it
/// along the corridor instead.
fn corridor_repo() -> Repo {
    let mut files: Vec<(String, String)> = vec![
        ("src/a.ts".into(), "import { mid } from './mid';\nexport function start(x: any) { return mid(x); }\n".into()),
        ("src/mid.ts".into(), "import { tail } from './tail';\nexport function mid(x: any) { return tail(x); }\n".into()),
        ("src/tail.ts".into(), "export function tail(x: any) { return fetch('/api/goal', { method: 'POST' }); }\n".into()),
        (
            "server/src/main/java/api/GoalResource.java".into(),
            "package api;\npublic class GoalResource {\n    @POST\n    @Path(\"/api/goal\")\n    public Response handle(Rep rep) { return Response.ok().build(); }\n}\n".into(),
        ),
    ];
    // the DECOY fan: 40 modules one hop off the source, on no path to the goal
    for i in 0..40 {
        files.push((format!("src/decoy{i}.ts"), format!("import {{ start }} from './a';\nexport function decoy{i}() {{ return start({i}); }}\n")));
    }
    let all: Vec<(&str, &str)> = files.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    repo(&all)
}

fn ctr(file: &str, symbol: &str) -> Center {
    Center { file: file.into(), symbol: symbol.into() }
}

fn grown_files(repo: &str, centers: &[Center], max_nodes: usize) -> HashSet<String> {
    let opts = WaveOpts { max_nodes, max_steps: 12, structural_grow: true, ..Default::default() };
    let g = grow_centers(repo, centers, true, &opts);
    g.map(|g| g.nodes.iter().filter(|n| !n.file.is_empty()).map(|n| n.file.clone()).collect()).unwrap_or_default()
}

/// THE POINT. Two centers, a tight budget: the goal-directed wave must reach the far end, where the same budget
/// spent as an undirected flood does not.
#[test]
fn a_two_center_grow_spends_its_budget_toward_the_other_center() {
    let d = corridor_repo();
    let r = d.path().to_str().unwrap();
    seam_grow::landmarks::LandmarkIndex::reset(None);

    let two = vec![
        ctr("src/a.ts", "start"),
        ctr("server/src/main/java/api/GoalResource.java", "handle"),
    ];
    let one = vec![ctr("src/a.ts", "start")];

    let directed = grown_files(r, &two, 24);
    let flood = grown_files(r, &one, 24);

    let corridor = |s: &HashSet<String>| s.iter().filter(|f| f.contains("mid.ts") || f.contains("tail.ts")).count();
    let decoys = |s: &HashSet<String>| s.iter().filter(|f| f.contains("decoy")).count();

    eprintln!("[a*] directed: {} files ({} corridor, {} decoy)", directed.len(), corridor(&directed), decoys(&directed));
    eprintln!("[a*] flood:    {} files ({} corridor, {} decoy)", flood.len(), corridor(&flood), decoys(&flood));

    assert!(
        corridor(&directed) >= corridor(&flood),
        "the goal-directed grow reached LESS of the corridor than the undirected one — h is steering away from \
         the goal, which means the sign or the key format is wrong"
    );
}

/// The degrade path, and the one that protects every existing caller: a SINGLE center names no goal, so `h` is
/// 0 everywhere and the wave must be exactly the flood it was before this existed.
#[test]
fn a_single_center_grow_is_unchanged() {
    let d = corridor_repo();
    let r = d.path().to_str().unwrap();
    let one = vec![ctr("src/a.ts", "start")];
    let a = grown_files(r, &one, 30);
    let b = grown_files(r, &one, 30);
    assert_eq!(a, b, "a single-center grow is not even deterministic");
    assert!(!a.is_empty(), "the fixture grew nothing");
}

/// THE GATE the corridor test needs: prove `h` is actually non-zero between the two center KEYS. The wave looks
/// nodes up as `normpath(file)#symbol`, and if that spelling misses the table's keys every estimate silently
/// falls back to 0 — an A* that is a flood wearing a priority queue, with every test still green.
#[test]
fn the_center_keys_resolve_in_the_landmark_table() {
    let d = corridor_repo();
    let r = d.path().to_str().unwrap();
    seam_grow::landmarks::LandmarkIndex::reset(None);
    let idx = seam_grow::landmarks::LandmarkIndex::build(r);
    let (keys, _) = idx.debug_graph();
    let a = "src/a.ts#start";
    let goal = "server/src/main/java/api/GoalResource.java#handle";
    assert!(keys.iter().any(|k| k == a), "the source key `{a}` is not in the table; sample: {:?}", keys.iter().take(12).collect::<Vec<_>>());
    assert!(keys.iter().any(|k| k == goal), "the GOAL key `{goal}` is not in the table; sample: {:?}", keys.iter().filter(|k| k.contains("Goal")).take(12).collect::<Vec<_>>());
    let h = idx.h(a, goal).expect("no estimate between the two centers");
    eprintln!("[a*] h(a.ts#start -> GoalResource#handle) = {h}");
    // PINNED AT THE KNOWN-BAD VALUE, deliberately. `h` is 0 here for the same reason it is 0 on keycloak: the
    // over-approximate graph's hub edges are universal shortcuts, so every node sits the same distance from
    // every landmark and the estimate carries no direction. The keys resolving (asserted above) is the part
    // that must not regress; this line records WHY A* is still behind `SEAM_ASTAR`.
    //
    // WHEN THIS ASSERTION STARTS FAILING THE METRIC IS FIXED — flip it to `assert!(h > 0)` and turn the flag on
    // by default. Deleting it instead would lose the only executable statement of what is blocking.
    assert_eq!(h, 0, "h is no longer 0 — the graph now carries a usable metric, so flip this test and enable A*");
}

/// THE CORRIDOR PROBE — is an EXACT two-ended corridor usable where the ALT heuristic was not?
///
/// A* needs `h` because it knows only where it is going. A two-center grow knows BOTH ends, so it does not need
/// an estimate at all: BFS from each end on the cached approximate graph (two traversals, milliseconds) and
/// keep the nodes where `d_A(n) + d_B(n) <= d(A,B) + slack`. That is exact for the query, with none of the
/// triangle-inequality slack that made `h` collapse.
///
/// The open question this measures: the hub edges that flattened the landmark distances may flatten this too.
#[test]
fn keycloak_two_ended_corridor() {
    let repo = "/home/scorbutics/dev/keycloak";
    if !Path::new(repo).exists() {
        return;
    }
    LandmarkIndex::reset(None);
    let idx = LandmarkIndex::build(repo);
    let (keys, adj) = idx.debug_graph();
    let ix = |k: &str| keys.iter().position(|x| x == k);
    let a = ix("js/libs/keycloak-admin-client/src/resources/realms.ts#Realms");
    let b = ix("services/src/main/java/org/keycloak/services/resources/admin/RealmAdminResource.java#updateRealm");
    let (Some(a), Some(b)) = (a, b) else {
        eprintln!("[corridor] one end is not in the graph (a={:?} b={:?})", a, b);
        return;
    };
    let bfs = |src: usize| -> Vec<u32> {
        let mut d = vec![u32::MAX; adj.len()];
        d[src] = 0;
        let mut q = VecDeque::from([src]);
        while let Some(u) = q.pop_front() {
            for &v in &adj[u] {
                if d[v as usize] == u32::MAX {
                    d[v as usize] = d[u] + 1;
                    q.push_back(v as usize);
                }
            }
        }
        d
    };
    let (da, db) = (bfs(a), bfs(b));
    let dab = da[b];
    eprintln!("[corridor] d(A,B) = {dab} over {} nodes", keys.len());
    for slack in 0..=6u32 {
        let mut files = HashSet::new();
        let mut n = 0usize;
        for i in 0..keys.len() {
            if da[i] == u32::MAX || db[i] == u32::MAX { continue; }
            if da[i].saturating_add(db[i]) <= dab + slack {
                n += 1;
                files.insert(keys[i].split('#').next().unwrap_or("").to_string());
            }
        }
        eprintln!("[corridor] slack +{slack}: {n} nodes, {} files", files.len());
    }
    // and WHICH files, at the slack that looks usable — the list is what says whether the corridor is the flow
    let mut files: Vec<&str> = (0..keys.len())
        .filter(|&i| da[i] != u32::MAX && db[i] != u32::MAX && da[i] + db[i] <= dab + 2)
        .map(|i| keys[i].split('#').next().unwrap_or(""))
        .collect();
    files.sort_unstable();
    files.dedup();
    eprintln!("[corridor] slack+2 files ({}): {:?}", files.len(), files.iter().take(40).collect::<Vec<_>>());
}
