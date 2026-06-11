"""C — LSP via clangd. NEEDS compile_commands.json for real #include/symbol resolution; else degraded."""
from __future__ import annotations
from .base import LanguageProvider, ServerSpec, system

PROVIDER = LanguageProvider(
    name="c", extensions=(".c", ".h"), resolve=None,
    lsp=ServerSpec(
        language="c", command=system("clangd"), language_id="c",
        root_markers=("compile_commands.json", ".clangd", "compile_flags.txt", "CMakeLists.txt"),
        status="scaffold", notes="needs a compile DB (compile_commands.json) or degrades → floor."),
)
