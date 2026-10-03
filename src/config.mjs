// Where things live and what the configuration says.
//
//   <project>/.claude/guardrails.json   committed with the project
//   <configDir>/guardrails.json         yours, for every project (configDir = $CLAUDE_CONFIG_DIR or ~/.claude)
//
//   { "preset": "balanced", "protectedBranches": ["main"], "allow": [...], "deny": [...], "ask": [...] }
//
// The project's preset wins over yours, yours over the default. The lists of both files are joined.
// An entry in allow, deny or ask is a rule id ("git-reset-hard") or a regular expression for a
// command segment or a path.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exists, readJsonFile, writeJsonFile } from "./fsutil.mjs";
import { DEFAULT_PRESET, DEFAULT_PROTECTED_BRANCHES, PRESETS, isRuleId } from "./rules.mjs";

/** Claude Code's config folder: $CLAUDE_CONFIG_DIR, else ~/.claude. */
export function configDir(env = process.env) {
  const custom = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim();
  return path.resolve(custom || path.join(os.homedir(), ".claude"));
}
export const userConfigFile = (env = process.env) => path.join(configDir(env), "guardrails.json");
export const projectConfigFile = (root) => path.join(root, ".claude", "guardrails.json");
/** Our own folder inside Claude's config folder: the installed copy of the scripts and the error log. */
export const guardDir = (cfg) => path.join(cfg, "claude-code-guardrails");

/**
 * The project folder: the nearest folder up the tree that has .git or .claude, else `cwd` itself.
 * The walk never goes above the home folder or the temp folder: ~/.claude is Claude's own folder,
 * not a project marker, and a project under the temp folder belongs to nobody above it.
 */
export function findProjectRoot(cwd, { home = os.homedir(), tmp = os.tmpdir() } = {}) {
  const start = path.resolve(cwd);
  const stops = new Set([home, tmp, realPath(tmp)].map((p) => path.resolve(p)));
  let dir = start;
  for (let i = 0; i < 60; i++) {
    if (stops.has(dir)) break;
    if (exists(path.join(dir, ".git")) || exists(path.join(dir, ".claude"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

function realPath(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

const KNOWN_KEYS = new Set(["preset", "protectedBranches", "allow", "deny", "ask"]);

// One config file, checked. Problems become warnings; the file never makes the hook fail.
function readLayer(file, label, warnings) {
  const r = readJsonFile(file);
  const layer = { file, status: r.status, preset: undefined, protectedBranches: undefined, allow: [], deny: [], ask: [] };
  if (r.status === "missing") return layer;
  if (r.status === "invalid") { warnings.push(`${label} config ${file} ${r.error}; ignored`); return layer; }
  const data = r.data;
  for (const k of Object.keys(data)) if (!KNOWN_KEYS.has(k)) warnings.push(`${label} config: unknown key "${k}"`);
  if (data.preset !== undefined) {
    if (PRESETS.includes(data.preset)) layer.preset = data.preset;
    else warnings.push(`${label} config: preset "${data.preset}" is not one of ${PRESETS.join(", ")}; ignored`);
  }
  for (const k of ["protectedBranches", "allow", "deny", "ask"]) {
    if (data[k] === undefined) continue;
    if (!Array.isArray(data[k])) { warnings.push(`${label} config: "${k}" must be a list; ignored`); continue; }
    const strings = data[k].filter((x) => typeof x === "string" && x.trim());
    if (strings.length !== data[k].length) warnings.push(`${label} config: "${k}" has entries that are not text; skipped`);
    layer[k] = strings;
  }
  return layer;
}

// Entries of allow, deny or ask: rule ids, and regular expressions for everything else.
function compileList(entries, name, warnings) {
  const list = { entries, ids: new Set(), res: [] };
  for (const e of entries) {
    if (isRuleId(e)) { list.ids.add(e); continue; }
    try { list.res.push(new RegExp(e)); } catch { warnings.push(`"${name}" entry ${JSON.stringify(e)} is neither a rule id nor a valid regular expression; ignored`); }
  }
  return list;
}

const unique = (xs) => [...new Set(xs)];

/**
 * The settings in force for a project: { preset, presetSource, protectedBranches, allow, deny, ask,
 * warnings, files }. allow, deny and ask are { entries, ids, res }.
 */
export function loadConfig({ env = process.env, projectDir } = {}) {
  const warnings = [];
  const user = readLayer(userConfigFile(env), "user", warnings);
  const project = projectDir ? readLayer(projectConfigFile(projectDir), "project", warnings) : { file: null, status: "missing", allow: [], deny: [], ask: [] };
  let preset = DEFAULT_PRESET;
  let presetSource = "default";
  if (project.preset) { preset = project.preset; presetSource = "project"; }
  else if (user.preset) { preset = user.preset; presetSource = "user"; }
  const branchesSet = project.protectedBranches !== undefined || user.protectedBranches !== undefined;
  return {
    preset,
    presetSource,
    protectedBranches: branchesSet ? unique([...(project.protectedBranches || []), ...(user.protectedBranches || [])]) : [...DEFAULT_PROTECTED_BRANCHES],
    allow: compileList(unique([...project.allow, ...user.allow]), "allow", warnings),
    deny: compileList(unique([...project.deny, ...user.deny]), "deny", warnings),
    ask: compileList(unique([...project.ask, ...user.ask]), "ask", warnings),
    warnings,
    files: { user: { file: user.file, status: user.status }, project: { file: project.file, status: project.status } },
  };
}

/** A config with the defaults and no files, for tests and for `check` without a project. */
export function defaultConfig(overrides = {}) {
  const warnings = [];
  const base = {
    preset: DEFAULT_PRESET, presetSource: "default", protectedBranches: [...DEFAULT_PROTECTED_BRANCHES],
    allow: compileList([], "allow", warnings), deny: compileList([], "deny", warnings), ask: compileList([], "ask", warnings),
    warnings, files: { user: { file: null, status: "missing" }, project: { file: null, status: "missing" } },
  };
  const out = { ...base, ...overrides };
  for (const k of ["allow", "deny", "ask"]) if (Array.isArray(overrides[k])) out[k] = compileList(overrides[k], k, warnings);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Writing (the allow, preset and init commands)
// ---------------------------------------------------------------------------------------------

/** Change one config file and keep every other key. Refuses a file that is not valid JSON. */
export function updateConfigFile(file, change) {
  const r = readJsonFile(file);
  if (r.status === "invalid") return { ok: false, error: `${file} ${r.error}, so it was left alone` };
  const data = r.data || {};
  const before = JSON.stringify(data);
  change(data);
  const changed = JSON.stringify(data) !== before;
  if (changed || r.status === "missing") writeJsonFile(file, data, r.raw);
  return { ok: true, changed: changed || r.status === "missing", data };
}

export const setPresetIn = (file, preset) => updateConfigFile(file, (d) => { d.preset = preset; });
export function addEntryTo(file, list, entry) {
  return updateConfigFile(file, (d) => {
    const cur = Array.isArray(d[list]) ? d[list] : [];
    if (!cur.includes(entry)) cur.push(entry);
    d[list] = cur;
  });
}
