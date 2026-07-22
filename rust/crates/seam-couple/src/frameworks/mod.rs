//! FRAMEWORK REGISTRIES — the declarative half of framework support: per-framework DATA (which annotation is a
//! route, which method an ORM write, …), never logic. The framework-AGNOSTIC adapters consume these tables, so
//! "add a framework" is "add rows". Kept apart from the engine, the coupling counterpart of adding a language.

pub mod route_annotations;
