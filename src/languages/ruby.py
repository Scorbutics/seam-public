"""Ruby — LSP via ruby-lsp (Shopify; alt solargraph). Run under the project's Ruby (bundler/rbenv)."""
from __future__ import annotations
from .base import LanguageProvider, ServerSpec, system

PROVIDER = LanguageProvider(
    name="ruby", extensions=(".rb", ".rake"), resolve=None,
    lsp=ServerSpec(
        language="ruby", command=system("ruby-lsp", "--stdio"), language_id="ruby",
        root_markers=("Gemfile", ".ruby-version", "Rakefile"),
        status="scaffold", notes="Shopify ruby-lsp (alt: solargraph stdio)."),
)
