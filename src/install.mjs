// init / uninstall: put the PreToolUse hook into settings.json, and remove exactly that again.
//
//   user scope     <configDir>/claude-code-guardrails/   our copy of guard.mjs, src/ and bin/ (plus errors.log)
//                  <configDir>/settings.json             one entry under hooks.PreToolUse
//   project scope  <project>/.claude/guardrails/         the same copy, committed so teammates get it
//                  <project>/.claude/settings.json       one entry under hooks.PreToolUse
//
// settings.json is only touched after a timestamped backup, only our own entry is added, replaced or
// removed (recognised by its script path), and a file that is not valid JSON is left alone.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configDir, findProjectRoot, guardDir, projectConfigFile, setPresetIn, userConfigFile } from "./config.mjs";
import { exists, readJsonFile, samePath, syncDir, timestamp, uniquePath, writeJsonFile } from "./fsutil.mjs";
import { HOOK_MATCHER, HOOK_TIMEOUT, NAME } from "./meta.mjs";
import { PRESETS } from "./rules.mjs";

/** The folder this package runs from: the repo, or an installed copy. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const consoleIO = { log: (s = "") => console.log(s), error: (s = "") => console.error(s) };
const PROJECT_SCRIPT = "${CLAUDE_PROJECT_DIR}/.claude/guardrails/guard.mjs";

// ---------------------------------------------------------------------------------------------
// The hook entry in settings.json
// ---------------------------------------------------------------------------------------------

const scriptsOf = (h) => [h && h.command, ...(h && Array.isArray(h.args) ? h.args : [])].filter((s) => typeof s === "string").map((s) => s.replace(/\\/g, "/"));

/** True for a hook entry that runs a guard.mjs of ours, however it was written. */
export const isOurHook = (h) => !!h && typeof h === "object" && scriptsOf(h).some((s) => /(?:^|\/)(?:claude-code-guardrails|\.claude\/guardrails)\/guard\.mjs["']?$/.test(s));

export const hookEntry = (script) => ({ type: "command", command: "node", args: [script], timeout: HOOK_TIMEOUT });

/** Why this settings object cannot take a hook entry, or "" when it can. */
export function shapeProblem(settings) {
  if (settings.hooks !== undefined && (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks))) return '"hooks" is not an object';
  if (settings.hooks && settings.hooks.PreToolUse !== undefined && !Array.isArray(settings.hooks.PreToolUse)) return '"hooks.PreToolUse" is not a list';
  return "";
}

const ourEntries = (groups) => groups.flatMap((g) => (g && Array.isArray(g.hooks) ? g.hooks.filter(isOurHook) : []));

/** Settings with our entry present exactly once. { settings, changed } */
export function addHook(settings, script) {
  const next = JSON.parse(JSON.stringify(settings));
  const groups = next.hooks && Array.isArray(next.hooks.PreToolUse) ? next.hooks.PreToolUse : [];
  const wanted = hookEntry(script);
  const ours = ourEntries(groups);
  const inPlace = ours.length === 1 && JSON.stringify(ours[0]) === JSON.stringify(wanted)
    && groups.some((g) => g && g.matcher === HOOK_MATCHER && Array.isArray(g.hooks) && g.hooks.some(isOurHook));
  if (inPlace) return { settings, changed: false };
  const kept = groups.map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurHook(h)) } : g)).filter((g) => !g || !Array.isArray(g.hooks) || g.hooks.length);
  kept.push({ matcher: HOOK_MATCHER, hooks: [wanted] });
  next.hooks = { ...(next.hooks || {}), PreToolUse: kept };
  return { settings: next, changed: true };
}

/** Settings without any entry of ours; empty containers we leave behind are removed. { settings, removed } */
export function removeHook(settings) {
  const next = JSON.parse(JSON.stringify(settings));
  const groups = next.hooks && Array.isArray(next.hooks.PreToolUse) ? next.hooks.PreToolUse : null;
  if (!groups) return { settings, removed: 0 };
  const removed = ourEntries(groups).length;
  if (!removed) return { settings, removed: 0 };
  const kept = groups.map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurHook(h)) } : g)).filter((g) => !g || !Array.isArray(g.hooks) || g.hooks.length);
  if (kept.length) next.hooks.PreToolUse = kept;
  else delete next.hooks.PreToolUse;
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return { settings: next, removed };
}

const snippet = (script) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [hookEntry(script)] }] } }, null, 2).split("\n").map((l) => `      ${l}`).join("\n");

// Copy settings.json aside before changing it. Returns the backup path.
function backupSettings(file) {
  const backup = uniquePath(`${file}.bak-guardrails-${timestamp()}`);
  fs.copyFileSync(file, backup);
  return backup;
}

// ---------------------------------------------------------------------------------------------
// Where each scope keeps things
// ---------------------------------------------------------------------------------------------

export function locations(scope, { cwd = process.cwd(), env = process.env } = {}) {
  const cfg = configDir(env);
  if (scope === "project") {
    const root = findProjectRoot(cwd);
    const dir = path.join(root, ".claude", "guardrails");
    return { scope, root, dir, script: PROJECT_SCRIPT, runScript: path.join(dir, "guard.mjs"), settings: path.join(root, ".claude", "settings.json"), config: projectConfigFile(root), cfg };
  }
  const dir = guardDir(cfg);
  return { scope: "user", root: null, dir, script: path.join(dir, "guard.mjs"), runScript: path.join(dir, "guard.mjs"), settings: path.join(cfg, "settings.json"), config: userConfigFile(env), cfg };
}

// Run the installed hook once, the way Claude Code will, to prove it works.
function selfTest(loc, env) {
  const project = loc.root || process.cwd();
  const r = spawnSync(process.execPath, [loc.runScript], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" }, cwd: project }),
    encoding: "utf8", timeout: 8000, windowsHide: true,
    env: { ...process.env, ...env, CLAUDE_CONFIG_DIR: loc.cfg, CLAUDE_PROJECT_DIR: project },
  });
  try { return r.status === 0 && JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === "deny"; } catch { return false; }
}

// ---------------------------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------------------------

/**
 * claude-guardrails init
 * @param opts { scope = "user", preset?, cwd?, env? }
 * @returns exit code: 0 done, 1 failed or settings.json could not be updated
 */
export function init(opts = {}, io = consoleIO) {
  const env = opts.env || process.env;
  const loc = locations(opts.scope === "project" ? "project" : "user", { cwd: opts.cwd, env });
  if (opts.preset && !PRESETS.includes(opts.preset)) { io.error(`Unknown preset "${opts.preset}". Use one of: ${PRESETS.join(", ")}`); return 1; }

  const settings = readJsonFile(loc.settings);
  if (settings.status === "invalid") {
    io.error("");
    io.error(`  ✖ ${loc.settings} ${settings.error || "cannot be read"}, so I left everything untouched.`);
    io.error("    Fix the file (or add this under the top-level object by hand), then run init again:");
    io.error("");
    io.error(snippet(loc.script));
    return 1;
  }
  const problem = shapeProblem(settings.data);
  if (problem) {
    io.error(`  ✖ ${loc.settings}: ${problem}, so I left everything untouched. Add this by hand:`);
    io.error(snippet(loc.script));
    return 1;
  }

  io.log(`${NAME} init (${loc.scope} scope)`);
  io.log(`  settings file  ${loc.settings}`);

  // 1. our copy of the scripts
  if (samePath(ROOT, loc.dir)) io.log("  - running from the installed copy; not copying files onto themselves");
  else {
    fs.mkdirSync(loc.dir, { recursive: true });
    fs.copyFileSync(path.join(ROOT, "guard.mjs"), path.join(loc.dir, "guard.mjs"));
    syncDir(path.join(ROOT, "src"), path.join(loc.dir, "src"));
    syncDir(path.join(ROOT, "bin"), path.join(loc.dir, "bin"));
    io.log(`  ✔ copied guard.mjs, src/ and bin/ into ${loc.dir}`);
  }

  // 2. the preset
  if (opts.preset) {
    const r = setPresetIn(loc.config, opts.preset);
    if (!r.ok) io.error(`  ! ${r.error}`);
    else io.log(`  ✔ preset ${opts.preset} written to ${loc.config}`);
  }

  // 3. settings.json: only our entry
  const { settings: next, changed } = addHook(settings.data, loc.script);
  let code = 0;
  if (!changed) io.log("  ✔ settings.json already has the guardrails hook");
  else {
    let backup = null;
    fs.mkdirSync(path.dirname(loc.settings), { recursive: true });
    if (settings.status === "ok" && settings.raw !== null) backup = backupSettings(loc.settings);
    writeJsonFile(loc.settings, next, settings.raw);
    io.log(`  ✔ settings.json: PreToolUse hook added${settings.status === "ok" ? " (other settings untouched)" : " (new file)"}`);
    if (backup) io.log(`    backup: ${backup}`);
  }

  // 4. does it work
  if (selfTest(loc, env)) io.log("  ✔ self-test: `rm -rf /` is denied");
  else { io.log("  ✖ self-test failed: the installed hook did not deny `rm -rf /`. Look in the errors.log next to the hook."); code = 1; }

  io.log("");
  io.log("Start a new Claude Code session for the hook to load. `claude-guardrails rules` lists every rule, `claude-guardrails check \"<command>\"` tries one.");
  if (loc.scope === "project") io.log(`Commit .claude/guardrails/ and .claude/settings.json so teammates get the same guard. Without npm: node "${path.join(loc.dir, "bin", "claude-guardrails.mjs")}" <command>`);
  else io.log(`Without npm, from any folder: node "${path.join(loc.dir, "bin", "claude-guardrails.mjs")}" <command>`);
  return code;
}

// ---------------------------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------------------------

/**
 * claude-guardrails uninstall: remove our hook entry and our copy of the scripts. Your rules in
 * guardrails.json stay (unless purge), because they are your decisions, not ours.
 * @param opts { scope = "user", purge = false, cwd?, env? }
 * @returns exit code: 0 done, 1 settings.json could not be parsed (nothing changed)
 */
export function uninstall(opts = {}, io = consoleIO) {
  const env = opts.env || process.env;
  const loc = locations(opts.scope === "project" ? "project" : "user", { cwd: opts.cwd, env });
  const settings = readJsonFile(loc.settings);
  if (settings.status === "invalid") {
    io.error(`${loc.settings} ${settings.error || "cannot be read"}, so nothing was changed.`);
    io.error(`Remove the PreToolUse entry that runs ${path.join("claude-code-guardrails", "guard.mjs")} by hand, then run uninstall again.`);
    return 1;
  }
  io.log(`${NAME} uninstall (${loc.scope} scope)`);
  let did = 0;

  const { settings: next, removed } = removeHook(settings.data || {});
  if (removed) {
    const backup = backupSettings(loc.settings);
    writeJsonFile(loc.settings, next, settings.raw);
    io.log(`  ✔ settings.json: removed the guardrails hook${removed > 1 ? ` (${removed} entries)` : ""}`);
    io.log(`    backup: ${backup}`);
    did++;
  }
  // Only a folder that holds our guard.mjs is ever deleted.
  if (exists(path.join(loc.dir, "guard.mjs"))) {
    if (samePath(ROOT, loc.dir)) io.log(`  - ${loc.dir} is where this command runs from; left in place`);
    else { fs.rmSync(loc.dir, { recursive: true, force: true }); io.log(`  ✔ removed ${loc.dir}`); did++; }
  }
  if (opts.purge && exists(loc.config)) { fs.rmSync(loc.config, { force: true }); io.log(`  ✔ removed ${loc.config}`); did++; }
  else if (exists(loc.config)) io.log(`  - kept ${loc.config} (your rules; add --purge to delete it)`);

  if (!did) io.log("  nothing to remove: the guardrails hook is not installed in this scope.");
  else io.log("\nStart a new Claude Code session; the hook is gone.");
  return 0;
}

