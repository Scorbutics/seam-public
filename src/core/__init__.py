"""Mode-agnostic engine + substrate shared by BOTH pipelines (diff-mode and codebase-mode).

The rule: `src/diff/*` and `src/codebase/*` may import from `src/core/*` and from themselves, but
NEVER from each other. `core/` knows nothing about either mode — it holds the genuinely cross-cutting
pieces: the IR (`graph_ir`), the LLM/CLI plumbing (`llm`), the tree-sitter parsing substrate
(`treesitter`), and the mode-dispatch strategy (`mode`)."""
