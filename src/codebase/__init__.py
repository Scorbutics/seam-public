"""Codebase-mode pipeline — anchor on a symbol → its intent FOOTPRINT (consumers + dependencies) →
seams. Self-contained: imports only from `..core` (shared engine) and within `codebase/`. The flow is
scan (import_scan, via resolver/LSP + languages/) → decompose (codebase) → SeamModel. See
`core.mode.CodebaseMode` for the strategy entry point."""
