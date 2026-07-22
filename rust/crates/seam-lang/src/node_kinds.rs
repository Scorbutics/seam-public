//! The node-kind registry — closed, cross-language CONCEPT sets over tree-sitter kinds (port of the sets in
//! atoms.ts). One place; the AST scans dispatch through these, never on literal kinds, so a scan is
//! language-agnostic and adding a language is adding kinds here.

/// A call node (JS/TS `call_expression`, Java `method_invocation`, Ruby `call`, C# `invocation_expression`).
pub fn is_call(k: &str) -> bool {
    matches!(k, "call_expression" | "method_invocation" | "call" | "invocation_expression")
}

/// Call-node FIELD names for a flat-call grammar's (method name, receiver): Java name/object, Ruby method/receiver.
pub const CALL_NAME_FIELD: &[&str] = &["name", "method"];
pub const CALL_RECV_FIELD: &[&str] = &["object", "receiver"];

/// Any named-type declaration (class / interface / enum / record / struct / Ruby `class`).
pub fn is_class_kind(k: &str) -> bool {
    matches!(
        k,
        "class_declaration"
            | "abstract_class_declaration"
            | "class_definition"
            | "class_specifier"
            | "struct_specifier"
            | "interface_declaration"
            | "enum_declaration"
            | "record_declaration"
            | "class"
    )
}

/// A member/attribute access node (`a.b`), where the callee of a nested-grammar method call lives.
pub fn is_member(k: &str) -> bool {
    matches!(k, "member_expression" | "attribute" | "field_access" | "selector_expression" | "field_expression")
}

/// The member NAME leaf within a member access.
pub fn is_member_name(k: &str) -> bool {
    matches!(k, "property_identifier" | "field_identifier")
}

/// A plain name identifier (declared/reference).
pub fn is_name_kind(k: &str) -> bool {
    matches!(k, "identifier" | "property_identifier" | "type_identifier")
}

/// The identifier LEAVES a declared name can resolve to (incl. the C/C++ declarator chain terminals).
pub fn is_name_leaf(k: &str) -> bool {
    matches!(
        k,
        "identifier"
            | "field_identifier"
            | "qualified_identifier"
            | "destructor_name"
            | "operator_name"
            | "type_identifier"
            | "property_identifier"
    )
}

/// A class's `extends`-bases clause (TS extends_clause, Java superclass, Python argument_list).
pub fn is_heritage(k: &str) -> bool {
    matches!(k, "extends_clause" | "superclass" | "base_class_clause" | "argument_list" | "extends_interfaces")
}

/// The kinds a base reference can take within a heritage clause.
pub fn is_base_name(k: &str) -> bool {
    matches!(k, "identifier" | "type_identifier" | "member_expression" | "scoped_identifier" | "scoped_type_identifier")
}

/// An instantiation (`new T()` / Java object_creation_expression).
pub fn is_new(k: &str) -> bool {
    matches!(k, "new_expression" | "object_creation_expression")
}

/// A type-reference token.
pub fn is_type_ref(k: &str) -> bool {
    k == "type_identifier"
}

/// A name-binding declaration whose declared type resolves a receiver (field / param / local / var).
pub fn is_instance_binder(k: &str) -> bool {
    matches!(
        k,
        "variable_declarator"
            | "required_parameter"
            | "optional_parameter"
            | "public_field_definition"
            | "field_definition"
            | "property_signature"
    )
}

/// A method-declaration node kind.
pub fn is_method_kind(k: &str) -> bool {
    matches!(k, "method_definition" | "method_declaration" | "constructor_declaration" | "method" | "singleton_method")
}

pub fn is_interface(k: &str) -> bool {
    k == "interface_declaration"
}

/// An `implements` clause (Java super_interfaces, TS implements_clause) — the interface→impl (DI) relation.
pub fn is_implements(k: &str) -> bool {
    matches!(k, "super_interfaces" | "implements_clause")
}

/// An annotation/decorator node (Java annotation/marker_annotation, TS decorator) — framework-entry PRESENCE.
pub fn is_annotation(k: &str) -> bool {
    matches!(k, "annotation" | "marker_annotation" | "decorator")
}

/// A typed DECLARATION node carrying a `type` field + a bound name (field / ctor-param / local / TS binder) —
/// its declared type resolves a receiver.
pub fn is_typed_decl(k: &str) -> bool {
    matches!(
        k,
        "field_declaration"
            | "formal_parameter"
            | "local_variable_declaration"
            | "public_field_definition"
            | "field_definition"
            | "property_signature"
            | "required_parameter"
            | "optional_parameter"
    )
}

pub fn is_interface_member(k: &str) -> bool {
    matches!(k, "method_signature" | "property_signature" | "abstract_method_signature")
}

/// Any function-like declaration.
pub fn is_funclike(k: &str) -> bool {
    matches!(
        k,
        "arrow_function"
            | "function_declaration"
            | "function_expression"
            | "method_definition"
            | "generator_function_declaration"
            | "function_signature"
            | "function_definition"
            | "lambda_expression"
            | "method_declaration"
            | "constructor_declaration"
            | "function_item"
            | "closure_expression"
            | "lambda"
            | "function"
            | "method"
    )
}

/// An anonymous function (no declared name).
pub fn is_anon_func(k: &str) -> bool {
    matches!(k, "arrow_function" | "function_expression" | "lambda" | "lambda_expression" | "closure_expression")
}

/// A variable declarator / assignment (may bind a name to a function value).
pub fn is_var_declarator(k: &str) -> bool {
    matches!(k, "variable_declarator" | "assignment")
}

/// A variable-declaration statement (holds one or more declarators): TS `const`/`let`/`var`.
pub fn is_var_decl(k: &str) -> bool {
    matches!(k, "lexical_declaration" | "variable_declaration")
}

/// An `export` statement (TS/JS module boundary node).
pub fn is_export(k: &str) -> bool {
    k == "export_statement"
}

/// The `{ … }` clause of an export/re-export statement.
pub fn is_export_clause(k: &str) -> bool {
    k == "export_clause"
}

/// One specifier within an export clause (`a`, `a as b`).
pub fn is_export_specifier(k: &str) -> bool {
    k == "export_specifier"
}
