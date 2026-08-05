//! TYPED-FIELD receiver resolution — `adminClient.realms.update(…)` reaching `Realms#update`.
//!
//! A call whose receiver is a MEMBER of another object binds nothing locally, so the type pass and the factory
//! hop both decline and the site is dropped. The type is written down one hop away, on the field:
//! `class KeycloakAdminClient { public realms: Realms; }`.
//!
//! The tests that matter are the NEGATIVE ones: the lookup is BY NAME and repo-wide, a far weaker premise than
//! the factory hop's "reached from the receiver's own binding". If ambiguity does not decline, this invents edges.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Repo(PathBuf);
impl Repo { fn path(&self) -> &Path { &self.0 } }
impl Drop for Repo { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

fn repo(files: &[(&str, &str)]) -> Repo {
    static N: AtomicUsize = AtomicUsize::new(0);
    let d = std::env::temp_dir().join(format!("seam-tf-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    fs::write(d.join("package.json"), r#"{ "name": "tf", "version": "1.0.0" }"#).unwrap();
    for (rel, text) in files {
        let p = d.join(rel);
        fs::create_dir_all(Path::new(&p).parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }
    Repo(d)
}

const CLIENT: &str = "import { Realms } from \"./realms.js\";\nexport class KeycloakAdminClient {\n  public realms: Realms;\n}\n";
const REALMS: &str = "export class Realms {\n  public update(payload: any) { return payload; }\n}\n";

#[test]
fn a_member_receiver_resolves_through_its_declared_field_type() {
    let d = repo(&[("src/client.ts", CLIENT), ("src/realms.ts", REALMS)]);
    seam_resolve::CallsiteIndex::reset(None);
    let idx = seam_resolve::CallsiteIndex::cached(d.path().to_str().unwrap());
    assert_eq!(idx.field_type("realms").map(|(t, _)| t), Some("Realms"),
        "the bare `public realms: Realms;` was not indexed — ast::typed_fields did not see it");
}

/// AMBIGUITY DECLINES. Two declared types for one field name is not a dispatch target.
#[test]
fn a_field_name_with_two_different_types_resolves_to_nothing() {
    let d = repo(&[("src/client.ts", CLIENT), ("src/realms.ts", REALMS),
        ("src/other.ts", "export class Other {\n  public realms: SomethingElse;\n}\n")]);
    seam_resolve::CallsiteIndex::reset(None);
    let idx = seam_resolve::CallsiteIndex::cached(d.path().to_str().unwrap());
    assert_eq!(idx.field_type("realms"), None,
        "an ambiguous name must decline — resolving it invents an edge to an arbitrary class");
}

/// The SAME type twice (a test double, a re-export) is not ambiguity — it still names one target.
#[test]
fn the_same_type_declared_twice_is_not_ambiguous() {
    let d = repo(&[("src/client.ts", CLIENT), ("src/realms.ts", REALMS),
        ("src/double.ts", "export class Double {\n  public realms: Realms;\n}\n")]);
    seam_resolve::CallsiteIndex::reset(None);
    let idx = seam_resolve::CallsiteIndex::cached(d.path().to_str().unwrap());
    assert_eq!(idx.field_type("realms").map(|(t, _)| t), Some("Realms"));
}

/// A UNION or GENERIC is not a lone type reference. Collecting references and requiring exactly one would
/// accept `Realms | null` — the `null` is not a type reference — and that is a receiver which may not be there.
#[test]
fn a_union_or_generic_annotation_is_not_indexed() {
    let d = repo(&[("src/a.ts", "export class A {\n  public maybe: Realms | null;\n  public many: Map<string, Realms>;\n}\n"),
        ("src/realms.ts", REALMS)]);
    seam_resolve::CallsiteIndex::reset(None);
    let idx = seam_resolve::CallsiteIndex::cached(d.path().to_str().unwrap());
    assert_eq!(idx.field_type("maybe"), None, "`Realms | null` is not a single dispatch target");
    assert_eq!(idx.field_type("many"), None, "`Map<string, Realms>` is a container, not the target");
}

/// A FUNCTION-VALUED property is a callable member, not a typed handle — def_table's property branch owns it.
#[test]
fn a_function_valued_property_is_left_to_the_property_branch() {
    let d = repo(&[("src/r.ts", "export class R {\n  public update = (x: any) => x;\n}\n")]);
    seam_resolve::CallsiteIndex::reset(None);
    let idx = seam_resolve::CallsiteIndex::cached(d.path().to_str().unwrap());
    assert_eq!(idx.field_type("update"), None);
}

/// THE GATE. `SEAM_MEMBER_FIELDS` decides whether a `this`-delegating property counts as a class member; it is
/// off by default because `class_methods` seeds the grow's up-climb as well as the consumer query. Asserted
/// BOTH ways against the flag so the default cannot drift silently.
#[test]
fn this_delegating_members_are_gated() {
    let text = "import Resource from \"./resource.js\";\nexport class Realms extends Resource {\n  public del = this.makeRequest<{ realm: string }, void>({ method: \"DELETE\" });\n}\n";
    let ctx = seam_lang::Ctx::parse(text, "typescript").expect("parse");
    let saw = seam_lang::ast::class_methods(&ctx, "Realms").iter().any(|m| m.0 == "del");
    assert_eq!(saw, seam_lang::ast::member_fields_on(),
        "`public del = this.makeRequest(…)` must count as a member IFF SEAM_MEMBER_FIELDS is on");
}
