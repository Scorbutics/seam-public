"""Server registry — the ONLY per-language surface (config, not logic): file extensions → language,
the LSP server launch command, its `initializationOptions`, the LSP `languageId`, and project-root
markers. Adding a language = adding an entry, never resolution code.

v1 targets (Brice): TypeScript (full/MVP), Python (impl), Java/Kotlin, Ruby, C/C++ (scaffold). The
scaffolds carry the command + markers + extensions so the shape is fixed; each is a small follow-up.
"""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field


@dataclass
class ServerSpec:
    language: str
    exts: tuple[str, ...]
    # command(repo) -> argv list, or None if the server can't be obtained on this machine (→ floor).
    command: object
    language_id: object                 # str, or (file)->str when a stack has per-file ids (tsx/jsx)
    root_markers: tuple[str, ...] = ()
    init_options: object = None         # (repo)->dict, or None
    status: str = "scaffold"            # full | impl | scaffold
    notes: str = ""


def _bun_x(*pkg_args: str):
    """An npm-distributed server, fetched/run via bun (no global install). None if bun is absent."""
    def cmd(repo: str):
        bun = shutil.which("bun") or os.path.expanduser("~/.bun/bin/bun")
        return [bun, "x", *pkg_args] if os.path.exists(bun) else None
    return cmd


def _system(binary: str, *rest: str):
    """A server expected on PATH (system install). None if absent → that language degrades to floor."""
    def cmd(repo: str):
        b = shutil.which(binary)
        return [b, *rest] if b else None
    return cmd


def _ts_language_id(file: str) -> str:
    f = file.lower()
    return ("typescriptreact" if f.endswith(".tsx") else "javascriptreact" if f.endswith(".jsx")
            else "javascript" if f.endswith((".js", ".mjs", ".cjs")) else "typescript")


def _ts_init(repo: str) -> dict:
    # use the PROJECT's TypeScript (supports `moduleResolution: "bundler"` etc.); the bundled one fails.
    proj_ts = os.path.join(repo, "node_modules/typescript/lib/tsserver.js")
    opts: dict = {}
    if os.path.exists(proj_ts):
        opts["tsserver"] = {"path": proj_ts}
    return opts


REGISTRY: tuple[ServerSpec, ...] = (
    ServerSpec(
        language="typescript",
        exts=(".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"),
        command=_bun_x("typescript-language-server", "--stdio"),
        language_id=_ts_language_id,
        root_markers=("tsconfig.json", "jsconfig.json", "package.json"),
        init_options=_ts_init,
        status="full",
        notes="MUST pin the project's node_modules/typescript (bundled TS fails on moduleResolution: bundler).",
    ),
    ServerSpec(
        language="python",
        exts=(".py", ".pyi"),
        command=_bun_x("pyright-langserver", "--stdio"),
        language_id="python",
        root_markers=("pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"),
        status="scaffold",
        notes="Phase 2. pyright via bun x; venv detection (python.venvPath/pythonPath).",
    ),
    ServerSpec(
        language="java",
        exts=(".java",),
        command=_system("jdtls"),
        language_id="java",
        root_markers=("pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", ".project"),
        status="scaffold",
        notes="eclipse.jdt.ls — heavy: needs a JDK + data dir + build import; slow first index.",
    ),
    ServerSpec(
        language="kotlin",
        exts=(".kt", ".kts"),
        command=_system("kotlin-language-server"),
        language_id="kotlin",
        root_markers=("build.gradle.kts", "settings.gradle.kts", "pom.xml"),
        status="scaffold",
        notes="shares the Gradle project with Java; server less mature/slow.",
    ),
    ServerSpec(
        language="ruby",
        exts=(".rb", ".rake"),
        command=_system("ruby-lsp", "--stdio"),
        language_id="ruby",
        root_markers=("Gemfile", ".ruby-version", "Rakefile"),
        status="scaffold",
        notes="Shopify ruby-lsp (alt: solargraph stdio); run under the project's Ruby (bundler/rbenv).",
    ),
    ServerSpec(
        language="c",
        exts=(".c", ".h"),
        command=_system("clangd"),
        language_id="c",
        root_markers=("compile_commands.json", ".clangd", "compile_flags.txt", "CMakeLists.txt"),
        status="scaffold",
        notes="NEEDS compile_commands.json for real #include/symbol resolution; else degraded → floor.",
    ),
    ServerSpec(
        language="cpp",
        exts=(".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"),
        command=_system("clangd"),
        language_id="cpp",
        root_markers=("compile_commands.json", ".clangd", "CMakeLists.txt"),
        status="scaffold",
        notes="same compile-DB requirement as C; hardest (no implicit project model).",
    ),
)


def spec_for_file(file: str) -> ServerSpec | None:
    f = file.lower()
    return next((s for s in REGISTRY if f.endswith(s.exts)), None)


def language_id_for(spec: ServerSpec, file: str) -> str:
    return spec.language_id(file) if callable(spec.language_id) else spec.language_id


def project_root(repo: str, file: str, spec: ServerSpec) -> str:
    """Nearest ancestor dir (within repo) holding a root marker; else the repo itself."""
    d = os.path.dirname(os.path.join(repo, file))
    repo = os.path.abspath(repo)
    while os.path.abspath(d).startswith(repo) and os.path.abspath(d) != repo:
        if any(os.path.exists(os.path.join(d, m)) for m in spec.root_markers):
            return os.path.abspath(d)
        d = os.path.dirname(d)
    return repo
