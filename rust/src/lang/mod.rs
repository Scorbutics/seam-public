//! Language layer — per-language import / def / call scanners. Ports src/languages/* and the parts of
//! core/resolve/languages the resolution ladder needs. Java first (the K7 benchmark).

use napi_derive::napi;

pub mod java;
pub mod typescript;

/// Port of `ImportRef` (core/resolve/languages/base.ts): one import binding — the original `name`, its
/// `local` alias, 0-based `line`/`col`, the module `source`, and `reexport` (`export { X } from …` — a
/// barrel hop, not a use; TS/JS only; `None` elsewhere, matching TS where the field is simply absent).
#[napi(object)]
#[derive(Clone, Debug, PartialEq)]
pub struct ImportRef {
    pub name: String,
    pub local: String,
    pub line: u32,
    pub col: u32,
    pub source: Option<String>,
    pub reexport: Option<bool>,
}
