// Shared test helpers.
//
// SAFETY: importing this file points CLAUDE_CONFIG_DIR, HOME and USERPROFILE of the test process
// at a throwaway folder and clears CLAUDE_PROJECT_DIR, so nothing a test does can read or write the
// real Claude config. Every child process the tests start gets the same treatment from childEnv().
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../src/decide.mjs";
import { defaultConfig } from "../src/config.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const GUARD = path.join(ROOT, "guard.mjs");
export const CLI = path.join(ROOT, "bin", "claude-guardrails.mjs");

const real = (p) => fs.realpathSync(p);
const SAFE = real(fs.mkdtempSync(path.join(os.tmpdir(), "gr-t-")));
const SAFE_CFG = path.join(SAFE, "cfg");
const SAFE_HOME = path.join(SAFE, "home");
fs.mkdirSync(SAFE_CFG);
fs.mkdirSync(SAFE_HOME);
process.env.CLAUDE_CONFIG_DIR = SAFE_CFG;
process.env.HOME = SAFE_HOME;
process.env.USERPROFILE = SAFE_HOME;
delete process.env.CLAUDE_PROJECT_DIR;
process.on("exit", () => { try { fs.rmSync(SAFE, { recursive: true, force: true }); } catch { /* best effort */ } });

/** A throwaway folder (links resolved: macOS /var is a link) that is removed when the test run ends. */
const made = [];
export function tmp(prefix = "gr-") {
  const dir = real(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
process.on("exit", () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

/** A throwaway world: a Claude config folder, a home folder and a project (with a .git marker folder). */
export function world() {
  const root = tmp("gr-w-");
  const cfg = path.join(root, "cfg");
  const home = path.join(root, "home");
  const proj = path.join(root, "proj");
  for (const d of [cfg, home, path.join(proj, ".git")]) fs.mkdirSync(d, { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: cfg, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: proj };
  return { root, cfg, home, proj, env };
}

/** The environment for a child process: ours, with the safe folders and the given overrides (undefined removes). */
export function childEnv(w, extra = {}) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: SAFE_CFG, HOME: SAFE_HOME, USERPROFILE: SAFE_HOME, ...(w ? w.env : {}), ...extra };
  delete env.CLAUDE_CODE_SESSION_ID;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

export function runNode(script, args, { w, input, cwd, env } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { input, cwd, env: childEnv(w, env), encoding: "utf8", timeout: 60000, windowsHide: true });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", out: (r.stdout || "") + (r.stderr || "") };
}

/** Run the hook script with an event on stdin. */
export const runHook = (w, event, opts = {}) => runNode(GUARD, [], { w, input: typeof event === "string" ? event : JSON.stringify(event), ...opts });
/** Run the command line. */
export const runCli = (w, args, opts = {}) => runNode(CLI, args, { w, ...opts });

// ---------------------------------------------------------------------------------------------
// Simulated machines: the checks are pure functions of an env object, so every check runs as Linux, macOS or Windows anywhere
// ---------------------------------------------------------------------------------------------

/** A git runner that records its calls and answers `rev-parse --abbrev-ref HEAD` with `branch`. */
export function fakeGit(branch = "feature") {
  const calls = [];
  const run = (args, opts) => {
    calls.push({ args, cwd: opts && opts.cwd });
    if (branch !== null && args[0] === "rev-parse") return { ok: true, stdout: `${branch}\n` };
    return { ok: false, stdout: "" };
  };
  return { calls, run };
}

const base = { git: fakeGit().run };
export const LINUX = { ...base, platform: "linux", cwd: "/home/me/proj", projectDir: "/home/me/proj", home: "/home/me", tmpDirs: ["/tmp", "/var/tmp"], configDir: "/home/me/.claude" };
export const MAC = { ...base, platform: "darwin", cwd: "/Users/me/proj", projectDir: "/Users/me/proj", home: "/Users/me", tmpDirs: ["/var/folders/zz/T", "/private/var/folders/zz/T", "/tmp", "/private/tmp"], configDir: "/Users/me/.claude" };
export const WIN = { ...base, platform: "win32", cwd: "C:\\Users\\me\\proj", projectDir: "C:\\Users\\me\\proj", home: "C:\\Users\\me", tmpDirs: ["C:\\Users\\me\\AppData\\Local\\Temp", "/tmp"], configDir: "C:\\Users\\me\\.claude" };

/** Decide for a tool call under one preset (and optional config overrides). */
export function check(env, tool, input, preset = "balanced", config = {}) {
  return decide({ tool_name: tool, tool_input: input, cwd: env.cwd }, { env, config: defaultConfig({ preset, ...config }) });
}
export const bash = (env, command, preset, config) => check(env, "Bash", { command }, preset, config);
export const pwsh = (env, command, preset, config) => check(env, "PowerShell", { command }, preset, config);

export const WORD = { A: "allow", K: "ask", D: "deny" };

// ---------------------------------------------------------------------------------------------
// Fake secrets: built from pieces so no complete token sits in this source (GitHub push protection)
// ---------------------------------------------------------------------------------------------

export const FAKE = {
  github: "gh" + "p_" + "x".repeat(36),
  aws: "AK" + "IA" + "IOSFODNN7" + "EXAMPLE",
  awsSecret: "aws_secret_access_key = " + "abcdefghij".repeat(4),
  anthropic: "sk-" + "ant-" + "api03-" + "A1b2C3d4".repeat(4),
  stripe: "sk_" + "live_" + "a1B2c3D4e5F6g7H8i9",
  slack: "xox" + "b-" + "1234567890-abcdefghij",
  pem: "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END " + "RSA PRIVATE KEY-----",
  password: "DB_PASSWORD=hunter2hunter2",
};

// ---------------------------------------------------------------------------------------------
// Real git repositories, isolated from the machine's own git config
// ---------------------------------------------------------------------------------------------

export function gitEnv(dir) {
  const globalCfg = path.join(dir, "gitconfig-empty");
  if (!fs.existsSync(globalCfg)) fs.writeFileSync(globalCfg, "");
  return { GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
}

export function git(cwd, args, env = {}) {
  const r = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

/** A repo with one commit on `main`. Returns { dir, env, run(args), write(file, text), branch(name) }. */
export function repo({ branch = "main" } = {}) {
  const root = tmp("gr-g-");
  const dir = path.join(root, "repo");
  fs.mkdirSync(dir);
  const env = gitEnv(root);
  const run = (args) => git(dir, args, env);
  run(["init", "-q", `--initial-branch=${branch}`]);
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "first"]);
  return {
    root, dir, env, run,
    write(file, text) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); },
    // an environment whose git calls are real and isolated from the machine's git config
    sim() {
      return { ...LINUX, platform: process.platform, cwd: dir, projectDir: dir, home: path.join(root, "home"), tmpDirs: [os.tmpdir(), real(os.tmpdir())], configDir: path.join(root, "cfg"),
        git: (args, opts) => { const r = spawnSync("git", args, { cwd: opts.cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: opts.timeout, windowsHide: true }); return r.status === 0 ? { ok: true, stdout: r.stdout } : { ok: false, stdout: "" }; } };
    },
  };
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export const ls = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
