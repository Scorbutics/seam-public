"""Java — LSP via eclipse.jdt.ls (jdtls). Heavy: needs a JDK + data dir + build import; slow index."""
from __future__ import annotations
from .base import LanguageProvider, ServerSpec, system

PROVIDER = LanguageProvider(
    name="java", extensions=(".java",), resolve=None,
    lsp=ServerSpec(
        language="java", command=system("jdtls"), language_id="java",
        root_markers=("pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", ".project"),
        status="scaffold", notes="eclipse.jdt.ls — needs JDK + workspace data dir; slow first index."),
)
