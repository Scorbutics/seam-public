//! FRAMEWORK-AGNOSTIC data-layer adapter: a `<recv>.<member>.<verb>()` chain where <verb> is a DISTINCTIVE
//! ORM/repository access. The MEMBER is the entity/table (db-table key); the verb gives the role. ANY receiver
//! matches (framework-agnostic) — the discriminator is the verb VOCABULARY (verb_class). Port of member_access.ts.

use crate::adapters::db_table::db_table_meta;
use crate::key_ir::line_of;
use crate::mask::MaskCtx;
use crate::regex_util::captures_not_word_before;
use crate::types::{CouplingAdapter, KeyHit, KindMeta};
use crate::verb_class::{data_role, write_op};
use once_cell::sync::Lazy;
use regex::Regex;

static META: Lazy<KindMeta> = Lazy::new(|| db_table_meta("member-access", "ORM/repository entity reads/writes via <recv>.<entity>.<verb>() — DB-table coupling, framework-agnostic"));
// body of `(?<![\w$])<recv>.<member>.<verb>[(<]`
static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*[(<]").unwrap());
const SELF: &[&str] = &["this", "self", "super"];

pub struct MemberAccess;

impl CouplingAdapter for MemberAccess {
    fn meta(&self) -> &KindMeta {
        &META
    }

    fn scan(&self, _file: &str, _text: &str, mask: &MaskCtx) -> Vec<KeyHit> {
        let code = mask.comments();
        let mut out = Vec::new();
        for m in captures_not_word_before(&RE, code) {
            if SELF.contains(&&m[1]) {
                continue;
            }
            let Some(role) = data_role(&m[3]) else { continue };
            let op = if role == "write" { write_op(&m[3]) } else { None };
            out.push(KeyHit {
                kind: "db-table".into(),
                value: m[2].to_string(),
                line: line_of(code, m.get(0).unwrap().start()),
                produces: role == "write",
                recv: Some(m[1].to_string()),
                op: op.map(String::from),
                ..Default::default()
            });
        }
        out
    }
}
