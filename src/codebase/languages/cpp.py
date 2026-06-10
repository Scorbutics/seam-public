"""C++ — LSP via clangd. Same compile-DB requirement as C; hardest (no implicit project model)."""
from __future__ import annotations
from .base import LanguageProvider, ServerSpec, system

PROVIDER = LanguageProvider(
    name="cpp", extensions=(".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"), resolve=None,
    lsp=ServerSpec(
        language="cpp", command=system("clangd"), language_id="cpp",
        root_markers=("compile_commands.json", ".clangd", "CMakeLists.txt"),
        status="scaffold", notes="same compile-DB requirement as C."),
)
