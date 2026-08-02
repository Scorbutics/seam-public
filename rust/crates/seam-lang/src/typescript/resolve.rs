//! TS/JS module resolution — port of languages/typescript/resolve.ts, redesigned. TS kept module-global
//! `_PKG_CACHE`/`_TS_ALIAS_CACHE`; here a `TypeScriptResolver` owns them as per-repo state. Split into cohesive
//! steps: relative resolution with extension probing, workspace-package resolution, and tsconfig `paths`
//! aliases. JSONC parsing lives in the sibling `jsonc` module.

use super::jsonc;
use crate::provider::ModuleResolver;
use once_cell::sync::Lazy;
use regex::Regex;
use seam_fs::{dirname, is_file, join, normalize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

const RESOLVE_EXTS: &[&str] = &[".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts"];
const JS_EXTS: &[&str] = &[".js", ".jsx", ".mjs", ".cjs"];

static STRIP_ENTRY_EXT: Lazy<Regex> = Lazy::new(|| Regex::new(r"\.(d\.ts|tsx?|jsx?|mjs|cjs)$").unwrap());
static BUILD_TO_SRC: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(lib|dist|build|out|esm?|cjs)/").unwrap());

type AliasRule = (String, Vec<String>, String); // (pattern, replacements, base dir)

pub struct TypeScriptResolver {
    repo: String,
    /// (package name → repo-relative dir), sorted by name length DESC (longest match wins).
    pkg_map: Vec<(String, String)>,
    /// per (importing-file dir) tsconfig alias rules, memoized.
    alias_cache: Mutex<HashMap<String, Vec<AliasRule>>>,
}

impl TypeScriptResolver {
    pub fn build(repo: &str) -> Self {
        Self { repo: repo.to_string(), pkg_map: build_pkg_map(repo), alias_cache: Mutex::new(HashMap::new()) }
    }
}

impl ModuleResolver for TypeScriptResolver {
    fn resolve(&self, importing_file: &str, source: &str) -> Option<String> {
        // relative import
        if source.starts_with('.') {
            return resolve_file(&self.repo, &join(&dirname(importing_file), source));
        }
        // workspace package (longest name wins — pkg_map is pre-sorted DESC)
        for (name, dir) in &self.pkg_map {
            if source == name || source.starts_with(&format!("{name}/")) {
                let sub = source[name.len()..].trim_start_matches('/');
                return if sub.is_empty() {
                    pkg_entry(&self.repo, dir)
                } else {
                    // THE SOURCE<->BUILD MIRROR, applied to a SUBPATH — `pkg_entry` has always done this for
                    // the package ENTRY, and the subpath branch did not. A monorepo package declares itself in
                    // terms of its BUILD output, but only its SOURCE is checked out, so the literal path misses.
                    //
                    // MEASURED (bench/grep-vs-seam, keycloak, 2026-08-02). 268 admin-ui files import
                    // `@keycloak/keycloak-admin-client/lib/defs/…`; `js/libs/keycloak-admin-client/lib/` does
                    // not exist in the checkout, the source is `src/defs/….ts`. So every one of those imports
                    // failed to resolve and the package — which is IN THIS REPO — was reported as
                    //   `external-libraries — save uses 7 external/stdlib dependencies:
                    //      @keycloak/keycloak-admin-client/lib/defs/userProfileMetadata, react, …`
                    // i.e. filed next to `react`. That is worse than an unresolved edge: an unresolved import
                    // is a BLINDSPOT the reader is told to verify, while "external library" is a confident
                    // wrong answer that ends the enquiry. It is why the TS admin-UI layer never entered a grow
                    // from the admin client, and `js/apps/admin-ui/src/**` is the ground-truth entry BOTH arms
                    // miss in every run.
                    //
                    // SELF-VALIDATING, so it cannot invent an edge: each candidate is accepted only if
                    // `resolve_file` finds a real file. A package that genuinely ships `lib/` in-tree still
                    // resolves on the FIRST candidate and never reaches the rewrite.
                    resolve_file(&self.repo, &join(dir, sub))
                        .or_else(|| {
                            let remapped = BUILD_TO_SRC.replace(sub, "src/");
                            (remapped != sub).then(|| resolve_file(&self.repo, &join(dir, &remapped)))?
                        })
                        // …and the mirror image: a package whose subpaths are published bare (`pkg/foo`) while
                        // the tree keeps them under `src/`. Same FS check, same no-invention guarantee.
                        .or_else(|| resolve_file(&self.repo, &join(dir, &format!("src/{sub}"))))
                };
            }
        }
        // tsconfig paths alias
        self.resolve_alias(importing_file, source)
    }
}

// {package name → repo-relative dir} from every package.json (plain JSON; lexicographically-smallest dir on a
// duplicate name, first-seen key order), then pre-sorted by name length DESC.
fn build_pkg_map(repo: &str) -> Vec<(String, String)> {
    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, String> = HashMap::new();
    for pj in seam_fs::source_files(repo, |r| r == "package.json" || r.ends_with("/package.json")) {
        let Ok(text) = std::fs::read_to_string(format!("{repo}/{pj}")) else {
            continue;
        };
        let Ok(data) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(name) = data.get("name").and_then(Value::as_str) else {
            continue;
        };
        let d = dirname(&pj);
        let dir = if d == "." { String::new() } else { d }; // relpath(dir, repo): "" at the repo root
        match map.get(name) {
            None => {
                order.push(name.to_string());
                map.insert(name.to_string(), dir);
            }
            Some(prev) if dir < *prev => {
                map.insert(name.to_string(), dir);
            }
            _ => {}
        }
    }
    let mut out: Vec<(String, String)> = order.into_iter().map(|n| (n.clone(), map[&n].clone())).collect();
    out.sort_by(|a, b| b.0.len().cmp(&a.0.len())); // stable → ties keep first-seen order (matches JS stable sort)
    out
}

// Relative/base file resolution with extension probing: <base>.<ext>, then <base>, then the `.js`→`.ts`
// NodeNext convention, then <base>/index.<ext>. Returns a repo-relative path.
fn resolve_file(repo: &str, base_rel: &str) -> Option<String> {
    let cand = normalize(base_rel);
    for ext in RESOLVE_EXTS {
        let f = format!("{cand}{ext}");
        if is_file(repo, &f) {
            return Some(f);
        }
    }
    if is_file(repo, &cand) {
        return Some(cand);
    }
    // ESM `.js`-style import of a TS source (`./x.js` → x.ts) — only fires when the literal file is absent.
    if let Some(jsext) = JS_EXTS.iter().find(|e| cand.ends_with(**e)) {
        let stem = &cand[..cand.len() - jsext.len()];
        for ext in RESOLVE_EXTS {
            let f = format!("{stem}{ext}");
            if is_file(repo, &f) {
                return Some(f);
            }
        }
    }
    for ext in RESOLVE_EXTS {
        let idx = join(&cand, &format!("index{ext}"));
        if is_file(repo, &idx) {
            return Some(idx);
        }
    }
    None
}

// A workspace package ROOT import → its entry. Reads types/typings/exports/module/main, strips the extension,
// and remaps a build dir (lib/dist/build/out/es[m]/cjs) → src (the source↔build mirror), then falls back to
// src/index or index.
fn pkg_entry(repo: &str, pkg_dir: &str) -> Option<String> {
    let pj = jsonc::load(&format!("{}/{}", repo, join(pkg_dir, "package.json"))).unwrap_or(Value::Null);
    let exp = pj.get("exports");
    let exp = match exp {
        Some(e) if e.is_object() => e.get(".").or(Some(e)),
        other => other,
    };
    let exp_entry: Option<&str> = match exp {
        Some(Value::String(s)) => Some(s.as_str()),
        Some(o) if o.is_object() => ["types", "import", "default", "require"]
            .iter()
            .find_map(|k| o.get(*k).and_then(Value::as_str)),
        _ => None,
    };
    for e in ordered_entries(&pj, exp_entry) {
        let base = STRIP_ENTRY_EXT.replace(e.strip_prefix("./").unwrap_or(&e), "").to_string();
        let remapped = BUILD_TO_SRC.replace(&base, "src/").to_string();
        for cand in [base.as_str(), remapped.as_str()] {
            if let Some(hit) = resolve_file(repo, &join(pkg_dir, cand)) {
                return hit.into();
            }
        }
    }
    // `src/main` LAST, after both index conventions. A bundler-built package names its real source entry in
    // its BUILD CONFIG, not in package.json — Vite's `build.lib.entry` is `src/main.ts` by convention — so a
    // package whose declared entry is a `dist/` artefact with no `index` beside the source resolves to nothing.
    //
    // MEASURED (keycloak, 2026-08-02): `@keycloak/keycloak-ui-shared` declares `main`/`exports` as
    // `./dist/keycloak-ui-shared.js`; there is no `dist/` in the checkout, no `src/keycloak-ui-shared.ts` for
    // the source mirror to land on, and no `src/index.ts`. Its `vite.config.ts` says
    // `lib: { entry: path.resolve(__dirname, "src/main.ts") }`, and `src/main.ts:94` is
    // `export { useFetch } from "./utils/useFetch"` — i.e. the barrel to a ground-truth entry of the
    // cross-language benchmark case. 358 admin-ui files import this package.
    //
    // The config is NOT parsed: reading a JS build config would mean evaluating it. This is the convention it
    // encodes, tried last and only when everything declared has already missed, and — like every branch here —
    // accepted only if `resolve_file` finds the file on disk.
    resolve_file(repo, &join(pkg_dir, "src/index"))
        .or_else(|| resolve_file(repo, &join(pkg_dir, "index")))
        .or_else(|| resolve_file(repo, &join(pkg_dir, "src/main")))
}

// [types, typings, exp_entry, module, main], string values only — the exact TS order.
fn ordered_entries(pj: &Value, exp_entry: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    let field = |k: &str| pj.get(k).and_then(Value::as_str).map(String::from);
    if let Some(v) = field("types") {
        out.push(v);
    }
    if let Some(v) = field("typings") {
        out.push(v);
    }
    if let Some(v) = exp_entry {
        out.push(v.to_string());
    }
    if let Some(v) = field("module") {
        out.push(v);
    }
    if let Some(v) = field("main") {
        out.push(v);
    }
    out
}

impl TypeScriptResolver {
    fn resolve_alias(&self, importing_file: &str, source: &str) -> Option<String> {
        for (pat, repls, base) in self.tsconfig_aliases(importing_file) {
            if let Some(star) = pat.find('*') {
                let (pre, suf) = (&pat[..star], &pat[star + 1..]);
                if source.starts_with(pre) && source.ends_with(suf) {
                    let cap = &source[pre.len()..source.len() - suf.len()];
                    for r in &repls {
                        let (rpre, rsuf) = match r.find('*') {
                            Some(rs) => (&r[..rs], &r[rs + 1..]),
                            None => (r.as_str(), ""),
                        };
                        if let Some(hit) = resolve_file(&self.repo, &join(&base, &format!("{rpre}{cap}{rsuf}"))) {
                            return Some(hit);
                        }
                    }
                }
            } else if source == pat {
                for r in &repls {
                    if let Some(hit) = resolve_file(&self.repo, &join(&base, r)) {
                        return Some(hit);
                    }
                }
            }
        }
        None
    }

    fn tsconfig_aliases(&self, importing_file: &str) -> Vec<AliasRule> {
        let key = format!("{} {}", self.repo, dirname(importing_file));
        if let Some(c) = self.alias_cache.lock().unwrap().get(&key) {
            return c.clone();
        }
        let mut rules = Vec::new();
        let mut d = dirname(importing_file);
        loop {
            if let Some(got) = self.aliases_in_dir(&d) {
                rules = got;
                break;
            }
            if d.is_empty() || d == "." {
                break;
            }
            let nd = dirname(&d);
            d = if nd == d { String::new() } else { nd };
        }
        self.alias_cache.lock().unwrap().insert(key, rules.clone());
        rules
    }

    fn aliases_in_dir(&self, dir_rel: &str) -> Option<Vec<AliasRule>> {
        for cfg in ["tsconfig.json", "jsconfig.json"] {
            let Some(data) = jsonc::load(&format!("{}/{}", self.repo, join(dir_rel, cfg))) else {
                continue;
            };
            let co = data.get("compilerOptions").cloned().unwrap_or(Value::Null);
            let mut paths = co.get("paths").cloned().unwrap_or(Value::Null);
            let mut base = co.get("baseUrl").and_then(Value::as_str).unwrap_or(".").to_string();
            let paths_empty = paths.as_object().map(|o| o.is_empty()).unwrap_or(true);
            if paths_empty {
                if let Some(ext_rel) = data.get("extends").and_then(Value::as_str) {
                    if let Some(ext) = jsonc::load(&format!("{}/{}", self.repo, join(dir_rel, ext_rel))) {
                        let eco = ext.get("compilerOptions").cloned().unwrap_or(Value::Null);
                        paths = eco.get("paths").cloned().unwrap_or(Value::Null);
                        base = co
                            .get("baseUrl")
                            .and_then(Value::as_str)
                            .or_else(|| eco.get("baseUrl").and_then(Value::as_str))
                            .unwrap_or(".")
                            .to_string();
                    }
                }
            }
            let base_dir = join(dir_rel, &base);
            let mut rules = Vec::new();
            if let Some(obj) = paths.as_object() {
                for (pat, repls) in obj {
                    if let Some(arr) = repls.as_array() {
                        let v: Vec<String> = arr.iter().filter_map(|x| x.as_str().map(String::from)).collect();
                        rules.push((pat.clone(), v, base_dir.clone()));
                    }
                }
            }
            if !rules.is_empty() {
                return Some(rules);
            }
        }
        None
    }
}

#[cfg(test)]
mod build_output_subpath_tests {
    use super::*;

    /// A monorepo package that declares itself in terms of its BUILD output while only its SOURCE is checked
    /// out — the shape of `js/libs/keycloak-admin-client` in keycloak, and of most TS monorepos before a build.
    pub fn fixture(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("seam-pkgsub-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let w = |rel: &str, text: &str| {
            let p = d.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        };
        w("package.json", r#"{"name":"root","version":"1.0.0"}"#);
        // the in-repo package: `main` points at lib/, which does NOT exist on disk
        w("libs/admin-client/package.json",
          r#"{"name":"@scope/admin-client","version":"1.0.0","main":"lib/index.js","types":"lib/index.d.ts"}"#);
        w("libs/admin-client/src/index.ts", "export * from './resources/realms';\n");
        w("libs/admin-client/src/resources/realms.ts", "export class Realms { update() {} }\n");
        w("libs/admin-client/src/defs/realmRep.ts", "export default interface RealmRep { id: string }\n");
        // a package that really DOES ship lib/ in-tree — the first candidate must still win
        w("libs/shipped/package.json", r#"{"name":"@scope/shipped","version":"1.0.0"}"#);
        w("libs/shipped/lib/thing.ts", "export const fromLib = 1;\n");
        w("libs/shipped/src/thing.ts", "export const fromSrc = 2;\n");
        w("apps/ui/src/Page.tsx", "import RealmRep from '@scope/admin-client/lib/defs/realmRep';\n");
        // a BUNDLER-BUILT package: entry declared as a dist/ artefact, real source entry at src/main.ts, and
        // NO src/index — the shape of `js/libs/ui-shared` in keycloak.
        w("libs/ui-shared/package.json",
          r#"{"name":"@scope/ui-shared","version":"1.0.0","main":"./dist/ui-shared.js","exports":{".":{"import":"./dist/ui-shared.js"}}}"#);
        w("libs/ui-shared/src/main.ts", "export { useFetch } from './utils/useFetch';\n");
        w("libs/ui-shared/src/utils/useFetch.ts", "export function useFetch() {}\n");
        // …and one that has BOTH, to pin the precedence
        w("libs/both/package.json", r#"{"name":"@scope/both","version":"1.0.0","main":"./dist/b.js"}"#);
        w("libs/both/src/index.ts", "export const viaIndex = 1;\n");
        w("libs/both/src/main.ts", "export const viaMain = 2;\n");
        d
    }

    #[test]
    fn a_build_output_subpath_resolves_to_the_source_file() {
        let d = fixture("a_build_outp");
        let r = TypeScriptResolver::build(d.to_str().unwrap());
        // THE BUG: this returned None, so the importing file's dependency was reported as an EXTERNAL LIBRARY
        // — a confident wrong answer — rather than an edge into a package sitting in the same repo.
        assert_eq!(
            r.resolve("apps/ui/src/Page.tsx", "@scope/admin-client/lib/defs/realmRep").as_deref(),
            Some("libs/admin-client/src/defs/realmRep.ts"),
            "a `lib/` subpath of an in-repo package must fall back to `src/`",
        );
        assert_eq!(
            r.resolve("apps/ui/src/Page.tsx", "@scope/admin-client/lib/resources/realms").as_deref(),
            Some("libs/admin-client/src/resources/realms.ts"),
        );
    }

    #[test]
    fn a_bare_subpath_also_finds_src() {
        // The mirror image: published bare (`pkg/foo`), kept under `src/` in-tree.
        let d = fixture("a_bare_subpa");
        let r = TypeScriptResolver::build(d.to_str().unwrap());
        assert_eq!(
            r.resolve("apps/ui/src/Page.tsx", "@scope/admin-client/resources/realms").as_deref(),
            Some("libs/admin-client/src/resources/realms.ts"),
        );
    }

    #[test]
    fn a_package_that_really_ships_lib_is_not_redirected() {
        // THE OVER-CORRECTION GUARD, and the reason the fallback is ordered and FS-checked rather than a
        // rewrite: when `lib/` exists in-tree it is the truth, and `src/` must not shadow it. Without this the
        // fix would silently relocate every symbol in such a package — the failure mode that makes a stale
        // address book worse than no address book.
        let d = fixture("a_package_th");
        let r = TypeScriptResolver::build(d.to_str().unwrap());
        assert_eq!(
            r.resolve("apps/ui/src/Page.tsx", "@scope/shipped/lib/thing").as_deref(),
            Some("libs/shipped/lib/thing.ts"),
            "an in-tree lib/ must win over src/",
        );
    }

    #[test]
    fn a_genuinely_external_package_still_does_not_resolve() {
        // The other half of not inventing edges: `react` is not in the repo and must stay unresolved.
        let d = fixture("a_genuinely_");
        let r = TypeScriptResolver::build(d.to_str().unwrap());
        assert_eq!(r.resolve("apps/ui/src/Page.tsx", "react"), None);
        assert_eq!(r.resolve("apps/ui/src/Page.tsx", "@scope/admin-client/lib/defs/nope"), None);
    }
}

#[cfg(test)]
mod bundler_entry_tests {
    use super::build_output_subpath_tests::fixture;
    use super::*;

    #[test]
    fn a_bundler_built_package_resolves_to_its_src_main() {
        // Declared entry is `dist/ui-shared.js`, absent from the checkout; the source mirror lands on
        // `src/ui-shared`, also absent; there is no `src/index`. Before this, the package was reported as an
        // external library — see the subpath commit for why that is worse than an unresolved edge.
        let d = fixture("bundler");
        let r = TypeScriptResolver::build(d.to_str().unwrap());
        assert_eq!(r.resolve("apps/ui/src/Page.tsx", "@scope/ui-shared").as_deref(),
                   Some("libs/ui-shared/src/main.ts"));
    }

    #[test]
    fn src_index_still_beats_src_main() {
        // PRECEDENCE GUARD. `src/main` is a last-resort convention, never a preference: a package with a real
        // barrel must keep resolving to it, or this "fix" silently re-points every such package.
        let d = fixture("bothentry");
        let r = TypeScriptResolver::build(d.to_str().unwrap());
        assert_eq!(r.resolve("apps/ui/src/Page.tsx", "@scope/both").as_deref(),
                   Some("libs/both/src/index.ts"));
    }
}
