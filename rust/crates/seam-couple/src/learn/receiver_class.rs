//! RECEIVER + ANNOTATION CLASSIFICATION — the flywheel axis that learns a codebase's OWN abstractions.
//!
//! A repo's data layers are named by its authors (`userRepository`, `cache`, `bus`, `$http`), so no builtin
//! adapter set can know them. What IS knowable structurally: which receivers RECUR across files and what verbs
//! are called on them. That profile is a candidate; the model then says what KIND of resource it is, and the
//! answer is compiled into a matcher rule that grounds deterministically forever after.
//! Port of `classifyAndPersistRepositories` / `classifyAndPersistAnnotations` (coupling/receiver_class.ts).
//!
//! THE EXTERNALITY GATE is what keeps this from drowning the graph. A receiver is only a boundary if the call
//! graph CANNOT already follow it: a node_modules import, a binding initialised from one, or a never-declared
//! global. An in-repo object with getters/setters (`savings.get('rate')`) is local data flow the grow already
//! traverses — coupling on it would add noise, not a moat.

use crate::learn::key_store::{has_learned_matchers_for, persist_matchers, record_learned_matchers};
use crate::learn::matchers::{validate_matcher, KeyMatcher};
use serde_json::json;
use crate::mask::MaskCtx;
use once_cell::sync::Lazy;
use regex::Regex;
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};

const MIN_FILES: usize = 4; // a receiver must RECUR across files to be a shared abstraction, not a local
const MAX_CANDIDATES: usize = 80; // bound the prompt to the most-recurring candidates

const SELF: &[&str] = &["this", "self", "super"];
const READ_PRE: &[&str] = &["get", "find", "fetch", "load", "list", "read", "query", "count", "exists", "check", "is", "has", "select", "retrieve", "search", "lookup"];
const WRITE_PRE: &[&str] = &["set", "create", "insert", "add", "save", "update", "delete", "remove", "destroy", "upsert", "put", "patch", "write", "store", "persist"];
const EVENT_P: &[&str] = &["emit", "publish", "dispatch", "fire", "trigger", "broadcast", "next", "send"];
const EVENT_C: &[&str] = &["on", "once", "subscribe", "listen", "addeventlistener", "addlistener", "handle"];
const HTTP_CLIENT: &[&str] = &["get", "post", "put", "delete", "patch", "request", "fetch", "head", "options"];
const HTTP_W: &[&str] = &["post", "put", "patch", "request"];

// `a.b.c(` — a dotted receiver chain ending in a call. Rust's regex crate has no look-behind, so the
// "not preceded by [\w$.]" guard of the TS pattern is applied by inspecting the byte before the match.
static CHAIN: Lazy<Regex> = Lazy::new(|| Regex::new(r"((?:[A-Za-z_$][\w$]*\s*\.\s*)+[A-Za-z_$][\w$]*)\s*\(").unwrap());
static LOCAL_DECL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(?:const|let|var|function|class)[ \t]+([A-Za-z_$][\w$]*)").unwrap());
static IMPORT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\bimport\b([^'"]*?)\bfrom[ \t]*['"]([^'"]+)['"]"#).unwrap());
static REQUIRE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\b(?:const|let|var)[ \t]+(\{[^}]*\}|[A-Za-z_$][\w$]*)[ \t]*=[ \t]*require\([ \t]*['"]([^'"]+)['"]"#).unwrap());
static DECL_INIT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*([^\n;]+)").unwrap());
static TYPED_DECL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:^|[\s(,;])([A-Z][\w$]*)[ \t]+([a-z_$][\w$]*)[ \t]*[;=,)]").unwrap());
static TS_TYPED_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b([a-z_$][\w$]*)[ \t]*:[ \t]*([A-Z][\w$]*)").unwrap());
static ID_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[A-Za-z_$][\w$]*").unwrap());
static ANNOT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"@(\w+)\s*\(\s*["'`]([^"'`\s][^"'`]*)["'`]"#).unwrap());

fn lc(v: &str) -> String {
    v.to_lowercase()
}
fn is_read(v: &str) -> bool {
    crate::verb_class::data_role(v) == Some("read") || READ_PRE.iter().any(|p| lc(v).starts_with(p))
}
fn is_write(v: &str) -> bool {
    crate::verb_class::data_role(v) == Some("write") || WRITE_PRE.iter().any(|p| lc(v).starts_with(p))
}
fn is_prod(v: &str) -> bool {
    is_write(v) || EVENT_P.contains(&lc(v).as_str()) || HTTP_W.contains(&lc(v).as_str())
}
fn is_cons(v: &str) -> bool {
    is_read(v) || EVENT_C.contains(&lc(v).as_str())
}
fn is_bare(src: &str) -> bool {
    !src.starts_with('.') && !src.starts_with('/') // a node_modules specifier
}

fn sha1_hex(s: &str) -> String {
    let mut h = Sha1::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// One recurring receiver: how many files it appears in, and the verbs called on it with counts.
#[derive(Clone, Debug)]
pub struct Profile {
    pub receiver: String,
    pub verbs: Vec<(String, usize)>,
    pub files: usize,
}

/// The line the model judges: the receiver and its top verbs by frequency. Also the SIGNATURE the learn-once
/// gate hashes, so an unchanged codebase replays with no call.
pub fn profile_line(p: &Profile) -> String {
    let mut vs = p.verbs.clone();
    vs.sort_by(|a, b| b.1.cmp(&a.1)); // count desc; ties keep insertion order, like the TS sort
    let top: Vec<String> = vs.iter().take(8).map(|(v, c)| format!("{v}({c})")).collect();
    format!("{}: {}", p.receiver, top.join(" "))
}

struct Inventory {
    profiles: Vec<Profile>,
    bare_import: HashSet<String>,
    local_def: HashSet<String>,
    decl_rhs: HashMap<String, HashSet<String>>,
    typed_as: HashMap<String, HashSet<String>>,
}

impl Inventory {
    /// EXTERNAL = a node_modules import, a binding INITIALISED from one (`const cache = new Redis()`), or a
    /// never-declared free global (`localStorage`). In-repo-declared with an in-repo initialiser, or an
    /// instance whose declared TYPE is an in-repo class (a DI-injected repository), is local data flow the grow
    /// already traverses. Decided by the ROOT of a dotted path — a sub-handle inherits its root's provenance.
    fn is_external(&self, r_path: &str) -> bool {
        let r = r_path.split('.').next().unwrap_or(r_path);
        let external_backed = self.decl_rhs.get(r).is_some_and(|s| s.iter().any(|id| self.bare_import.contains(id)));
        let in_repo_typed = self.typed_as.get(r).is_some_and(|s| s.iter().any(|t| self.local_def.contains(t)));
        self.bare_import.contains(r) || external_backed || (!self.local_def.contains(r) && !in_repo_typed)
    }
}

fn ids_in(s: &str) -> Vec<String> {
    ID_RE.find_iter(s).map(|m| m.as_str().to_string()).collect()
}

fn inventory(repo: &str) -> Inventory {
    let mut inv: Vec<(String, (HashSet<String>, Vec<(String, usize)>))> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut local_def = HashSet::new();
    let mut bare_import = HashSet::new();
    let mut decl_rhs: HashMap<String, HashSet<String>> = HashMap::new();
    let mut typed_as: HashMap<String, HashSet<String>> = HashMap::new();

    let mut bump = |inv: &mut Vec<(String, (HashSet<String>, Vec<(String, usize)>))>, index: &mut HashMap<String, usize>, key: String, rel: &str, verb: &str| {
        let i = *index.entry(key.clone()).or_insert_with(|| {
            inv.push((key, (HashSet::new(), Vec::new())));
            inv.len() - 1
        });
        let e = &mut inv[i].1;
        e.0.insert(rel.to_string());
        match e.1.iter_mut().find(|(v, _)| v == verb) {
            Some(slot) => slot.1 += 1,
            None => e.1.push((verb.to_string(), 1)),
        }
    };

    for rel in seam_fs::source_files(repo, crate::ground::floor::scannable_for_keys) {
        let Ok(bytes) = std::fs::read(format!("{repo}/{rel}")) else { continue };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let masked = MaskCtx::new(&text);
        let code = masked.comments();
        for m in CHAIN.captures_iter(code) {
            let whole = m.get(1).unwrap();
            // the TS look-behind: the chain must not continue leftwards
            if whole.start() > 0 {
                let prev = code.as_bytes()[whole.start() - 1] as char;
                if prev.is_alphanumeric() || prev == '_' || prev == '$' || prev == '.' {
                    continue;
                }
            }
            let mut p: Vec<&str> = whole.as_str().split('.').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
            while !p.is_empty() && SELF.contains(&p[0]) {
                p.remove(0);
            }
            if p.len() < 2 {
                continue;
            }
            let (root, verb) = (p[0], p[p.len() - 1]);
            if root.len() < 2 {
                continue;
            }
            bump(&mut inv, &mut index, root.to_string(), &rel, verb);
            // NESTED SUB-HANDLE — `client.auth.signIn` also profiles `client.auth`, because the root alone
            // mixes every sub-handle (auth + db + storage) and loses the scope a `service` classification needs.
            if p.len() >= 3 {
                bump(&mut inv, &mut index, p[..p.len() - 1].join("."), &rel, verb);
            }
        }
        for c in LOCAL_DECL_RE.captures_iter(code) {
            local_def.insert(c[1].to_string());
        }
        for c in IMPORT_RE.captures_iter(code) {
            for n in ids_in(&c[1]).into_iter().filter(|n| n != "as") {
                if is_bare(&c[2]) { bare_import.insert(n); } else { local_def.insert(n); }
            }
        }
        for c in REQUIRE_RE.captures_iter(code) {
            for n in ids_in(&c[1]).into_iter().filter(|n| n != "as") {
                if is_bare(&c[2]) { bare_import.insert(n); } else { local_def.insert(n); }
            }
        }
        for c in DECL_INIT_RE.captures_iter(code) {
            decl_rhs.entry(c[1].to_string()).or_default().extend(ids_in(&c[2]));
        }
        for c in TYPED_DECL_RE.captures_iter(code) {
            typed_as.entry(c[2].to_string()).or_default().insert(c[1].to_string());
        }
        for c in TS_TYPED_RE.captures_iter(code) {
            typed_as.entry(c[1].to_string()).or_default().insert(c[2].to_string());
        }
    }
    let profiles = inv
        .into_iter()
        .filter(|(_, e)| e.0.len() >= MIN_FILES)
        .map(|(receiver, e)| Profile { receiver, files: e.0.len(), verbs: e.1 })
        .collect();
    Inventory { profiles, bare_import, local_def, decl_rhs, typed_as }
}

/// A CANDIDATE both consumes and does something else (a layer that is read AND written), and is EXTERNAL.
/// The broad net the model then confirms and types.
pub(crate) fn candidates(inv: &Inventory) -> Vec<Profile> {
    let mut out: Vec<Profile> = inv
        .profiles
        .iter()
        .filter(|p| {
            // a READ verb + a NON-READ verb: the conventional data layer (create+find) AND a stateful SERVICE
            // handle whose mutations don't follow write conventions (signIn/signOut alongside getSession).
            inv.is_external(&p.receiver) && p.verbs.iter().any(|(v, _)| is_cons(v)) && p.verbs.iter().any(|(v, _)| !is_cons(v))
        })
        .cloned()
        .collect();
    out.sort_by(|a, b| b.files.cmp(&a.files));
    out.truncate(MAX_CANDIDATES);
    out
}

fn prompt(cands: &[Profile]) -> String {
    let lines: Vec<String> = cands.iter().map(profile_line).collect();
    format!(
        r#"You are classifying RECEIVER OBJECTS in a codebase by WHAT KIND of resource each one accesses —
judging only from the methods called on it (a dev recognises "userRepository is the user data layer", "axios
is the http client"). For each receiver below you get its name and the methods called on it (with counts).

Classify each as exactly one of:
  database — a DB / ORM / repository data layer (entities read & written: create/findMany/update/delete/save)
  http     — an HTTP CLIENT that CALLS a remote endpoint BY ROUTE PATH (`axios.get('/api/x')`, fetch, a custom
             `$http.post('/url')`). The string arg is a route. NOT a request/response/url/params object that
             reads headers/params/body LOCALLY (`req.get('header')`, `res.json()`, `params.get('id')`,
             `searchParams.get`, `url.get`) — those carry no cross-service route, classify them `none`.
  config   — configuration access (get/set of settings, flags, environment)
  store    — a SHARED, EXTERNAL/INFRASTRUCTURE state layer: browser localStorage/sessionStorage, a cache
             (Redis/memcached), a session store, or a global app store (vuex/redux/pinia). The thing it
             reads/writes lives OUTSIDE this code's call graph — coupling it links readers to writers across an
             opaque boundary. NOT a DOMAIN MODEL with field accessors (`savings.get('rate')`, `account.set(…)`,
             `loan.getAmount()`): those are an in-code object whose data the call graph already follows — `none`.
  event    — an event / message bus (emit/publish/subscribe/listen)
  service  — a stateful EXTERNAL SDK HANDLE whose methods MUTATE vs READ a shared SINGLETON state living OUTSIDE
             this code, with NO per-call string key — the HANDLE ITSELF is the shared resource: an auth/session
             client (`auth.signInWithPassword(...)` then `auth.getSession()`/`auth.getUser()`), a feature-flag /
             remote-config client (`flags.identify(...)` then `flags.isEnabled('x')`). Distinguish from: `database`
             (reads/writes table ENTITIES), `http` (a route PATH arg), `store`/`event` (a string KEY arg). Here
             there is no table, no route, no string key — just verbs on a singleton handle.
  none     — none of the above: logging, test mocks/assertions, stdlib, local collections, request/response/url
             objects, a DOMAIN MODEL / entity with getters/setters, UI framework scopes, generic utilities.
             ALSO none: a QUERY-BUILDER / query OBJECT — a local you build then execute (`query`, `typedQuery`,
             `criteriaQuery`, `ldapQuery`, `q`) with `getResultList`/`getSingleResult`/`getResultStream`/
             `setParameter`/`setMaxResults`/`addWhereCondition`. The DB layer is the EntityManager/repository that
             CREATED it (`em.createQuery(...)`), NOT the query handle — that handle carries no table identity, so
             classifying it `database` fabricates a phantom table named after the variable.

Judge by MEANING — the test is "is this an EXTERNAL layer the call graph CANNOT follow (a blindspot), or an
in-code object it can?". `axios.create`/`axios.delete` are HTTP (a client + an HTTP DELETE), NOT database;
`localStorage.getItem`/`cache.set` is a store; a domain `savings`/`loan`/`account` with get/set of its OWN
fields is `none` (local data flow, not a boundary); a `*Repository`/`*Fixture` of entities is database;
`req`/`res`/`params`/`searchParams`/`url`/`$scope` are `none`.

{}

Return a JSON array, one object per receiver — "id" is the receiver NAME exactly as given:
[{{"id":"userRepository","type":"database"}},{{"id":"axios","type":"http"}}]"#,
        lines.join("\n")
    )
}

fn parse_types(values: &[serde_json::Value]) -> HashMap<String, String> {
    let mut types = HashMap::new();
    for obj in values {
        let Some(map) = obj.as_object() else { continue };
        let r = map.get("id").or_else(|| map.get("receiver")).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let t = map.get("type").and_then(|v| v.as_str()).unwrap_or("").trim().to_lowercase();
        if !r.is_empty() && !t.is_empty() {
            types.insert(r, t);
        }
    }
    types
}

/// Compile a classified receiver into matcher rules. Kept separate from the pass so it is testable without a
/// model call — this is where a type becomes GROUNDING, and the shape of each rule is the actual contract.
pub fn matchers_for(p: &Profile, t: &str) -> Vec<KeyMatcher> {
    let vs: Vec<String> = p.verbs.iter().map(|(v, _)| v.clone()).collect();
    let pick = |f: &dyn Fn(&str) -> bool| -> Vec<String> { vs.iter().filter(|v| f(v)).cloned().collect() };
    let mut out = Vec::new();
    let mut push = |spec: serde_json::Value| {
        if let Some(m) = validate_matcher(&spec) {
            out.push(m);
        }
    };
    match t {
        // 2-part repository: the RECEIVER is the table (the member_access floor covers the 3-part case)
        "database" => {
            push(json!({ "via": "repository", "token": p.receiver, "verbs": pick(&is_read), "kind": "db-table", "role": "consumes" }));
            push(json!({ "via": "repository", "token": p.receiver, "verbs": pick(&is_write), "kind": "db-table", "role": "produces" }));
        }
        // receiver-scoped channel: the STRING-LITERAL arg is the key (`bus.emit('e')` ⇄ `bus.on('e')`)
        "event" | "store" => {
            let kind = if t == "event" { "event" } else { "cache" };
            let (prod, cons) = (pick(&is_prod), pick(&is_cons));
            if !prod.is_empty() {
                push(json!({ "via": "channel", "token": p.receiver, "verbs": prod, "kind": kind, "role": "produces" }));
            }
            if !cons.is_empty() {
                push(json!({ "via": "channel", "token": p.receiver, "verbs": cons, "kind": kind, "role": "consumes" }));
            }
        }
        // an http CLIENT consumes a route — the literal grounds with the backend handler that SERVES it
        "http" => {
            let http_verbs = pick(&|v| HTTP_CLIENT.contains(&lc(v).as_str()));
            if !http_verbs.is_empty() {
                push(json!({ "via": "channel", "token": p.receiver, "verbs": http_verbs, "kind": "http-route", "role": "consumes" }));
            }
        }
        // stateful external handle: READ verbs consume the singleton state, everything else mutates it. Both
        // rules carry the SAME token → the same key → they ground. Emitted only when BOTH sides exist, since a
        // lone producer or consumer grounds nothing.
        "service" => {
            let cons = pick(&is_read);
            let prod: Vec<String> = vs.iter().filter(|v| !cons.contains(v)).cloned().collect();
            if !prod.is_empty() && !cons.is_empty() {
                push(json!({ "via": "handle", "token": p.receiver, "verbs": prod, "kind": "service", "role": "produces" }));
                push(json!({ "via": "handle", "token": p.receiver, "verbs": cons, "kind": "service", "role": "consumes" }));
            }
        }
        _ => {}
    }
    out
}

/// The candidate set the classifier would ask about — exposed so a comparator can pin it without a model call.
pub fn candidate_profiles(repo: &str) -> Vec<Profile> {
    candidates(&inventory(repo))
}

/// Classify the recurring receivers and PERSIST the rules. Gated on the candidate-set SIGNATURE, so an
/// unchanged codebase replays from `.seam` with no model call. Port of `classifyAndPersistRepositories`.
pub fn classify_receivers(repo: &str, model: Option<&str>, claude_bin: Option<&str>) -> Vec<KeyMatcher> {
    if !seam_llm::available(claude_bin) {
        return Vec::new(); // degrades to the member_access (3-part) floor only
    }
    let inv = inventory(repo);
    let cands = candidates(&inv);
    if cands.is_empty() {
        return Vec::new();
    }
    let mut sig_lines: Vec<String> = cands.iter().map(profile_line).collect();
    sig_lines.sort();
    let sig = format!("rc:{}", sha1_hex(&sig_lines.join("\n")));
    if has_learned_matchers_for(repo, &sig) {
        return Vec::new(); // already persisted; load_matchers has them
    }
    let opts = seam_llm::PassOpts {
        model: model.map(String::from),
        tag: Some("classify-receivers".into()),
        thinking: Some(0),
        claude_bin: claude_bin.map(String::from),
    };
    let Ok(values) = seam_llm::run_pass_json(&prompt(&cands), &opts) else { return Vec::new() };
    let types = parse_types(&values);
    let matchers: Vec<KeyMatcher> = cands.iter().flat_map(|p| types.get(&p.receiver).map(|t| matchers_for(p, t)).unwrap_or_default()).collect();
    persist_matchers(repo, &matchers);
    record_learned_matchers(repo, &sig); // same candidates next run → replay, no call
    matchers
}

// ── ANNOTATION CLASSIFICATION ────────────────────────────────────────────────────────────────────────────
// The same ladder for ANNOTATIONS: a `@Name("literal")` decorator is to a route/queue/event what a receiver is
// to a data layer. Many annotations share that shape (a route vs `@Param` vs `@DocsTags`), so the discriminator
// is MEANING, not the name — which is exactly what the builtin set cannot know about a project's custom ones.

#[derive(Clone, Debug)]
pub struct AnnotProfile {
    pub name: String,
    pub lits: Vec<String>,
    pub files: usize,
}

fn annot_inventory(repo: &str) -> Vec<AnnotProfile> {
    let mut inv: Vec<(String, (HashSet<String>, Vec<String>))> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for rel in seam_fs::source_files(repo, crate::ground::floor::scannable_for_keys) {
        let Ok(bytes) = std::fs::read(format!("{repo}/{rel}")) else { continue };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let masked = MaskCtx::new(&text);
        for c in ANNOT_RE.captures_iter(masked.comments()) {
            let i = *index.entry(c[1].to_string()).or_insert_with(|| {
                inv.push((c[1].to_string(), (HashSet::new(), Vec::new())));
                inv.len() - 1
            });
            let e = &mut inv[i].1;
            e.0.insert(rel.clone());
            if !e.1.iter().any(|l| l == &c[2]) {
                e.1.push(c[2].to_string());
            }
        }
    }
    let mut out: Vec<AnnotProfile> = inv
        .into_iter()
        .filter(|(_, e)| e.0.len() >= MIN_FILES)
        .map(|(name, e)| AnnotProfile { name, files: e.0.len(), lits: e.1 })
        .collect();
    out.sort_by(|a, b| b.files.cmp(&a.files));
    out.truncate(MAX_CANDIDATES);
    out
}

fn annot_prompt(cands: &[AnnotProfile]) -> String {
    let lines: Vec<String> = cands
        .iter()
        .map(|c| format!("@{}: {}", c.name, c.lits.iter().take(6).map(|l| format!("\"{}\"", l.chars().take(28).collect::<String>())).collect::<Vec<_>>().join(" ")))
        .collect();
    format!(
        r#"Classify each ANNOTATION/decorator by what KIND of cross-service coupling its STRING-LITERAL arg
declares — judging by MEANING, not the name. Is the literal a URL ROUTE PATH, a message QUEUE/topic, an EVENT
name — or NONE of those (a param/header name, a doc tag, a role/enum, a config flag, a bean name)?
  route — the literal is a URL path: "/", "/:id", "v1", "member/booking" (an HTTP endpoint the handler serves)
  queue — a message queue / topic name (JMS/Kafka/AMQP listener: @JmsListener("orders.export"))
  event — an application event name (@EventListener("user.created"), @OnEvent("order.placed"))
  none  — a param/header NAME ("userId","Authorization"), a doc tag ("Bookings"), a role/enum ("TEAM_ADMIN",
          "SCALE"), a config flag, a bean/DI name — NOT a cross-service key.

{}

Return a JSON array, id = the annotation name (no @): [{{"id":"Get","type":"route"}},{{"id":"Param","type":"none"}}]"#,
        lines.join("\n")
    )
}

/// Classify recurring annotations and persist `annotation` rules for the route/queue/event ones. A CUSTOM route
/// annotation only — the floor already handles the builtin set. Port of `classifyAndPersistAnnotations`.
pub fn classify_annotations(repo: &str, model: Option<&str>, claude_bin: Option<&str>) -> Vec<KeyMatcher> {
    if !seam_llm::available(claude_bin) {
        return Vec::new();
    }
    let cands = annot_inventory(repo);
    if cands.is_empty() {
        return Vec::new();
    }
    let mut sig_lines: Vec<String> = cands
        .iter()
        .map(|c| {
            let mut ls = c.lits.clone();
            ls.sort();
            format!("{}:{}", c.name, ls.join(","))
        })
        .collect();
    sig_lines.sort();
    let sig = format!("ra:{}", sha1_hex(&sig_lines.join("\n")));
    if has_learned_matchers_for(repo, &sig) {
        return Vec::new();
    }
    let opts = seam_llm::PassOpts {
        model: model.map(String::from),
        tag: Some("classify-annotations".into()),
        thinking: Some(0),
        claude_bin: claude_bin.map(String::from),
    };
    let Ok(values) = seam_llm::run_pass_json(&annot_prompt(&cands), &opts) else { return Vec::new() };
    let types = parse_types(&values);
    let mut matchers: Vec<KeyMatcher> = Vec::new();
    for c in &cands {
        let Some(t) = types.get(&c.name) else { continue };
        let spec = match t.as_str() {
            // a CUSTOM route annotation only; the floor already grounds @Get/@Path
            "route" if !crate::frameworks::route_annotations::is_route_annotation(&c.name) => json!({ "via": "annotation", "annotation": c.name, "kind": "http-route", "role": "produces" }),
            "queue" => json!({ "via": "annotation", "annotation": c.name, "kind": "queue", "role": "consumes" }), // a listener CONSUMES the queue
            "event" => json!({ "via": "annotation", "annotation": c.name, "kind": "event", "role": "consumes" }), // a handler CONSUMES the event
            _ => continue,
        };
        if let Some(m) = validate_matcher(&spec) {
            matchers.push(m);
        }
    }
    persist_matchers(repo, &matchers);
    record_learned_matchers(repo, &sig);
    matchers
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prof(receiver: &str, verbs: &[(&str, usize)]) -> Profile {
        Profile { receiver: receiver.into(), verbs: verbs.iter().map(|(v, c)| (v.to_string(), *c)).collect(), files: 5 }
    }

    #[test]
    fn a_database_receiver_compiles_to_a_read_rule_and_a_write_rule() {
        let ms = matchers_for(&prof("userRepository", &[("findMany", 9), ("create", 4), ("update", 2)]), "database");
        assert_eq!(ms.len(), 2, "the table is read AND written — both sides must ground");
    }

    #[test]
    fn a_service_handle_needs_both_sides_or_it_grounds_nothing() {
        // reads only → a lone consumer has nothing to pair with, so no rule at all
        assert!(matchers_for(&prof("auth", &[("getSession", 5), ("getUser", 3)]), "service").is_empty());
        // a mutation alongside the reads → both rules, on the SAME token, so they ground against each other
        assert_eq!(matchers_for(&prof("auth", &[("getSession", 5), ("signInWithPassword", 2)]), "service").len(), 2);
    }

    #[test]
    fn a_none_classification_compiles_to_nothing() {
        // the model rejecting a candidate must produce NO rule — that is how a domain object stays out
        assert!(matchers_for(&prof("savings", &[("get", 9), ("set", 4)]), "none").is_empty());
    }

    #[test]
    fn an_http_client_only_keeps_its_http_verbs() {
        let ms = matchers_for(&prof("axios", &[("get", 9), ("post", 4), ("interceptors", 2)]), "http");
        assert_eq!(ms.len(), 1, "one consumer rule over the http verbs");
    }

    #[test]
    fn the_profile_line_orders_verbs_by_frequency() {
        // it is both the prompt line and the learn-once SIGNATURE, so its order must be stable
        assert_eq!(profile_line(&prof("cache", &[("set", 2), ("get", 7)])), "cache: get(7) set(2)");
    }
}

#[cfg(test)]
mod classify_tests {
    use super::*;
    use std::collections::HashMap;

    // RECEIVER CLASSIFICATION — the model says what a repeated receiver IS (database / http / store / none) and
    // the answer picks the MATCHER SHAPE. A `userRepository` typed database becomes a repository matcher keyed
    // on the receiver (it IS the table); an `axios` typed http becomes an http-route CHANNEL keyed on the path.
    // Getting that backwards keys every outbound HTTP call as a database table. Ported from
    // `receiver_class.test.ts`, now that the host bus reaches the core and the pass can be served in-process.
    //
    // These share the process-global host bus and the SEAM_ADAPTERS_DIR env, so they run as ONE test rather
    // than racing each other under the parallel runner.
    struct Fixture(std::path::PathBuf, std::path::PathBuf);

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
            let _ = std::fs::remove_dir_all(&self.1);
            seam_llm::host_bus::uninstall();
        }
    }

    fn fixture(tag: &str) -> Fixture {
        let base = std::env::temp_dir();
        let repo = base.join(format!("seam-rc-{tag}-{}", std::process::id()));
        let shared = base.join(format!("seam-rc-shared-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&shared);
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::create_dir_all(&shared).unwrap();
        std::env::set_var("SEAM_ADAPTERS_DIR", &shared);
        Fixture(repo, shared)
    }


    /// The receiver TOKEN a matcher keys on, for the two variants classification produces.
    fn token_of(m: &KeyMatcher) -> Option<&str> {
        match m {
            KeyMatcher::Repository { token, .. } | KeyMatcher::Channel { token, .. } => Some(token.as_str()),
            _ => None,
        }
    }

    /// Serve `answer` to the classify pass and return the PROMPT it was asked, plus the matchers produced.
    /// Two rounds, because the host bus records on the first and replays on the second — the same pump the
    /// TypeScript shell drives.
    fn run_classify(repo: &str, answer: &str) -> (String, Vec<KeyMatcher>) {
        let mut answers: HashMap<String, String> = HashMap::new();
        let mut prompt = String::new();
        let mut out = Vec::new();
        for _ in 0..3 {
            seam_llm::host_bus::install(answers.clone());
            out = classify_receivers(repo, None, None);
            let recorded = seam_llm::host_bus::take_recorded();
            if recorded.is_empty() {
                break;
            }
            for r in recorded {
                if r.tag == "classify-receivers" {
                    prompt = r.prompt.clone();
                    answers.insert(r.key, answer.to_string());
                } else {
                    answers.insert(r.key, "[]".to_string());
                }
            }
        }
        seam_llm::host_bus::uninstall();
        (prompt, out)
    }

    #[test]
    fn classification_picks_the_matcher_shape_and_the_blindspot_gate_bounds_the_candidates() {
        // ── a database receiver and an http look-alike ───────────────────────────────────────────────────
        let fx = fixture("kinds");
        let repo = fx.0.to_string_lossy().to_string();
        for i in 0..5 {
            // ≥MIN_FILES, each using BOTH receivers with a read AND a write verb → both are candidates
            std::fs::write(
                fx.0.join("src").join(format!("f{i}.ts")),
                format!("export const a{i} = async () => {{ await userRepository.create({{}}); const u = await userRepository.findMany(); await axios.get('/x'); const c = axios.create(); return u; }};\n"),
            )
            .unwrap();
        }
        let (_, ms) = run_classify(&repo, r#"[{"id":"userRepository","type":"database"},{"id":"axios","type":"http"}]"#);

        let shapes = |tok: &str| -> Vec<String> {
            let mut v: Vec<String> = ms
                .iter()
                .filter(|m| token_of(m) == Some(tok))
                .map(|m| match m {
                    KeyMatcher::Repository { kind, .. } => format!("repository/{kind}"),
                    KeyMatcher::Channel { kind, .. } => format!("channel/{kind}"),
                    other => format!("other/{other:?}"),
                })
                .collect();
            v.sort();
            v.dedup();
            v
        };
        // database-confirmed → repository (the receiver IS the table), split read/write
        assert_eq!(shapes("userRepository"), vec!["repository/db-table"], "{ms:?}");
        let mut roles: Vec<&str> = ms
            .iter()
            .filter(|m| token_of(m) == Some("userRepository"))
            .map(|m| match m {
                KeyMatcher::Repository { role, .. } => role.as_str(),
                _ => "",
            })
            .collect();
        roles.sort();
        roles.dedup();
        assert_eq!(roles, vec!["consumes", "produces"]);
        // http-confirmed → an http-route CHANNEL (the ROUTE is the key), not mis-typed as a db-table
        assert_eq!(shapes("axios"), vec!["channel/http-route"]);
        drop(fx);

        // ── no backend → no classification (degrades to member_access only) ──────────────────────────────
        let fx = fixture("nobackend");
        let repo = fx.0.to_string_lossy().to_string();
        std::fs::write(fx.0.join("src").join("f.ts"), "export const a = () => userRepository.create({});\n").unwrap();
        seam_llm::host_bus::uninstall();
        assert!(classify_receivers(&repo, None, Some("/nonexistent/claude-xyz")).is_empty());
        drop(fx);

        // ── THE BLINDSPOT GATE: a receiver DECLARED in-repo is the grow's job, not a boundary ────────────
        // A domain object built by in-repo code is followed by the structural grow; classifying it mints a
        // channel matcher for something that is not a boundary at all. A never-declared global, or a binding
        // backed by a library import, IS the external layer and must survive.
        let fx = fixture("gate");
        let repo = fx.0.to_string_lossy().to_string();
        for i in 0..5 {
            std::fs::write(
                fx.0.join("src").join(format!("f{i}.ts")),
                format!(
                    "const savings = makeSavings();\nexport const a{i} = () => {{ savings.get('rate'); savings.set('rate', 1); localStorage.getItem('token'); localStorage.setItem('token', 1); }};\n"
                ),
            )
            .unwrap();
        }
        let (prompt, ms) = run_classify(&repo, r#"[{"id":"localStorage","type":"store"}]"#);
        assert!(prompt.contains("localStorage: getItem"), "a global store must survive the gate:\n{prompt}");
        assert!(!prompt.contains("\nsavings:"), "an in-repo-declared receiver must not reach the classifier:\n{prompt}");
        assert!(!ms.iter().any(|m| token_of(m) == Some("savings")));

        // a binding BACKED by a node_modules import is external and is kept
        for i in 0..5 {
            std::fs::write(
                fx.0.join("src").join(format!("g{i}.ts")),
                format!(
                    "import Redis from 'redis';\nconst cache = new Redis();\nconst savings = makeSavings();\nexport const b{i} = () => {{ cache.get('k'); cache.set('k', 1); savings.get('rate'); savings.set('rate', 1); }};\n"
                ),
            )
            .unwrap();
        }
        let (prompt, _) = run_classify(&repo, r#"[{"id":"cache","type":"store"}]"#);
        assert!(prompt.contains("\ncache:") || prompt.starts_with("cache:"), "a lib-backed binding survives:\n{prompt}");
        assert!(!prompt.contains("\nsavings:"), "an in-repo-backed binding does not:\n{prompt}");
        drop(fx);

        // ── the DI-INJECTED case: the same gate, read off a Java field's TYPE ────────────────────────────
        // `@Inject SavingsManager savingsManager` is typed by an IN-REPO class, so the grow can walk into it —
        // classifying it would mint a boundary in the middle of the codebase. `EntityManager` has no in-repo
        // class behind it, so it IS the edge of the repo and is the one real boundary here.
        let fx = fixture("dijava");
        let repo = fx.0.to_string_lossy().to_string();
        std::fs::create_dir_all(fx.0.join("be")).unwrap();
        std::fs::write(fx.0.join("be").join("SavingsManager.java"), "public class SavingsManager { }\n").unwrap();
        for i in 0..5 {
            std::fs::write(
                fx.0.join("be").join(format!("Svc{i}.java")),
                format!(
                    "public class Svc{i} {{\n  @Inject SavingsManager savingsManager;\n  @Inject EntityManager entityManager;\n  void run{i}() {{ savingsManager.get(\"rate\"); savingsManager.set(\"rate\", 1); entityManager.persist(x); entityManager.find(x); }}\n}}\n"
                ),
            )
            .unwrap();
        }
        let (prompt, _) = run_classify(&repo, "[]");
        assert!(!prompt.contains("\nsavingsManager:"), "an in-repo-typed injection is the grow's job:\n{prompt}");
        assert!(prompt.contains("\nentityManager:") || prompt.starts_with("entityManager:"), "the ORM is the surviving boundary:\n{prompt}");
    }

    #[test]
    fn a_custom_route_annotation_becomes_a_matcher_and_noise_is_dropped() {
        // The builtin annotation set cannot know a project's own `@GlobexRoute`. The model names it a route;
        // the result is a matcher that EXTRACTS the path literal, so the handler grounds against a front-end
        // fetch of the same path. `@Audit` is noise and must not become a matcher at all — a matcher per
        // annotation would key the repo on its logging conventions.
        let fx = fixture("annots");
        let repo = fx.0.to_string_lossy().to_string();
        std::fs::create_dir_all(fx.0.join("be")).unwrap();
        for i in 0..5 {
            std::fs::write(
                fx.0.join("be").join(format!("R{i}.java")),
                format!("@GlobexRoute(\"/api/bookings/{i}\")\n@Audit(\"booking\")\npublic void h{i}() {{}}\n"),
            )
            .unwrap();
        }
        let mut answers: HashMap<String, String> = HashMap::new();
        let mut ms = Vec::new();
        for _ in 0..3 {
            seam_llm::host_bus::install(answers.clone());
            ms = classify_annotations(&repo, None, None);
            let recorded = seam_llm::host_bus::take_recorded();
            if recorded.is_empty() {
                break;
            }
            for r in recorded {
                let a = if r.tag == "classify-annotations" { r#"[{"id":"GlobexRoute","type":"route"},{"id":"Audit","type":"none"}]"# } else { "[]" };
                answers.insert(r.key, a.to_string());
            }
        }
        seam_llm::host_bus::uninstall();

        let annot_of = |m: &KeyMatcher| match m {
            KeyMatcher::Annotation { annotation, kind, .. } => Some((annotation.clone(), kind.clone())),
            _ => None,
        };
        let route = ms.iter().filter_map(annot_of).find(|(a, _)| a == "GlobexRoute").expect("a GlobexRoute matcher");
        assert_eq!(route.1, "http-route");
        assert!(!ms.iter().filter_map(annot_of).any(|(a, _)| a == "Audit"), "noise must not become a matcher");

        // …and it EXTRACTS the literal, which is the only reason the matcher is worth minting.
        let m = ms.iter().find(|m| matches!(m, KeyMatcher::Annotation { annotation, .. } if annotation == "GlobexRoute")).unwrap();
        let hits = crate::learn::run_matcher_at(m, "R.java", "@GlobexRoute(\"/api/bookings/7\")\npublic void h() {}");
        assert!(hits.iter().any(|h| h.kind == "http-route" && h.value == "/api/bookings/7" && h.produces), "{hits:?}");
    }
}
