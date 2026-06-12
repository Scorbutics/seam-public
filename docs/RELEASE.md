# Releasing Seam

A short, mechanical checklist. The whole point is that **none of this is judgement** — it either
passes or it doesn't. CI (`.github/workflows/ci.yml`) runs the same checks on every push; this is
how you run them yourself before tagging.

## One-time prerequisites

- [`bun`](https://bun.sh) on PATH (nothing else — no `node`/`npm`).
- Docker, only for the clean-room step.

## The gate

```bash
make ci          # typecheck + unit tests + README-command audit + offline smoke + build the .vsix
make cleanroom   # the same, but from ZERO inside a vanilla Docker container (catches "works on my machine")
```

`make ci` is the fast loop (uses your local toolchain). `make cleanroom` is the honesty check: it
builds a bare Debian image, installs `bun` fresh, copies in only your working tree (no `node_modules`
— see `.dockerignore`), and runs `make vsix && make smoke && make test`. If a step secretly depended
on something already on your machine, it fails here instead of in public.

### What each piece proves

| command | proves |
|---|---|
| `make test` | the engine typechecks and all unit tests pass |
| `make readme-audit` | every command in [`README.md`](../README.md) §Install&run runs verbatim (offline subset always; model-backed ones run only if a `claude` CLI is present, else skipped) |
| `make smoke` | the offline (`det`) engine decomposes every checked-in `samples/*.patch` |
| `make vsix` | a self-contained `.vsix` builds from a fresh checkout |
| `make cleanroom` | all of the above from zero on a vanilla machine |

> The README command list lives in [`scripts/readme-audit.sh`](../scripts/readme-audit.sh). If you
> change a documented command, change it there too — that coupling is what keeps the docs honest.

## Cutting a release

The `.vsix` is published to a GitHub Release by [`release.yml`](../.github/workflows/release.yml),
triggered by a pushed tag:

```bash
# 1. make ci && make cleanroom both green
# 2. bump "version" in vscode-extension/package.json
git tag v0.1.0
git push origin v0.1.0     # release.yml builds + attaches seam-<version>.vsix (marked prerelease)
```

Install the result with **Extensions → … → Install from VSIX…**, or:

```bash
code --install-extension seam-<version>.vsix
```

## If the clean-room fails

That's the system working — it found a real gap. Common causes:

- A from-source command in the README assumes deps that `make install` doesn't fetch → add the step.
- Non-determinism that differs by filesystem/OS (the directory walk is sorted in
  `ts/src/core/resolve/walk.ts` for exactly this reason) → make the output deterministic, don't pin
  the test to one machine's order.
- A tool assumed on PATH that a bare box lacks → install it in `Dockerfile.cleanroom` (and document
  it as a real prerequisite) or remove the dependency.
