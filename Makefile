# Seam — build & verification entrypoints.
#
# One command to go from a fresh checkout to a shippable .vsix:
#
#     make vsix
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

install: ## Install all deps (engine + extension)
	cd $(TS_DIR)  && bun install
	cd $(EXT_DIR) && bun install

vsix: install ## ⭐ Build the self-contained .vsix from zero
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
