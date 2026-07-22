//! Language layer — per-language import / def / call scanners. Ports src/languages/* and the parts of
//! core/resolve/languages the resolution ladder needs. Java first (the K7 benchmark).

use napi_derive::napi;

pub mod java;

/// Port of `ImportRef` (core/resolve/languages/base.ts): one import binding — the original `name`, its
/// `local` alias, 0-based `line`/`col`, and the module `source`. (`reexport`, the TS/JS barrel-hop flag, is
/// added when the TS provider lands; Java never sets it, so the Java path is byte-identical without it.)
#[napi(object)]
#[derive(Clone, Debug, PartialEq)]
pub struct ImportRef {
    pub name: String,
    pub local: String,
    pub line: u32,
    pub col: u32,
    pub source: Option<String>,
}
