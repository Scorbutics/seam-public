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
