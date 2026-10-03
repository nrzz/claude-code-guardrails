// Command handlers for `claude-guardrails`. bin/claude-guardrails.mjs is a thin wrapper around main().
import fs from "node:fs";
import path from "node:path";
import { addEntryTo, configDir, guardDir, loadConfig, setPresetIn } from "./config.mjs";
import { TOOLS, decide } from "./decide.mjs";
import { exists, readJsonFile } from "./fsutil.mjs";
import { init, isOurHook, locations, uninstall } from "./install.mjs";
import { realEnvironment } from "./hook.mjs";
import { BIN, NAME, VERSION } from "./meta.mjs";
import { CUSTOM, PRESETS, RULES, RULE_IDS, isRuleId } from "./rules.mjs";

const HELP = `${BIN}: safety presets for Claude Code ${VERSION}

Risky shell commands and file edits are denied (Claude reads why and takes another route) or turned
into a permission prompt. Everything else passes silently and costs no tokens.

Usage: ${BIN} <command> [options]

Set up
  init [--preset strict|balanced|relaxed] [--scope user|project]
                          add the PreToolUse hook (backs up settings.json first). Default scope: user.
                          project copies the scripts into .claude/guardrails/ so teammates get them
  uninstall [--scope user|project] [--purge]
                          remove the hook and our copy of the scripts; --purge also deletes guardrails.json

Rules
  rules [--preset <p>]    every rule and what each preset does with it
  preset [<name>] [--scope user|project]
                          show, or set, the preset (strict, balanced, relaxed)
  allow <rule-id> [--scope project|user]
                          stop guarding one rule. Default scope: project (.claude/guardrails.json)

Try it
  check "<command>" [--tool Bash|PowerShell] [--preset <p>] [--cwd <dir>] [--json]
  check --tool Write|Edit|MultiEdit|NotebookEdit|Read --file <path> [--preset <p>] [--cwd <dir>] [--json]
                          what the hook would do with a command or a file, and why
  status                  the preset in force, where the hook is installed, config problems

Options
  -h, --help              this help
  -v, --version           print the version

The config folder is $CLAUDE_CONFIG_DIR, or ~/.claude when that is not set.
`;

class UsageError extends Error {}

// Tiny argument parser: boolean flags, --name value / --name=value options, positionals.
function parseArgs(args, { flags = [], options = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { out._.push(...args.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (flags.includes(name)) out[name] = true;
      else if (options.includes(name)) {
        const value = eq === -1 ? args[++i] : a.slice(eq + 1);
        if (value === undefined) throw new UsageError(`--${name} needs a value`);
        out[name] = value;
      } else throw new UsageError(`unknown option --${name}`);
    } else if (a === "-h") out.help = true;
    else if (a === "-v") out.version = true;
    else out._.push(a);
  }
  return out;
}

const say = (s = "") => console.log(s);
const fail = (s) => { console.error(s); return 1; };
const needScope = (v, fallback) => {
  const scope = v === undefined ? fallback : v;
  if (scope !== "user" && scope !== "project") throw new UsageError(`--scope must be user or project, not "${scope}"`);
  return scope;
};
const needPreset = (p) => {
  if (!PRESETS.includes(p)) throw new UsageError(`unknown preset "${p}"; use one of: ${PRESETS.join(", ")}`);
  return p;
};

// ---------------------------------------------------------------- check

// check's own options come first; the command is everything from its first word on, so
// `check git reset --hard` works unquoted. A quoted command (one word with spaces) may be
// followed by options: `check "rm -rf build" --preset strict`.
function splitCheckArgs(args) {
  let i = 0;
  while (i < args.length && args[i] !== "--" && args[i].startsWith("--")) {
    const value = !args[i].includes("=") && ["--tool", "--file", "--preset", "--cwd", "--project"].includes(args[i]);
    i += value ? 2 : 1;
  }
  if (args[i] === "--" || i >= args.length) return args;
  const quoted = /\s/.test(args[i]);
  return quoted ? args : [...args.slice(0, i), "--", ...args.slice(i)];
}

function cmdCheck(rawArgs) {
  const args = splitCheckArgs(rawArgs);
  const o = parseArgs(args, { flags: ["json"], options: ["tool", "file", "preset", "cwd", "project"] });
  const tool = o.tool || (o.file ? "Write" : "Bash");
  if (!TOOLS.includes(tool)) throw new UsageError(`unknown --tool "${tool}"; use one of: ${TOOLS.join(", ")}`);
  const fileTool = !["Bash", "PowerShell"].includes(tool);
  let toolInput;
  if (fileTool) {
    if (!o.file) throw new UsageError(`--tool ${tool} needs --file <path>`);
    toolInput = tool === "NotebookEdit" ? { notebook_path: o.file } : { file_path: o.file };
  } else {
    const command = o._.join(" ");
    if (!command.trim()) throw new UsageError('check needs a command: claude-guardrails check "rm -rf build"');
    toolInput = { command };
  }
  const cwd = path.resolve(o.cwd || process.cwd());
  const env = realEnvironment({ cwd });
  if (o.project) { env.projectDir = path.resolve(o.project); env.projectDirs = [env.projectDir]; }
  const config = loadConfig({ env: process.env, projectDir: env.projectDir });
  if (o.preset) { config.preset = needPreset(o.preset); config.presetSource = "--preset"; }
  const result = decide({ tool_name: tool, tool_input: toolInput, cwd }, { env, config });

  if (o.json) { say(JSON.stringify({ ...result, preset: config.preset })); return 0; }
  if (result.decision === "allow") {
    say(`allow  (nothing matched; preset ${config.preset})`);
    return 0;
  }
  say(`${result.decision}  ${result.rule}  (preset ${config.preset})`);
  say(`  ${result.reason}`);
  const others = result.findings.filter((f) => f.rule !== result.rule && f.decision !== "allow");
  if (others.length) say(`  also: ${others.map((f) => `${f.rule} (${f.decision})`).join(", ")}`);
  return 0;
}

// ---------------------------------------------------------------- rules

function cmdRules(args) {
  const o = parseArgs(args, { options: ["preset"] });
  const only = o.preset ? needPreset(o.preset) : null;
  const cols = only ? [only] : PRESETS;
  const idW = Math.max(...RULE_IDS.map((i) => i.length)) + 1;
  const head = `${"rule".padEnd(idW)}  ${cols.map((c) => c.padEnd(8)).join(" ")}  what`;
  let group = "";
  say(head);
  for (const id of RULE_IDS) {
    const r = RULES[id];
    if (r.group !== group) { group = r.group; say(`\n${group}`); }
    say(`${(id + (r.floor ? "*" : "")).padEnd(idW)}  ${cols.map((c) => r.decisions[c].padEnd(8)).join(" ")}  ${r.reason}`);
  }
  say("\n* always blocked: no pattern in guardrails.json switches these off, only the exact rule id does");
  say(`Your own patterns in guardrails.json add ${Object.keys(CUSTOM).join(" and ")}.`);
  return 0;
}

// ---------------------------------------------------------------- preset, allow

function cmdPreset(args) {
  const o = parseArgs(args, { options: ["scope"] });
  const cwd = process.cwd();
  if (!o._.length) {
    const env = realEnvironment({ cwd });
    const config = loadConfig({ env: process.env, projectDir: env.projectDir });
    say(`${config.preset}  (from ${config.presetSource === "default" ? "the default" : `the ${config.presetSource} config`})`);
    say(`presets: ${PRESETS.join(", ")}; set one with: ${BIN} preset <name> [--scope user|project]`);
    return 0;
  }
  const preset = needPreset(o._[0]);
  const loc = locations(needScope(o.scope, "user"), { cwd });
  const r = setPresetIn(loc.config, preset);
  if (!r.ok) return fail(r.error);
  say(`preset ${preset} set in ${loc.config}`);
  if (loc.scope === "user") say("(a preset in a project's .claude/guardrails.json still wins over this one)");
  return 0;
}

function suggest(id) {
  const part = id.split("-")[0];
  return RULE_IDS.filter((r) => r.includes(id) || id.includes(r) || (part.length > 2 && r.startsWith(part))).slice(0, 5);
}

function cmdAllow(args) {
  const o = parseArgs(args, { options: ["scope"] });
  const id = o._[0];
  if (!id) throw new UsageError(`allow needs a rule id, for example: ${BIN} allow git-reset-hard`);
  if (!isRuleId(id)) {
    const s = suggest(id);
    return fail(`Unknown rule "${id}".${s.length ? ` Did you mean: ${s.join(", ")}?` : ""} \`${BIN} rules\` lists them all.`);
  }
  const loc = locations(needScope(o.scope, "project"), { cwd: process.cwd() });
  const r = addEntryTo(loc.config, "allow", id);
  if (!r.ok) return fail(r.error);
  say(`allowed ${id} in ${loc.config}`);
  if (RULES[id].floor) say(`note: ${id} is an always-blocked rule; this removes that protection (only the exact rule id can).`);
  if (loc.scope === "project") say("(this file is committed with the project, so it applies to your teammates too)");
  return 0;
}

// ---------------------------------------------------------------- status

// Is our hook in this settings file?
function hookIn(file) {
  const r = readJsonFile(file);
  if (r.status === "missing") return { state: "no settings file" };
  if (r.status === "invalid") return { state: `${r.error}` };
  const groups = r.data.hooks && Array.isArray(r.data.hooks.PreToolUse) ? r.data.hooks.PreToolUse : [];
  const mine = groups.flatMap((g) => (g && Array.isArray(g.hooks) ? g.hooks.filter(isOurHook) : []));
  if (!mine.length) return { state: "not installed" };
  return { state: "installed", script: (mine[0].args && mine[0].args[0]) || mine[0].command };
}

function cmdStatus() {
  const cwd = process.cwd();
  const env = realEnvironment({ cwd });
  const config = loadConfig({ env: process.env, projectDir: env.projectDir });
  const cfg = configDir();
  const row = (label, text) => say(`${label.padEnd(18)}${text}`);
  say(`${NAME} ${VERSION}`);
  row("preset", `${config.preset} (${config.presetSource === "default" ? "the default" : `${config.presetSource} config`})`);
  row("protected", config.protectedBranches.join(", ") || "(none)");
  for (const [scope, file] of [["user", path.join(cfg, "settings.json")], ["project", path.join(env.projectDir, ".claude", "settings.json")]]) {
    const h = hookIn(file);
    let line = h.state;
    if (h.state === "installed") {
      const real = scope === "project" ? String(h.script).replace("${CLAUDE_PROJECT_DIR}", env.projectDir) : h.script;
      line = `installed -> ${h.script}${exists(real) ? "" : "  (script is missing: run init again)"}`;
    }
    row(`hook (${scope})`, line);
  }
  row("", "a hook that comes with the plugin is not listed here; /plugin shows it");
  for (const [scope, f] of [["user", config.files.user], ["project", config.files.project]]) row(`config (${scope})`, `${f.file || "-"}  ${f.status}`);
  for (const k of ["allow", "deny", "ask"]) if (config[k].entries.length) row(k, config[k].entries.join("  "));
  for (const w of config.warnings) row("warning", w);
  const log = path.join(guardDir(cfg), "errors.log");
  if (exists(log)) {
    const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
    row("errors.log", `${lines.length} line(s) in ${log}; last: ${lines[lines.length - 1].slice(0, 160)}`);
  } else row("errors.log", "none");
  return 0;
}

// ---------------------------------------------------------------- main

export async function main(argv) {
  try {
    const [cmd, ...rest] = argv;
    if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") { say(HELP); return cmd ? 0 : 1; }
    if (cmd === "-v" || cmd === "--version" || cmd === "version") { say(VERSION); return 0; }
    switch (cmd) {
      case "init": {
        const o = parseArgs(rest, { options: ["preset", "scope"] });
        return init({ scope: needScope(o.scope, "user"), preset: o.preset ? needPreset(o.preset) : undefined, cwd: process.cwd() });
      }
      case "uninstall": {
        const o = parseArgs(rest, { flags: ["purge"], options: ["scope"] });
        return uninstall({ scope: needScope(o.scope, "user"), purge: !!o.purge, cwd: process.cwd() });
      }
      case "check": return cmdCheck(rest);
      case "rules": return cmdRules(rest);
      case "preset": return cmdPreset(rest);
      case "allow": return cmdAllow(rest);
      case "status": return cmdStatus();
      default: return fail(`Unknown command "${cmd}". Run \`${BIN} --help\`.`);
    }
  } catch (e) {
    if (e instanceof UsageError) return fail(`${BIN}: ${e.message}`);
    return fail(`${BIN}: ${e && e.message ? e.message : e}`);
  }
}

