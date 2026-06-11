"""Mode-agnostic resolution: module/symbol resolvers (det floor + LSP), the language
registry, and consumer discovery. Promoted from src/codebase/ so BOTH diff and codebase
modes can resolve references against the real repo (architecture rule: core imports neither
mode). See resolver.py, languages/, lsp/, consumers.py.
"""
