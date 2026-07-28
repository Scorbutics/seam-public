//! STEP 1e — CLASS-BASE-ROUTE inheritance (the consumer-side mirror of the sub-resource composer). An SDK
//! client-resource class declares its route BASE PATH once (`super(client, { path: "/admin/realms/{realm}/users" })`)
//! and each request method inherits it: `create = this.makeRequest({ method: "POST" })` calls POST on the base.
//! Keys are attributed span-locally, so when the footprint reaches the `create` METHOD its span carries no route
//! literal (the base is in the constructor) — this resolves each method's FULL route AT ITS OWN LINE so the
//! method node owns the crossing. General over the SDK-resource idiom, not one framework. Port of
//! resolveResourceRoutes (resource_routes.ts). Operates on RAW text.

use super::super::adapters::http_route::norm_path;
use crate::key_ir::line_of;
use crate::types::KeyHit;
use once_cell::sync::Lazy;
use regex::Regex;

static JS_EXT: Lazy<Regex> = Lazy::new(|| Regex::new(r"\.(?:[mc]?[jt]sx?)$").unwrap());
static GATE: Lazy<Regex> = Lazy::new(|| Regex::new(r"make\w*[Rr]equest").unwrap());
static BASE_SUPER: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\bsuper\s*\(\s*[\s\S]{0,400}?\bpath\s*:\s*["'`](/[^"'`]+)["'`]"#).unwrap());
static BASE_FIELD: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\b(?:base(?:Url|Path)|path)\s*[:=]\s*["'`](/[A-Za-z][^"'`]*)["'`]"#).unwrap());
static REQ_MEMBER: Lazy<Regex> = Lazy::new(|| Regex::new(r"(\w+)\s*=\s*(?:this\.)?make\w*[Rr]equest\b").unwrap());
static OWN_PATH: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\bpath\s*:\s*["'`]([^"'`]+)["'`]"#).unwrap());
static NEXT_MEMBER: Lazy<Regex> = Lazy::new(|| Regex::new(r"\n\s*(?:public |private |protected |readonly )*\w+\s*=\s*(?:this\.)?make\w*[Rr]equest\b").unwrap());

fn join(base: &str, sub: &str) -> String {
    norm_path(&format!("{}/{}", base.trim_end_matches('/'), sub.trim_start_matches('/')))
}

/// The request builder's own `method:` — the HTTP verb this member calls the base path with. Part of the
/// KEY's identity, not decoration: a GET consumer and a POST consumer of the same path are different
/// crossings, and dropping the verb lets one pair with the other's backend handler.
static OWN_METHOD: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)\bmethod\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["'`]"#).unwrap());

/// Resolve each request method's full route (base ⊕ its own path), stamped at the METHOD's line. `[]` for a
/// file that isn't an SDK resource. Port of `resolveResourceRoutes`.
pub fn resolve_resource_routes(file: &str, text: &str) -> Vec<KeyHit> {
    if !JS_EXT.is_match(file) || !GATE.is_match(text) {
        return Vec::new();
    }
    let Some(base) = BASE_SUPER.captures(text).or_else(|| BASE_FIELD.captures(text)).map(|c| c[1].to_string()) else { return Vec::new() };
    let mut out = Vec::new();
    for m in REQ_MEMBER.captures_iter(text) {
        let whole = m.get(0).unwrap();
        let after = &text[whole.end()..];
        // bound the config window to THIS builder call (up to the next request member).
        let next_idx = NEXT_MEMBER.find(after).map(|mm| mm.start()).unwrap_or_else(|| after.len().min(600));
        let mut end = next_idx.min(after.len());
        while !after.is_char_boundary(end) {
            end -= 1;
        }
        let window = &after[..end];
        let own = OWN_PATH.captures(window).map(|c| c[1].to_string());
        let value = match own {
            Some(o) => join(&base, &o),
            None => norm_path(&base),
        };
        if value == "/" {
            continue;
        }
        let method = OWN_METHOD.captures(window).map(|c| c[1].to_uppercase());
        out.push(KeyHit { kind: "http-route".into(), value, line: line_of(text, whole.start()), produces: false, method, ..Default::default() });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // CLASS-BASE-ROUTE inheritance — the consumer-side mirror of the sub-resource composer. An SDK resource
    // class declares its route base once (constructor `super({path})`) and each request method inherits it.
    // Coupling keys are attributed SPAN-LOCALLY, so without this the method node carries no route and its
    // cross-stack crossing never materialises. Ported from `resource_routes.test.ts`.
    const USERS: &str = r#"export class Users extends Resource<{ realm?: string }> {
  public find = this.makeRequest<UserQuery, UserRepresentation[]>({
    method: "GET",
  });

  public create = this.makeRequest<UserRepresentation, { id: string }>({
    method: "POST",
  });

  public findOne = this.makeRequest<{ id: string }, UserRepresentation>({
    method: "GET",
    path: "/{id}",
  });

  constructor(client: KeycloakAdminClient) {
    super(client, {
      path: "/admin/realms/{realm}/users",
      getUrlParams: () => ({ realm: client.realmName }),
    });
  }
}
"#;

    #[test]
    fn a_bare_request_method_inherits_the_class_base_path_at_its_own_line() {
        let hits = resolve_resource_routes("resources/users.ts", USERS);
        let create = hits
            .iter()
            .find(|h| h.value == "/admin/realms/*/users" && h.method.as_deref() == Some("POST"))
            .expect("the inherited route");
        // Stamped at the `create` member line (index 5), NOT the constructor's `path:` line — so the
        // footprint's `create` node owns the crossing to the backend handler within its own span.
        assert_eq!(create.line, 5);
        assert!(!create.produces, "an SDK method is a route CONSUMER — it calls the backend");
    }

    #[test]
    fn a_method_with_its_own_path_composes_base_then_own() {
        let hits = resolve_resource_routes("resources/users.ts", USERS);
        assert!(hits.iter().any(|h| h.value == "/admin/realms/*/users/*" && h.method.as_deref() == Some("GET")));
    }

    #[test]
    fn a_file_with_no_base_path_resource_class_yields_nothing() {
        assert!(resolve_resource_routes("util.ts", "export const x = () => fetch('/api/thing');\n").is_empty());
        // no `super({path})` / base field → not a resource class, even though it makes an HTTP call
        assert!(resolve_resource_routes("r.ts", "class R { m = this.makeRequest({ method: 'GET' }); }").is_empty());
    }

    #[test]
    fn only_ts_and_js_files_are_scanned() {
        assert!(resolve_resource_routes("resources/users.py", USERS).is_empty());
    }
}
