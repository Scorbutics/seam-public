//! THE COMPOSED-ROUTE AXIS, COLD HALF — a REST handler class mounted as a SUB-RESOURCE has no class-level
//! route annotation, so its full HTTP path is not written down anywhere: it is composed from a chain of
//! LOCATOR methods in parent classes. The floor cannot read it (nothing local says the path), and grep cannot
//! either (the segments live in different files). The model composes it ONCE from gathered mount evidence and
//! the result persists, so every later run replays it deterministically.
//! Port of the `learn` branch of `composeRoutes` (ts/src/codebase/coupling/route_composer.ts); the replay half
//! is `key_index/compose_routes.rs`.
//!
//! THE DEMAND GATE is what keeps this from being a repo-wide tax: a sub-resource is worth composing only when
//! some route CONSUMER the floor already keyed names the segment that mounts it. Scoped to a grow's footprint,
//! an intent with no route consumers composes NOTHING.

use crate::adapters::http_route::{is_bare_wildcard_route, norm_path, route_segs};
use crate::frameworks::route_annotations::{is_route_annotation, route_annotation_method};
use crate::key_ir::plausible_key_value;
use crate::learn::key_store::{cached_file_keys, persist_file_keys, KeyAdapter};
use crate::types::KeyHit;
use once_cell::sync::Lazy;
use regex::Regex;
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};

const CHAIN_DEPTH: usize = 5; // locator hops climbed (handler → parent → … → root)
const MAX_SNIPPETS: usize = 12; // mount-evidence windows per class
const FILES_PER_CLASS: usize = 24; // non-test grep hits read per hop — the real mount often ranks last, behind tests
const POOL: usize = 3; // in-flight model calls; the demanded set is repo-sized, so the fan is capped

fn max_classes() -> usize {
    // The demand gate is the real bound; this is a safety net for a pathological repo, kept well ABOVE the
    // demanded set so it never truncates a genuinely consumed handler by arbitrary walk order.
    250
}

fn sha1_hex(s: &str) -> String {
    let mut h = Sha1::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

static IS_TEST: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(?:^|/)(?:tests?|testsuite|it|spec|__tests__|e2e)(?:/|$)|(?:Test|Tests|IT|Spec|_test|\.spec|\.test)\.[a-z]+$").unwrap()
});
static CLASS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(?:class|interface|record)\s+(\w+)").unwrap());
static METHOD_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:^|\s)(\w+)\s*\(").unwrap());
static CONTROL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(?:if|for|while|switch|catch|return|new)\b").unwrap());
// `<UpperCaseReturnType> method(` — the locator declaration shape
static DECL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\s*(?:public\s+|protected\s+|final\s+|abstract\s+)*([A-Z]\w+)\s+\w+\s*\(").unwrap());
static ANNOT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"^@(\w[\w.]*)\s*(?:\(\s*(?:\w+\s*=\s*)?["'`]([^"'`]+)["'`])?"#).unwrap());
static STR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#""(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'"#).unwrap());

/// One mount-blind handler: its verb, its declaration line, and the relative sub-segment it declares (which is
/// composed ONTO the mounted prefix rather than replacing it).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Handler {
    pub name: String,
    pub verb: String,
    pub line: usize,
    pub own: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubResource {
    pub class_name: String,
    pub handlers: Vec<Handler>,
}

struct Annot {
    name: String,
    lit: Option<String>,
}

fn annot_of(line: &str) -> Option<Annot> {
    let c = ANNOT_RE.captures(line.trim())?;
    Some(Annot {
        name: c[1].rsplit('.').next().unwrap_or(&c[1]).to_string(),
        lit: c.get(2).map(|m| m.as_str().to_string()),
    })
}

fn delta(s: &str) -> i32 {
    // blank string BODIES first, so a `(` inside a literal can't skew the balance
    STR_RE.replace_all(s, "\"\"").chars().fold(0, |d, c| match c {
        '(' | '{' => d + 1,
        ')' | '}' => d - 1,
        _ => d,
    })
}

fn is_route_name(n: &str) -> bool {
    is_route_annotation(n) || route_annotation_method(n).is_some()
}

// a literal that already gives the handler its OWN groundable path (absolute, or carrying a path variable) —
// then it is NOT mount-blind and the in-file floor already keys it
fn has_own_path(lit: Option<&str>) -> bool {
    lit.is_some_and(|l| l.starts_with('/') || l.contains(['{', '}', '<', '>', ':']))
}

/// The route annotations DIRECTLY attached to the decl at `decl_idx` — scanning UPWARD over the contiguous
/// annotation/comment block, skipping the INTERIOR lines of a multi-line annotation argument by tracking
/// brace/paren balance, and stopping at the previous member. Port of `attachedAnnots`.
fn attached_annots(lines: &[&str], decl_idx: usize) -> Vec<Annot> {
    let mut out = Vec::new();
    let mut bal = 0i32;
    let mut i = decl_idx as i64 - 1;
    while i >= 0 {
        let raw = lines[i as usize];
        let t = raw.trim();
        if bal != 0 {
            bal += delta(raw);
            i -= 1;
            continue;
        }
        if t.is_empty() || t.starts_with("//") || t.starts_with('*') || t.starts_with("/*") {
            if t.is_empty() {
                break; // a blank gap ends the attached block
            }
            i -= 1;
            continue;
        }
        if let Some(a) = annot_of(t) {
            out.push(a);
            i -= 1;
            continue;
        }
        let d = delta(raw);
        if d < 0 {
            bal += d; // the tail of a multi-line annotation argument
            i -= 1;
            continue;
        }
        break; // a previous member
    }
    out
}

/// The MOUNT-BLIND handlers of a sub-resource file: a file whose classes carry NO class-level route annotation
/// but whose methods carry a verb annotation with no own absolute path. File-wide, exactly like the TS side —
/// the handlers are attributed to the file's PRIMARY resource type (the LAST declared, usually the public one),
/// because one resource type per file is the norm for this idiom. Port of `subResources`.
pub fn sub_resources(text: &str) -> Vec<SubResource> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut has_routed_class = false; // any class WITH a class-level route → a normal controller, skip the file
    let mut class_names: Vec<String> = Vec::new();
    let mut handlers: Vec<Handler> = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        let lt = l.trim();
        // only DECL lines drive detection; the annotations are read via `attached_annots`
        if lt.is_empty() || lt.starts_with('@') || lt.starts_with("//") || lt.starts_with('*') {
            continue;
        }
        if let Some(c) = CLASS_RE.captures(lt) {
            class_names.push(c[1].to_string());
            if attached_annots(&lines, i).iter().any(|a| is_route_name(&a.name)) {
                has_routed_class = true;
            }
            continue;
        }
        let Some(mm) = METHOD_RE.captures(lt) else { continue };
        let name = mm.get(1).unwrap().as_str();
        let prefix_end = mm.get(1).unwrap().end();
        if CONTROL_RE.is_match(&lt[..prefix_end]) {
            continue; // a control keyword before the `(` — a statement, not a declaration
        }
        let annots = attached_annots(&lines, i);
        let Some(verb) = annots.iter().find_map(|a| route_annotation_method(&a.name)) else { continue };
        if annots.iter().any(|a| has_own_path(a.lit.as_deref())) {
            continue; // it declares its own groundable path — the floor already keys it
        }
        // a RELATIVE own segment (`@Path("count")`) is composed onto the mounted prefix, not a path of its own
        let own = annots.iter().find(|a| is_route_annotation(&a.name) && a.lit.is_some()).and_then(|a| a.lit.clone());
        handlers.push(Handler { name: name.to_string(), verb: verb.to_string(), line: i, own });
    }
    if has_routed_class || handlers.is_empty() || class_names.is_empty() {
        return Vec::new(); // a routed class is present, or nothing is mount-blind → the floor covers it
    }
    vec![SubResource { class_name: class_names.pop().unwrap(), handlers }]
}

/// SUB-RESOURCE LOCATORS declared in `text`: `@Path("seg") <ReturnType> method(…)` — a route-annotated method
/// whose return type is a resource class, i.e. that class is MOUNTED at `seg`. One pair PER SEGMENT of the
/// normalised path (wildcards dropped), which is what the demand gate matches against. Port of `locators`.
pub fn locators(text: &str) -> Vec<(String, String)> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        let Some(decl) = DECL_RE.captures(l) else { continue };
        for a in attached_annots(&lines, i) {
            if !is_route_annotation(&a.name) {
                continue;
            }
            let Some(lit) = a.lit.as_deref() else { continue };
            for seg in route_segs(&norm_path(lit)) {
                if seg != "*" {
                    out.push((decl[1].to_string(), seg.to_string()));
                }
            }
        }
    }
    out
}

/// Gather the MOUNT EVIDENCE for a class: the files that name it, narrowed to non-test ones, each contributing
/// the window around the mention — then climb to the classes that mount THOSE, up to `depth` hops. Port of
/// `gatherMountChain`.
pub fn gather_mount_chain(repo: &str, class_name: &str, depth: usize, visited: &mut HashSet<String>, out: &mut Vec<(String, String)>) {
    if depth == 0 || out.len() >= MAX_SNIPPETS || !visited.insert(class_name.to_string()) {
        return;
    }
    // A LOCATOR line: `UsersResource users(` — the class as a method's RETURN TYPE.
    let Ok(locator_re) = Regex::new(&format!(r"\b{}\b\s+\w+\s*\(", regex::escape(class_name))) else { return };
    // The class's own DEFINITION line, for its class-level route (the chain's ROOT prefix).
    let Ok(def_re) = Regex::new(&format!(r"\b(?:class|interface)\s+{}\b", regex::escape(class_name))) else { return };
    let owner_re = Regex::new(r"\b(?:public\s+|abstract\s+|final\s+)*(?:class|interface)\s+(\w+)").unwrap();

    let hits: Vec<String> = crate::apply::bridge::grep_files(repo, class_name)
        .into_iter()
        .filter(|f| !IS_TEST.is_match(f))
        .take(FILES_PER_CLASS)
        .collect();
    let mut climb: Vec<String> = Vec::new();
    for f in hits {
        if out.len() >= MAX_SNIPPETS || !crate::ground::floor::ends_with_source_ext(&f) {
            continue;
        }
        let Ok(bytes) = std::fs::read(format!("{repo}/{f}")) else { continue };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let lines: Vec<&str> = text.split('\n').collect();
        // the resource class that OWNS the locators in this file — the next hop UP the chain
        let owner = owner_re.captures(&text).map(|c| c[1].to_string());
        let mut is_locator_file = false;
        for i in 0..lines.len() {
            if out.len() >= MAX_SNIPPETS {
                break;
            }
            // (a) a locator method RETURNING this class, carrying a route annotation → the mount hop
            if locator_re.is_match(lines[i]) && attached_annots(&lines, i).iter().any(|a| is_route_annotation(&a.name) && a.lit.is_some()) {
                push_window(&f, &lines, i, out);
                is_locator_file = true;
            }
            // (b) this class's OWN definition carrying an ABSOLUTE class-level route (`@Path("/admin") class
            //     AdminRoot`) → the ROOT prefix of the whole chain. No locator mounts a root resource, so
            //     without this branch the chain has a hole at the top and the composed path loses its base.
            else if def_re.is_match(lines[i]) {
                if attached_annots(&lines, i).iter().any(|a| is_route_annotation(&a.name) && has_own_path(a.lit.as_deref())) {
                    push_window(&f, &lines, i, out);
                }
            }
        }
        if is_locator_file {
            if let Some(o) = owner {
                if o != class_name {
                    climb.push(o); // climb to each locator's OWNER class, not to the first class in the file
                }
            }
        }
    }
    for owner in climb {
        gather_mount_chain(repo, &owner, depth - 1, visited, out);
    }
}

/// The ±3-line window around an evidence line. A WINDOW, not the whole file: the model is being asked to read
/// a mount chain, and burying three relevant lines in four full source files is how a determinable prefix
/// becomes "can't tell". Mirrors the TS `push`.
fn push_window(file: &str, lines: &[&str], i: usize, out: &mut Vec<(String, String)>) {
    let lo = i.saturating_sub(3);
    let hi = (i + 2).min(lines.len().saturating_sub(1));
    out.push((file.to_string(), format!("… (line {})\n{}", lo + 1, lines[lo..=hi].join("\n"))));
}

fn compose_prompt(sr: &SubResource, snippets: &[(String, String)]) -> String {
    let handlers: Vec<String> = sr
        .handlers
        .iter()
        .map(|h| format!("  - {} {}{}", h.verb, h.name, h.own.as_ref().map(|o| format!(" (own sub-path \"{o}\")")).unwrap_or_default()))
        .collect();
    let evidence: Vec<String> = snippets.iter().map(|(f, s)| format!("=== {f} ===\n{s}")).collect();
    format!(
        r#"A REST HANDLER class is MOUNTED as a SUB-RESOURCE: it has NO class-level route annotation, so its
full HTTP path is composed from a chain of LOCATOR methods in PARENT classes (a route-annotated method that
returns/creates this class), not declared locally. Determine the FULL path each handler serves.

HANDLER CLASS: {}
MOUNT-BLIND HANDLERS (each is <HTTP-VERB> <method>; its path prefix comes ENTIRELY from the mount chain):
{}

MOUNT EVIDENCE (locator methods + parent resources that mount this class and its ancestors, gathered from the repo):
{}

Compose each handler's FULL path by concatenating the mounted prefix (walk the locator chain up to the root)
with the handler's own segment. Use * for every path VARIABLE (`{{realm}}`/`{{id}}`/`:id` → *). Output a handler
ONLY if the evidence DETERMINES its mounted prefix — omit it otherwise (silence beats a guess; a wrong path
grounds nothing but a right one links the whole cross-stack flow). Do NOT invent segments not in the evidence.

Return a JSON array (empty if the mount can't be determined); every object needs a unique "id":
[{{"id":"h1","method":"POST","name":"createUser","path":"/admin/realms/*/users"}}]"#,
        sr.class_name,
        handlers.join("\n"),
        evidence.join("\n\n")
    )
}

fn parse_composed(values: &[serde_json::Value], sr: &SubResource) -> Vec<KeyHit> {
    let by_name: HashMap<&str, &Handler> = sr.handlers.iter().map(|h| (h.name.as_str(), h)).collect();
    let mut keys = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for obj in values {
        let Some(map) = obj.as_object() else { continue };
        let get = |k: &str| map.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let name = get("name");
        let path = norm_path(&get("path"));
        let Some(h) = by_name.get(name.as_str()) else { continue };
        if path.is_empty() || path == "/" {
            continue;
        }
        // a bare `/*` couples to EVERYTHING — it is not a key, it is a wildcard
        if !plausible_key_value(&path) || is_bare_wildcard_route(&path) {
            continue;
        }
        let method = {
            let m = get("method").to_uppercase();
            if m.is_empty() { h.verb.clone() } else { m }
        };
        if !seen.insert(format!("{path} {method}")) {
            continue;
        }
        keys.push(KeyHit { kind: "http-route".into(), value: path, line: h.line, produces: true, method: Some(method), ..Default::default() });
    }
    keys
}

/// What one composition run did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ComposeOutcome {
    pub detected: usize,
    pub demanded: usize,
    pub composed: usize,
}

/// Compose the DEMANDED sub-resource classes and persist each result. `scope` = the flow's files (the demand is
/// read from route consumers inside it); `None` = repo-wide. Port of the `learn` branch of `composeRoutes`.
pub fn compose_learn(repo: &str, scope: Option<&HashSet<String>>, model: Option<&str>, claude_bin: Option<&str>) -> ComposeOutcome {
    let mut outcome = ComposeOutcome::default();
    if !seam_llm::available(claude_bin) {
        return outcome;
    }
    // DEMAND: the segments named by route consumers the floor already keyed, inside the scope. No consumer ⇒
    // nothing to ground ⇒ compose nothing. This is what makes the composer lazy rather than a repo-wide tax.
    let floor = crate::ground::floor_base_index(repo);
    let mut demand_segs: HashSet<String> = HashSet::new();
    for (k, sides) in floor.floor_base.iter() {
        let Some(value) = k.strip_prefix("http-route ") else { continue };
        if !sides.consumers.iter().any(|c| scope.is_none_or(|s| s.contains(&c.file))) {
            continue;
        }
        for seg in route_segs(value) {
            if seg != "*" {
                demand_segs.insert(seg.to_string());
            }
        }
    }

    // PASS 1 — one walk: detect the sub-resource classes still needing composition AND the locator table.
    let mut detected: Vec<(String, String, SubResource)> = Vec::new(); // (rel, content key, sub-resource)
    let mut class_to_segs: HashMap<String, HashSet<String>> = HashMap::new();
    for rel in seam_fs::source_files(repo, crate::ground::floor::scannable_for_keys) {
        if IS_TEST.is_match(&rel) {
            continue;
        }
        let Ok(bytes) = std::fs::read(format!("{repo}/{rel}")) else { continue };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if !text.contains('@') {
            continue; // no annotations → nothing to mount
        }
        for (return_type, seg) in locators(&text) {
            class_to_segs.entry(return_type).or_default().insert(seg);
        }
        for sr in sub_resources(&text) {
            let ck = format!("route-composed::{rel} {}", sha1_hex(&text));
            if cached_file_keys(repo, &ck).0 {
                continue; // already composed → the replay path serves it
            }
            detected.push((rel.clone(), ck, sr));
        }
    }
    outcome.detected = detected.len();

    let demanded: Vec<(String, String, SubResource)> = detected
        .into_iter()
        .filter(|(_, _, sr)| {
            class_to_segs.get(&sr.class_name).is_some_and(|segs| segs.iter().any(|s| demand_segs.contains(s)))
                || sr.handlers.iter().any(|h| h.own.as_ref().is_some_and(|o| demand_segs.contains(o)))
        })
        .take(max_classes())
        .collect();
    outcome.demanded = demanded.len();

    // PASS 2 — compose, POOL at a time (each class is one independent call; the demanded set is repo-sized).
    let opts = seam_llm::PassOpts {
        model: model.map(String::from),
        tag: Some("compose-subresource-route".into()),
        thinking: Some(0),
        claude_bin: claude_bin.map(String::from),
    };
    let results: Vec<(String, String, Vec<KeyHit>, String)> = demanded
        .chunks(POOL)
        .flat_map(|batch| {
            std::thread::scope(|s| {
                let handles: Vec<_> = batch
                    .iter()
                    .map(|(rel, ck, sr)| {
                        let opts = &opts;
                        s.spawn(move || {
                            let mut snippets: Vec<(String, String)> = Vec::new();
                            gather_mount_chain(repo, &sr.class_name, CHAIN_DEPTH, &mut HashSet::new(), &mut snippets);
                            if snippets.is_empty() {
                                return (rel.clone(), ck.clone(), Vec::new(), "no mount evidence found".to_string());
                            }
                            let prompt = compose_prompt(sr, &snippets);
                            let once = || seam_llm::run_pass_json(&prompt, opts).map(|v| parse_composed(&v, sr)).unwrap_or_default();
                            // ONE retry on an empty result: WITH evidence present, empty is almost always a
                            // transient subprocess failure under concurrency, not a genuine "cannot determine".
                            let mut keys = once();
                            if keys.is_empty() {
                                keys = once();
                            }
                            (rel.clone(), ck.clone(), keys, String::new())
                        })
                    })
                    .collect();
                handles.into_iter().filter_map(|h| h.join().ok()).collect::<Vec<_>>()
            })
        })
        .collect();

    for (rel, ck, keys, no_evidence) in results {
        if !no_evidence.is_empty() {
            // a class with NO mount evidence can never be composed — cache the empty so it is not retried
            persist_file_keys(repo, &ck, &KeyAdapter { name: format!("{rel}-routes"), description: no_evidence, keys: Vec::new() });
            continue;
        }
        // Persist ONLY a non-empty composition. An empty WITH evidence survived the retry, so it is a suspected
        // transient failure: leaving it uncached lets the next grow re-attempt it and the flywheel self-heal.
        if !keys.is_empty() {
            let description = keys.iter().map(|k| format!("serves {} {}", k.method.clone().unwrap_or_default(), k.value)).collect::<Vec<_>>().join("; ");
            persist_file_keys(repo, &ck, &KeyAdapter { name: format!("{rel}-routes"), description, keys });
            outcome.composed += 1;
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUB: &str = r#"
public class UsersResource {
    @GET
    public List<User> getUsers() { return null; }

    @POST
    @Path("count")
    public int createUser(User u) { return 1; }
}
"#;

    const PARENT: &str = r#"
@Path("/admin/realms/{realm}")
public class RealmAdminResource {
    @Path("users")
    public UsersResource users() { return new UsersResource(); }
}
"#;

    #[test]
    fn a_class_with_no_class_level_route_is_a_mount_blind_sub_resource() {
        let srs = sub_resources(SUB);
        assert_eq!(srs.len(), 1);
        assert_eq!(srs[0].class_name, "UsersResource");
        let names: Vec<&str> = srs[0].handlers.iter().map(|h| h.name.as_str()).collect();
        assert!(names.contains(&"getUsers") && names.contains(&"createUser"));
        // a RELATIVE own segment is kept (it composes onto the prefix), an absolute one would disqualify it
        assert_eq!(srs[0].handlers.iter().find(|h| h.name == "createUser").unwrap().own.as_deref(), Some("count"));
    }

    #[test]
    fn a_class_that_declares_its_own_route_is_not_a_sub_resource() {
        // it has a class-level @Path, so its handlers are groundable locally and the floor already keys them
        assert!(sub_resources(PARENT).is_empty());
    }

    #[test]
    fn a_locator_names_the_class_it_mounts_and_the_segment() {
        assert_eq!(locators(PARENT), vec![("UsersResource".to_string(), "users".to_string())]);
    }

    #[test]
    fn a_composed_path_must_be_determined_specific_and_not_a_bare_wildcard() {
        let sr = sub_resources(SUB).remove(0);
        let vals: Vec<serde_json::Value> = serde_json::from_str(
            r#"[{"id":"h1","method":"GET","name":"getUsers","path":"/admin/realms/*/users"},
                {"id":"h2","method":"POST","name":"createUser","path":"/*"},
                {"id":"h3","method":"GET","name":"ghostHandler","path":"/admin/realms/*/ghosts"}]"#,
        )
        .unwrap();
        let keys = parse_composed(&vals, &sr);
        assert_eq!(keys.len(), 1, "the bare wildcard and the unknown handler must both be dropped");
        assert_eq!(keys[0].value, "/admin/realms/*/users");
        assert_eq!(keys[0].method.as_deref(), Some("GET"));
        assert!(keys[0].produces, "a handler SERVES its route");
        assert_eq!(keys[0].line, sr.handlers.iter().find(|h| h.name == "getUsers").unwrap().line);
    }

    #[test]
    fn no_backend_composes_nothing_rather_than_failing() {
        let dir = std::env::temp_dir().join(format!("seam-compose-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let o = compose_learn(&dir.to_string_lossy(), None, None, Some("/nonexistent/claude-xyz"));
        assert_eq!(o, ComposeOutcome::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── THE DETERMINISTIC HALVES OF THE COMPOSED-ROUTE TEACHER ────────────────────────────────────────────
    // A route handler whose class carries NO class-level route annotation is a mount-blind SUB-RESOURCE: its
    // full path is assembled from a cross-file locator chain. The LLM concatenates the fragments; everything
    // below it — detecting the mount-blind handlers, and gathering the chain's evidence — is deterministic and
    // is what makes the composition possible at all. Ported from `route_composer.test.ts`.
    //
    // The fixture is a JAX-RS locator chain across four files:
    //   Root(@Path("/api")) ──@Path("realms")──▶ RealmsResource ──@Path("{realm}")──▶ RealmAdminResource
    //     ──@Path("users")──▶ UsersResource ──@POST createUser / @GET @Path("count")──▶ the handlers
    // UsersResource has NO class-level route, so its handlers compose to /api/realms/*/users[...].
    const USERS_RESOURCE: &str = r#"public class UsersResource {
  @POST
  @Consumes(MediaType.APPLICATION_JSON)
  @APIResponses(value = {
    @APIResponse(responseCode = "201", description = "Created"),
    @APIResponse(responseCode = "409", description = "Conflict")
  })
  public Response createUser(final UserRepresentation rep) { return null; }

  @GET
  @Path("count")
  public Response getUsersCount() { return null; }
}
"#;

    // A NORMAL controller: it carries a class-level @Path, so the in-file floor already keys it.
    const HEALTH_CONTROLLER: &str = "@Path(\"/health\")\npublic class HealthController {\n  @GET\n  public Response health() { return null; }\n}\n";

    #[test]
    fn detects_the_mount_blind_verb_handlers_of_a_sub_resource() {
        let srs = sub_resources(USERS_RESOURCE);
        assert_eq!(srs.len(), 1);
        assert_eq!(srs[0].class_name, "UsersResource");
        let by_name: std::collections::HashMap<&str, &Handler> = srs[0].handlers.iter().map(|h| (h.name.as_str(), h)).collect();
        assert_eq!(by_name.get("createUser").map(|h| h.verb.as_str()), Some("POST")); // bare @POST, mounted externally
        assert_eq!(by_name.get("getUsersCount").map(|h| h.verb.as_str()), Some("GET"));
        // the relative own segment is carried through, because composition needs base ⊕ own
        assert_eq!(by_name.get("getUsersCount").and_then(|h| h.own.as_deref()), Some("count"));
    }

    #[test]
    fn does_not_flag_a_class_routed_controller() {
        // The floor already keys it in-file. Flagging it would spend a composition call to re-derive a path
        // that is sitting right there in the annotation.
        assert!(sub_resources(HEALTH_CONTROLLER).is_empty());
    }

    #[test]
    fn locators_map_a_return_type_resource_class_to_its_mount_segment() {
        // `@Path("users") public UsersResource users()` → UsersResource mounts at "users". This is the
        // DEMAND GATE signal: a consumer route naming `users` is what makes UsersResource worth composing.
        let text = "public class RealmAdminResource {\n  @Path(\"users\")\n  public UsersResource users() { return new UsersResource(); }\n}\n";
        assert!(locators(text).contains(&("UsersResource".to_string(), "users".to_string())));
    }

    #[test]
    fn gathers_the_locator_fragments_and_the_root_class_path_across_files() {
        let Some(dir) = crate::learn::compose_learn::tests::rg_fixture() else { return }; // needs ripgrep
        let repo = dir.to_string_lossy().to_string();
        let mut out: Vec<(String, String)> = Vec::new();
        gather_mount_chain(&repo, "UsersResource", 5, &mut HashSet::new(), &mut out);
        let blob = out.iter().map(|(_, s)| s.as_str()).collect::<Vec<_>>().join("\n");
        // every hop's evidence is present — the fragments that concatenate to /api/realms/*/users
        assert!(blob.contains("@Path(\"users\")"), "RealmAdminResource → UsersResource missing: {blob}");
        assert!(blob.contains("@Path(\"{realm}\")"), "RealmsResource → RealmAdminResource missing");
        assert!(blob.contains("@Path(\"/api\")"), "the ROOT class prefix was not climbed to");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The four-file chain on disk, in a directory of its OWN — the sibling test below uses
    /// `seam-compose-<pid>` and wipes it, which under the parallel runner would delete this fixture mid-grep.
    /// `None` when ripgrep is absent — the gather greps, so there is nothing to
    /// assert without it (and asserting an empty blob would pass for the wrong reason).
    pub(super) fn rg_fixture() -> Option<std::path::PathBuf> {
        if std::process::Command::new("rg").arg("--version").output().map(|o| !o.status.success()).unwrap_or(true) {
            return None;
        }
        let dir = std::env::temp_dir().join(format!("seam-compose-gather-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).ok()?;
        let w = |rel: &str, t: &str| std::fs::write(dir.join("src").join(rel), t);
        w("Root.java", "@Path(\"/api\")\npublic class Root {\n  @Path(\"realms\")\n  public RealmsResource realms() { return new RealmsResource(); }\n}\n").ok()?;
        w("RealmsResource.java", "public class RealmsResource {\n  @Path(\"{realm}\")\n  public RealmAdminResource realm(@PathParam(\"realm\") String r) { return new RealmAdminResource(); }\n}\n").ok()?;
        w("RealmAdminResource.java", "public class RealmAdminResource {\n  @Path(\"users\")\n  public UsersResource users() { return new UsersResource(); }\n}\n").ok()?;
        w("UsersResource.java", USERS_RESOURCE).ok()?;
        Some(dir)
    }
}
