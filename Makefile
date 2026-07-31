# Seam — build & verification entrypoints.
#
# DEPRECATED (2026-07-31): the VS Code extension is unused and no longer built by CI or attached to
# releases. `make vsix` still works for anyone who wants a local build; nothing depends on it.
#
# Run `make` (or `make help`) for the full list. Every target is idempotent and assumes
# nothing but `bun` (https://bun.sh) on PATH — `make install` brings up both the engine
# (ts/) and the extension (vscode-extension/) deps. The clean-room target additionally
# needs Docker.
SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c

TS_DIR  := ts
EXT_DIR := vscode-extension

.DEFAULT_GOAL := help

help: ## Show this help
	@echo "Seam — make targets:"
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-13s\033[0m %s\n", $$1, $$2}'

install: ## Install all deps (engine + extension) + the embedding model
	cd $(TS_DIR)  && bun install
	cd $(EXT_DIR) && bun install
	$(MAKE) embed-model

# THE EMBEDDING MODEL IS PART OF THE INSTALL, not an optional extra. The engine's own words when it is missing:
# "This is an install fault, not a mode." Without it the intent field is silently off, and relevance ranking,
# tiering and centre selection all degrade — so intent-guided answers differ from a machine that has it.
#
# `bun install` pulls the transformers.js PACKAGE but not the WEIGHTS: those are fetched lazily on first use by
# the TypeScript side, and since the engine moved to Rust nothing on the TS path ever triggers that fetch.
# seam-embed only READS the cache. So on any fresh checkout the model never arrived and the field was quietly
# off — which is exactly what CI was: 3 intent-ranked grow tests failing on ubuntu while passing locally, because
# this machine had a warm cache from before the migration.
#
# BOTH quantized variants, because the cache is keyed on that flag and the core may ask for either.
# Idempotent: transformers.js no-ops when the files are already cached, so re-running `make install` is cheap.
embed-model: ## Fetch the sentence-embedding weights the intent field reads (idempotent)
	cd $(TS_DIR) && bun -e 'const {pipeline,env}=await import("./node_modules/@xenova/transformers/src/transformers.js"); env.cacheDir="./node_modules/@xenova/transformers/.cache"; for (const q of [true,false]) await pipeline("feature-extraction","Xenova/all-MiniLM-L6-v2",{quantized:q});'

vsix: install ## DEPRECATED — build the .vsix locally (unused; not in CI, not in releases)
	cd $(EXT_DIR) && bun run package
	@echo && ls -lh $(EXT_DIR)/*.vsix

test: install ## Typecheck the engine + run the unit tests
	cd $(TS_DIR) && bun run typecheck && bun test

smoke: ## Offline (det, no LLM) smoke test on every checked-in sample diff
	bash scripts/smoke.sh

eval-grow: ## Grow-border region matrix on the hermetic fixture (det/tol offline; slm needs a backend)
	cd $(TS_DIR) && bun eval/grow_harness.ts eval --baseline

readme-audit: ## Run the documented README commands verbatim (offline subset always)
	bash scripts/readme-audit.sh

cleanroom: ## Prove zero-to-running in a vanilla Docker container (needs Docker)
	bash scripts/cleanroom.sh

ci: test readme-audit smoke vsix ## Everything CI runs, locally

.PHONY: help install vsix test smoke eval-grow readme-audit cleanroom ci
