"""Kotlin — LSP via kotlin-language-server. Shares the Gradle project with Java; server less mature."""
from __future__ import annotations
from .base import LanguageProvider, ServerSpec, system

PROVIDER = LanguageProvider(
    name="kotlin", extensions=(".kt", ".kts"), resolve=None,
    lsp=ServerSpec(
        language="kotlin", command=system("kotlin-language-server"), language_id="kotlin",
        root_markers=("build.gradle.kts", "settings.gradle.kts", "pom.xml"),
        status="scaffold", notes="shares the Gradle project with Java; slow."),
)
