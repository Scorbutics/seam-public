#!/usr/bin/env bun
// seam slm — provision a LOCAL fast SLM (Ollama) for the cheap tier, so the reliable wave+LLM-border grow is
// ALSO fast out of the box. The `claude -p` subprocess has a ~15s/call floor even on haiku; a local 3B model
// answers the tight grow-border keep/drop judgement in <1s. This DETECTS a server you already run, else
// downloads Ollama into ~/.seam/ollama, starts it, pulls a small model, and records ~/.seam/slm.json — which
// the engine auto-reads (and auto-starts the managed binary from), so no SEAM_OLLAMA_MODEL export is needed.
//
//   seam slm install [--model qwen2.5:3b] [--url http://127.0.0.1:11434]   # detect-or-download, pull, configure
//   seam slm status                                                         # what's configured + reachable
//   seam slm where                                                          # the managed dir + config path
//   seam slm uninstall [--purge]                                            # drop the config (+ --purge the managed install)
//
// We do NOT bundle the ~3.4 GB into the package (the .vsix is ~6 MB) — the model is an irreducible one-time
// download regardless; this just makes provisioning one command. Linux is validated; macOS/Windows resolve the
// platform asset the same way (best-effort).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSlmConfig, writeSlmConfig, slmConfigPath, resetSlmConfig, type SlmConfig } from "../core/slm_config.js";

const DEFAULT_MODEL = "qwen2.5:3b";   // validated crop quality; --model overrides (qwen2.5:1.5b is lighter)
const managedDir = (): string => join(homedir(), ".seam", "ollama");
const managedBin = (): string => join(managedDir(), "bin", "ollama");
const log = (m: string): void => { process.stderr.write(m + "\n"); };
const arg = (flag: string, dflt: string): string => { const i = process.argv.indexOf(flag); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
const has = (flag: string): boolean => process.argv.includes(flag);
const sleep = (ms: number): void => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* skip */ } };

const serverUp = (url: string): boolean => spawnSync("curl", ["-sf", "-m", "2", `${url}/api/tags`], { encoding: "utf-8" }).status === 0;
function modelPresent(url: string, model: string): boolean {
  const r = spawnSync("curl", ["-sf", "-m", "3", `${url}/api/tags`], { encoding: "utf-8" });
  return r.status === 0 && (r.stdout ?? "").includes(model.split(":")[0]);
}
function whichOllama(): string | null {
  const r = spawnSync("which", ["ollama"], { encoding: "utf-8" });
  const p = (r.stdout ?? "").split("\n")[0].trim();
  return r.status === 0 && p ? p : null;
}

// The release asset for THIS platform — matched from the GitHub releases API (names change; never hardcode a tag).
function assetUrl(): { url: string; ext: string } | null {
  const r = spawnSync("curl", ["-sfL", "-m", "20", "https://api.github.com/repos/ollama/ollama/releases/latest"], { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return null;
  const urls = [...(r.stdout ?? "").matchAll(/"browser_download_url":\s*"([^"]+)"/g)].map((m) => m[1]);
  const plat = process.platform, arch = process.arch;   // 'linux'|'darwin'|'win32', 'x64'|'arm64'
  const want = plat === "win32" ? ["windows", arch === "arm64" ? "arm64" : "amd64"]
    : plat === "darwin" ? ["darwin"]
    : ["linux", arch === "arm64" ? "arm64" : "amd64"];
  // prefer the BASE bundle (skip -rocm / -mlx variants), require every token, pick a known archive ext
  const cand = urls.filter((u) => want.every((t) => u.toLowerCase().includes(t)) && !/-rocm|-mlx/.test(u)
    && /\.(tar\.zst|tgz|tar\.gz|zip)$/.test(u));
  if (!cand.length) return null;
  const url = cand.sort((a, b) => a.length - b.length)[0];   // shortest = the base asset
  const ext = url.endsWith(".tar.zst") ? "tar.zst" : url.endsWith(".zip") ? "zip" : "tgz";
  return { url, ext };
}

async function download(): Promise<string | null> {
  const a = assetUrl();
  if (!a) { log("✗ could not resolve an Ollama release asset for this platform — install Ollama yourself, then re-run `seam slm install`."); return null; }
  mkdirSync(managedDir(), { recursive: true });
  const tmp = join(managedDir(), `dl.${a.ext}`);
  log(`↓ downloading Ollama (${a.url.split("/").pop()}) — one-time, ~1.4 GB…`);
  if (spawnSync("curl", ["-fL", "--progress-bar", "-o", tmp, a.url], { stdio: ["ignore", "ignore", "inherit"] }).status !== 0) { log("✗ download failed"); return null; }
  log("◦ extracting…");
  const ex = a.ext === "tar.zst" ? spawnSync("tar", ["-I", "zstd", "-xf", tmp, "-C", managedDir()])
    : a.ext === "zip" ? spawnSync("unzip", ["-oq", tmp, "-d", managedDir()])
      : spawnSync("tar", ["-xzf", tmp, "-C", managedDir()]);
  try { rmSync(tmp); } catch { /* keep going */ }
  if (ex.status !== 0) { log("✗ extraction failed"); return null; }
  // the binary may land at <dir>/bin/ollama or <dir>/ollama depending on the asset layout
  for (const p of [managedBin(), join(managedDir(), "ollama")]) if (existsSync(p)) return p;
  log("✗ extracted, but the ollama binary wasn't where expected"); return null;
}

function startServe(bin: string, url: string): boolean {
  const host = url.replace(/^https?:\/\//, "");
  try { spawn(bin, ["serve"], { detached: true, stdio: "ignore", env: { ...process.env, OLLAMA_HOST: host } }).unref(); } catch { return false; }
  for (const deadline = Date.now() + 15000; Date.now() < deadline; sleep(400)) if (serverUp(url)) return true;
  return false;
}

function pull(bin: string | null, url: string, model: string): boolean {
  log(`↓ pulling model ${model} (one-time)…`);
  if (bin) {   // the binary shows a nice progress bar and targets our server via OLLAMA_HOST
    return spawnSync(bin, ["pull", model], { stdio: "inherit", env: { ...process.env, OLLAMA_HOST: url.replace(/^https?:\/\//, "") } }).status === 0;
  }
  // reusing a server we have no binary for → pull over HTTP (blocks until done; no progress bar)
  return spawnSync("curl", ["-fS", "-m", "1800", "-X", "POST", `${url}/api/pull`, "-d", JSON.stringify({ name: model, stream: false })], { stdio: ["ignore", "ignore", "inherit"] }).status === 0;
}

async function install(): Promise<number> {
  const model = arg("--model", DEFAULT_MODEL);
  const url = arg("--url", "http://127.0.0.1:11434");
  log(`seam slm install — model ${model}, server ${url}`);

  let bin: string | null = existsSync(managedBin()) ? managedBin() : whichOllama();   // a binary we can (re)start, if any
  if (serverUp(url)) {
    log(`✓ reusing the Ollama server already running at ${url}${bin ? "" : " (no local binary found — the engine can't auto-restart it; keep it running)"}`);
  } else {
    if (!bin) { bin = await download(); if (!bin) return 1; }
    log("◦ starting the Ollama server…");
    if (!startServe(bin, url)) { log(`✗ the server didn't come up at ${url}`); return 1; }
    log("✓ server up");
  }
  if (!pull(bin, url, model)) { log("✗ model pull failed"); return 1; }
  if (!modelPresent(url, model)) { log(`✗ ${model} isn't listed by the server after pull`); return 1; }

  const cfg: SlmConfig = { model, url, bin };
  writeSlmConfig(cfg);
  log(`\n✓ done. Wrote ${slmConfigPath()}`);
  log("  The grow now defaults to wave + LLM-border served by this local model — reliable AND fast, no env vars needed.");
  log("  (First call per session pays a one-time ~60 s model load; then ~1–4 s/call.)");
  return 0;
}

function status(): number {
  const cfg = readSlmConfig();
  if (!cfg) { log("not provisioned — run `seam slm install`. (SEAM_OLLAMA_MODEL env, if set, still works.)"); return 0; }
  const up = serverUp(cfg.url), present = up && modelPresent(cfg.url, cfg.model);
  log(`model:   ${cfg.model}`);
  log(`server:  ${cfg.url}  ${up ? "● up" : "○ down" + (cfg.bin ? " (engine will auto-start it)" : "")}`);
  log(`model present: ${present ? "yes" : "no"}`);
  log(`managed bin:   ${cfg.bin ?? "(reusing your own server)"}`);
  return present || (!up && cfg.bin) ? 0 : 1;
}

function where(): number {
  log(`config:      ${slmConfigPath()}`);
  log(`managed dir: ${managedDir()}${existsSync(managedDir()) ? "" : " (not installed)"}`);
  return 0;
}

function uninstall(): number {
  try { rmSync(slmConfigPath(), { force: true }); } catch { /* ignore */ }
  resetSlmConfig();
  if (has("--purge")) { try { rmSync(managedDir(), { recursive: true, force: true }); log(`removed ${managedDir()}`); } catch { /* ignore */ } }
  log("✓ slm config removed (the grow falls back to the deterministic picker / claude)" + (has("--purge") ? "" : " — pass --purge to also delete the managed install"));
  return 0;
}

export async function runSlm(args: string[]): Promise<number> {
  const cmd = (args[0] ?? "").toLowerCase();
  switch (cmd) {
    case "install": return install();
    case "status": return status();
    case "where": return where();
    case "uninstall": return uninstall();
    default:
      log("usage: seam slm <install|status|where|uninstall>");
      log("  install [--model qwen2.5:3b] [--url http://127.0.0.1:11434]");
      return cmd ? 1 : 0;
  }
}

if (import.meta.main) runSlm(process.argv.slice(2)).then((c) => process.exit(c));
