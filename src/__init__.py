"""Read-time change decomposition — MVP.

Recovers the structure of a diff into roles (core / link / environment / noise)
so a human can review by intent instead of scrolling file-by-file.

The tool only *structures* — it never judges, scores, or approves code.
"""

ROLES = ("core", "link", "environment", "test", "noise")

ROLE_DESCRIPTIONS = {
    "core": "The new or changed logic — what the change is fundamentally about. "
            "Trust: behavioral (does it work, is it complete).",
    "link": "The joints wiring the new thing into the existing system — params "
            "threading across layers. Trust: contract (do the integration points hold).",
    "environment": "Ambient ripple — shared utilities, global CSS, cross-cutting "
                   "concerns touched. Trust: impact (what else does this affect).",
    "test": "Code that VERIFIES the change (unit/integration tests). It COVERS the "
            "cores it exercises rather than being the change. Trust: verification — "
            "execution is delegated to CI (skim the internals), but whether the "
            "coverage is REAL (would catch a regression) is delegated to no one.",
    "noise": "Renames, formatting, indentation — no logical effect. "
             "Trust: essentially none; confirm it really is noise.",
}
