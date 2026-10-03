// Walks a command line: tokenizes it, looks inside what it runs (bash -c, cmd /c, powershell
// -Command, eval, xargs, find -exec, here-documents piped into a shell, command substitutions),
// strips wrappers such as sudo and env, follows `cd`, and hands each simple command to the checks.
// It never executes anything and only starts git for the cases checks.mjs names.

import { EMPTY, parseArgs, parsePs, shortHas, skipOptions, syntheticWord, vals } from "./args.mjs";
import * as K from "./checks.mjs";
import { branchMatcher, runGit } from "./gitutil.mjs";
import { makePaths } from "./paths.mjs";
import { DEFAULT_PROTECTED_BRANCHES, DEFAULT_PRESET, decisionFor } from "./rules.mjs";
import { isPipe, maskQuoted, pipelineOf, tokenize } from "./shell.mjs";

const MAX_DEPTH = 5;

/** The state of one analysis: settings, where we are, and the findings so far. */
export function createAnalysis({ env, preset = DEFAULT_PRESET, protectedBranches = DEFAULT_PROTECTED_BRANCHES, mayFire } = {}) {
  const paths = makePaths(env);
  const a = {
    env,
    paths,
    preset,
    git: env.git || runGit,
    isProtected: branchMatcher(protectedBranches),
    mayFire: mayFire || ((rule) => decisionFor(rule, preset) !== "allow"), // could this rule change the outcome?
    cwdKey: paths.baseCwd, // where relative paths point right now; null once a `cd` target is unknown
    findings: [],
    segmentTexts: [],
    adds: [], // `git add` commands seen earlier in the line
    branchCache: new Map(),
    add(rule, detail = "", subject = "") { a.findings.push({ rule, detail, subject }); },
  };
  return a;
}

/** Analyze a command line. `dialect` is "posix" for the Bash tool and "powershell" for the PowerShell tool. */
export function analyzeShell(text, dialect, a) {
  run(text, dialect, a, 0);
  return a;
}

function run(text, dialect, a, depth) {
  if (depth > MAX_DEPTH || typeof text !== "string" || !text.trim()) return;
  checkForkBomb(text, dialect, a);
  const { segments } = tokenize(text, dialect);
  // A cd inside ( ... ), $( ... ) or a nested shell does not outlive it: where we are is restored when we leave.
  const outer = [];
  let level = 0;
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k];
    const inside = seg.depth || 0;
    while (level < inside) { outer.push(a.cwdKey); level++; }
    while (level > inside) { a.cwdKey = outer.pop(); level--; }
    a.segmentTexts.push(seg.text);
    for (const sub of seg.subs) { // command substitutions run
      const here = a.cwdKey;
      run(sub, dialect, a, depth + 1);
      a.cwdKey = here;
    }
    runSegment(seg, k, segments, dialect, a, depth, {});
  }
  while (outer.length) a.cwdKey = outer.pop();
}

// A fork bomb is a function that pipes into itself. Looked for with quotes blanked out, so a
// command that only prints one (echo ':(){ :|:& };:') is left alone.
// The windows are bounded ({0,200}) so a long hostile line cannot make the search quadratic.
const FORK_BOMBS = [
  /(?:^|[\s;&|({])([A-Za-z_:][\w:-]{0,40})\s{0,8}\(\s{0,8}\)\s{0,8}\{[^}]{0,200}?(?<![\w:-])\1\s{0,8}\|&?\s{0,8}\1(?![\w:-])[^}]{0,200}\}/,
  /\bfunction\s+([A-Za-z_:][\w:-]{0,40})\s{0,8}(?:\(\s{0,8}\))?\s{0,8}\{[^}]{0,200}?(?<![\w:-])\1\s{0,8}\|&?\s{0,8}\1(?![\w:-])[^}]{0,200}\}/,
  /%0\s{0,8}\|\s{0,8}%0/,
];
function checkForkBomb(text, dialect, a) {
  if (!text.includes("|")) return; // every fork bomb pipes a function into itself
  const masked = maskQuoted(text, dialect);
  if (FORK_BOMBS.some((re) => re.test(masked))) a.add("fork-bomb", "", text.trim().slice(0, 80));
}

// ---------------------------------------------------------------------------------------------
// One simple command: strip what precedes it, then run the checks for its name
// ---------------------------------------------------------------------------------------------

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const POSIX_SKIP = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "{", "}"]);
const POSIX_HEADER = new Set(["for", "case", "select", "function", "in", "fi", "done", "esac"]);
const PS_HEADER = new Set(["if", "elseif", "else", "foreach", "for", "while", "do", "until", "switch", "try", "catch", "finally", "function", "filter", "param"]);

const set = (...x) => new Set(x);
const SUDO_VALUE = set("-u", "-g", "-h", "-p", "-C", "-r", "-t", "-D", "-T", "-U", "--user", "--group", "--host", "--prompt", "--close-from", "--role", "--type", "--chdir", "--command-timeout", "--other-user");
// Commands that run another command: what precedes the real one is skipped.
const WRAPPERS = {
  sudo: { value: SUDO_VALUE }, doas: { value: set("-u", "-C") }, pkexec: { value: set("--user") },
  env: { value: set("-u", "-C", "--unset", "--chdir", "-S", "--split-string"), assignments: true },
  nohup: {}, command: {}, builtin: {}, exec: { value: set("-a") }, time: { value: set("-f", "-o", "--format", "--output") },
  nice: { value: set("-n", "--adjustment") }, ionice: { value: set("-c", "-n", "-p", "-P", "-u") }, setsid: {},
  stdbuf: { value: set("-i", "-o", "-e") }, timeout: { value: set("-k", "-s", "--kill-after", "--signal"), positional: 1 },
  busybox: {}, unbuffer: {}, caffeinate: { value: set("-t", "-w") }, watch: { value: set("-n", "--interval") },
  npx: { value: set("-p", "--package", "--prefix", "--registry", "--cache") }, bunx: {}, pnpx: {}, // npx rimraf /: rimraf runs
};

function unwrap(name, spec, args) {
  if (name === "command" && args.some((w) => /^-[a-zA-Z]*[vV]/.test(w.value))) return null; // command -v only looks a name up
  let i = skipOptions(args, spec.value || EMPTY) + (spec.positional || 0);
  if (spec.assignments) while (i < args.length && ASSIGNMENT.test(args[i].raw)) i++;
  return args.slice(i);
}

/** The words of a command with variable assignments, shell keywords and wrappers removed. */
export function stripPrefix(words, dialect) {
  let ws = words;
  for (let guard = 0; ws.length && guard < 12; guard++) {
    const w = ws[0];
    if (dialect === "posix") {
      // NAME=value, where the value may be quoted (GIT_SSH_COMMAND="ssh -i x") but the name never is
      if (ASSIGNMENT.test(w.raw)) { ws = ws.slice(1); continue; }
      if (!w.quoted && POSIX_HEADER.has(w.value)) return [];
      if (!w.quoted && POSIX_SKIP.has(w.value)) { ws = ws.slice(1); continue; }
    }
    if (dialect === "powershell" && !w.quoted && PS_HEADER.has(w.value.toLowerCase())) return [];
    const name = K.commandName(w.value);
    const spec = Object.prototype.hasOwnProperty.call(WRAPPERS, name) ? WRAPPERS[name] : null;
    if (!spec) break;
    const rest = unwrap(name, spec, ws.slice(1));
    if (!rest) return [];
    ws = rest;
  }
  return ws;
}

const pseudo = (words, text) => ({ op: null, start: 0, end: 0, text, words, redirects: [], heredocs: [], herestrings: [], subs: [] });
const WRITE_REDIRECT = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);

function runSegment(seg, k, segments, dialect, a, depth, extra) {
  const words = stripPrefix(seg.words, dialect);
  const name = words.length ? K.commandName(words[0].value) : "";
  const c = {
    a, seg, k, segments, dialect, depth, extra, words, name, args: words.slice(1),
    nameOf: (s) => { // the command name of another segment, wrappers stripped
      if (s._name === undefined) { const w = stripPrefix(s.words, dialect); s._name = w.length ? K.commandName(w[0].value) : ""; }
      return s._name;
    },
    argsOf: (s) => stripPrefix(s.words, dialect).slice(1), // and its arguments
  };
  for (const r of seg.redirects) if (WRITE_REDIRECT.has(r.op)) K.writeTarget(c, r.target.value);
  if (!name) return;
  K.genericChecks(c);
  if (K.isDiskCommand(name)) K.checkDisk(c);
  for (const fn of HANDLERS.get(name) || []) fn(c);
}

// Run a command given as words (the part after xargs, a find -exec command ...). It is a child process: where we are is not changed by it.
function runWords(c, words, extra = {}, dialect = c.dialect) {
  if (!words.length || c.depth + 1 > MAX_DEPTH) return;
  const here = c.a.cwdKey;
  runSegment(pseudo(words, c.seg.text), -1, [], dialect, c.a, c.depth + 1, extra);
  c.a.cwdKey = here;
}
// Run text as a script. A nested shell is a child process (isolate); eval is the shell itself.
function runText(c, text, dialect, isolate = true) {
  const here = c.a.cwdKey;
  run(text, dialect, c.a, c.depth + 1);
  if (isolate) c.a.cwdKey = here;
}

// ---------------------------------------------------------------------------------------------
// Commands that run other commands
// ---------------------------------------------------------------------------------------------

// The text of a command given as several words: one word is used as it is; several are joined.
const scriptText = (ws) => (ws.length === 1 ? ws[0].value : ws.map((w) => (/\s/.test(w.value) ? `"${w.value}"` : w.value)).join(" "));

// bash -c "script": the first plain word after a flag cluster that holds c
function shellScript(args) {
  let sawC = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i].value;
    if (t === "--") break;
    if (/^[-+][oO]$/.test(t) || t === "--rcfile" || t === "--init-file") { i++; continue; }
    if (/^-[a-zA-Z]+$/.test(t)) { if (t.includes("c")) sawC = true; continue; }
    if (t.startsWith("-")) continue;
    return sawC ? t : null; // the script, or (without -c) a script file we cannot read
  }
  return null;
}

// What a producer writes to its stdout, as far as it can be known: echo and printf text, here-documents.
function payload(seg, dialect) {
  const words = stripPrefix(seg.words, dialect);
  const name = words.length ? K.commandName(words[0].value) : "";
  if (name === "echo" || name === "printf" || name === "write-output") return [vals(parseArgs(words.slice(1)).pos).join(" ")];
  if (name === "cat") return seg.heredocs;
  return [];
}

// Scripts given to a shell on its stdin: here-documents, here-strings, text piped from echo/printf/cat.
function stdinScripts(c) {
  const out = [...c.seg.heredocs, ...c.seg.herestrings];
  if (isPipe(c.seg.op)) {
    const line = pipelineOf(c.segments, c.k);
    for (const s of line.slice(0, line.indexOf(c.seg))) out.push(...payload(s, c.dialect));
  }
  return out;
}

function checkShell(c) {
  const script = shellScript(c.args);
  if (script !== null) return runText(c, script, "posix");
  const { flags, pos } = parseArgs(c.args, set("-o", "-O", "--rcfile", "--init-file"));
  if (pos.length && pos[0].value !== "-" && !shortHas(flags, "s")) return; // runs a script file: nothing to read here
  for (const text of stdinScripts(c)) runText(c, text, "posix");
}

function checkCmdExe(c) {
  const at = c.args.findIndex((w) => /^[/-]{1,2}[ckr]$/i.test(w.value)); // /c, /k, /r, and //c from Git Bash
  if (at >= 0) runText(c, scriptText(c.args.slice(at + 1)), "cmd");
}

const PS_FLAG_VALUE = new Set(["-executionpolicy", "-ep", "-windowstyle", "-w", "-version", "-v", "-outputformat", "-of", "-inputformat", "-if", "-configurationname", "-workingdirectory", "-wd", "-settingsfile", "-psconsolefile"]);
function checkPowerShell(c) {
  const args = c.args;
  for (let i = 0; i < args.length; i++) {
    const t = args[i].value.toLowerCase();
    const p = t.slice(1);
    if (t.startsWith("-") && p && "command".startsWith(p)) return runText(c, scriptText(args.slice(i + 1)), "powershell");
    if (t.startsWith("-") && p && "encodedcommand".startsWith(p) && args[i + 1]) {
      const text = Buffer.from(args[i + 1].value, "base64").toString("utf16le");
      return runText(c, text, "powershell");
    }
    if (t.startsWith("-") && p && "file".startsWith(p)) return; // a script file
    if (PS_FLAG_VALUE.has(t)) { i++; continue; }
    if (t.startsWith("-")) continue;
    return runText(c, scriptText(args.slice(i)), "powershell"); // powershell "Get-Process": the text is the command
  }
}

function checkSu(c) { // su -c "command" [user], script -c "command" file
  const at = c.args.findIndex((w) => w.value === "-c" || w.value === "--command" || /^--command=/.test(w.value));
  if (at < 0) return;
  const w = c.args[at];
  const text = w.value.includes("=") ? w.value.slice(w.value.indexOf("=") + 1) : c.args[at + 1] && c.args[at + 1].value;
  if (text) runText(c, text, "posix");
}

const checkEval = (c) => runText(c, vals(c.args).join(" "), c.dialect, false); // eval runs in the shell itself: a cd stays

const WSL_VALUE = set("-d", "--distribution", "-u", "--user", "--cd", "--distribution-id");
function checkWsl(c) { // wsl [options] [--] command: the command runs in Linux
  const rest = c.args.slice(skipOptions(c.args, WSL_VALUE)).filter((w, i) => !(i === 0 && /^(-e|--exec)$/.test(w.value)));
  runWords(c, rest, {}, "posix");
}

// ssh [options] host command...: the command runs on the other machine, but a disaster is a disaster.
const SSH_VALUE = set("-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w");
function checkSsh(c) {
  const command = parseArgs(c.args, SSH_VALUE).pos.slice(1);
  if (command.length) runText(c, scriptText(command), "posix");
}

// xargs [options] command [args]: the command gets more arguments from stdin, which we cannot see.
const XARGS_VALUE = set("-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--eof", "--replace", "--max-lines", "--max-args", "--max-procs", "--max-chars");
function checkXargs(c) {
  const rest = c.args.slice(skipOptions(c.args, XARGS_VALUE));
  runWords(c, rest, { unknownArgs: true });
}

// find ROOTS EXPRESSION: -delete and -exec are deletes and commands over everything that matches
const FIND_NEUTRAL = set("-type", "-maxdepth", "-mindepth", "-depth", "-xdev", "-mount", "-print", "-print0", "-ls", "-prune", "-delete", "-exec", "-execdir", "-ok", "-okdir", "-o", "-a", "-and", "-or", "-not", "-daystart", "-follow", "-noleaf", "-true", "-false");
function checkFind(c) {
  const args = c.args;
  let start = 0;
  while (start < args.length && /^-[HLP]$/.test(args[start].value)) start++;
  let end = start;
  while (end < args.length && !/^(-|!$|\()/.test(args[end].value)) end++;
  const roots = args.slice(start, end);
  const expr = args.slice(end);
  // Any primary other than the neutral ones narrows what matches. The words of an -exec command are not primaries.
  let filtered = false;
  for (let i = 0; i < expr.length; i++) {
    const t = expr[i].value;
    if (/^-(exec|execdir|ok|okdir)$/.test(t)) { while (i < expr.length && expr[i].value !== ";" && expr[i].value !== "+") i++; continue; }
    if (t.startsWith("-") && !FIND_NEUTRAL.has(t)) filtered = true;
  }
  // With a filter, the targets are matches somewhere under each root, never the root itself.
  const targets = (roots.length ? roots : [syntheticWord(".")]).map((w) => (filtered ? syntheticWord(`${w.value.replace(/[\\/]+$/, "")}/__match__`) : w));

  if (expr.some((w) => w.value === "-delete")) K.evalDelete(c, targets, { recursive: true, filtered: false });
  for (let i = 0; i < expr.length; i++) {
    if (!/^-(exec|execdir|ok|okdir)$/.test(expr[i].value)) continue;
    let j = i + 1;
    while (j < expr.length && expr[j].value !== ";" && expr[j].value !== "+") j++;
    const command = expr.slice(i + 1, j);
    for (const t of targets) {
      runWords(c, command.map((w) => (w.value.includes("{}") ? syntheticWord(w.value.split("{}").join(t.value)) : w)));
    }
    i = j;
  }
}

// cd keeps relative paths honest: `cd /tmp && rm -rf build` deletes /tmp/build, not ./build.
function checkCd(c) {
  const { a, args, dialect, name } = c;
  if (name === "popd") { a.cwdKey = null; return; }
  const target = dialect === "powershell"
    ? (() => { const p = parsePs(args, ["path", "literalpath"], ["passthru"]); return (p.named.get("path") || p.named.get("literalpath") || p.pos)[0]; })()
    : parseArgs(args).pos[0];
  if (!target) { a.cwdKey = a.paths.homeKey; return; }
  if (target.value === "-") { a.cwdKey = null; return; }
  const r = a.paths.resolve(target.value, a.cwdKey);
  a.cwdKey = r.unknown || r.glob ? null : r.key;
}

// ---------------------------------------------------------------------------------------------
// The registry: which function looks at which command
// ---------------------------------------------------------------------------------------------

const HANDLERS = new Map();
function on(names, fn) {
  for (const n of names) {
    if (!HANDLERS.has(n)) HANDLERS.set(n, []);
    HANDLERS.get(n).push(fn);
  }
}
on(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh"], checkShell);
on(["cmd"], checkCmdExe);
on(["powershell", "pwsh"], checkPowerShell);
on(["su", "script"], checkSu);
on(["eval", "iex", "invoke-expression"], checkEval); // eval "rm -rf /", iex "Remove-Item -Recurse C:\\"
on(["wsl"], checkWsl);
on(["ssh"], checkSsh);
on(["xargs"], checkXargs);
on(["find"], checkFind);
on(["cd", "chdir", "pushd", "popd", "set-location", "sl"], checkCd);
on(K.DELETE_NAMES, K.checkDelete);
on(["git"], K.checkGit);
on(K.PUBLISH_NAMES, K.checkPublish);
on(K.INFRA_NAMES, K.checkInfra);
on(K.POWER_NAMES, K.checkPower);
on(K.CHMOD_NAMES, K.checkChmod);
on(K.WRITER_NAMES, K.checkWriters);
on(K.READER_NAMES, K.checkReaders);
