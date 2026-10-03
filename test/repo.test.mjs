// The repository itself: package fields, zero dependencies, manifests, skills, README, and the promises
// this tool makes about tokens (a quiet hook, user-only skills, short reasons).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, readJson } from "./helpers.mjs";
import { CUSTOM, DECISIONS, PRESETS, RULES, RULE_IDS } from "../src/rules.mjs";
import { HOOK_MATCHER, HOOK_TIMEOUT, NAME, VERSION } from "../src/meta.mjs";
import { secretKinds } from "../src/secrets.mjs";

const pkg = readJson(path.join(ROOT, "package.json"));
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
const lines = (text) => text.split("\n");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, "/");
const code = ["guard.mjs", ...["bin", "src", "test"].flatMap((d) => walk(path.join(ROOT, d)).map(rel))].filter((f) => /\.m?js$/.test(f)).map((f) => path.join(ROOT, f));

// Specifiers of static imports, re-exports and dynamic imports with a string literal.
function specifiers(text) {
  const out = [];
  for (const m of text.matchAll(/(?:^|[\s;])(?:import|export)\s+(?:[^"'`;]*?\sfrom\s*)?["']([^"']+)["']/gm)) out.push(m[1]);
  for (const m of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

test("package.json: name, version, module type, bin, files, engines, scripts, links, license", () => {
  assert.equal(pkg.name, "claude-code-guardrails");
  assert.equal(pkg.version, "1.0.0");
  assert.equal(pkg.version, VERSION, "src/meta.mjs VERSION matches (the vendored copy has no package.json)");
  assert.equal(NAME, pkg.name);
  assert.equal(pkg.type, "module");
  assert.ok(pkg.description.length > 40);
  assert.deepEqual(pkg.bin, { "claude-guardrails": "bin/claude-guardrails.mjs" });
  assert.equal(pkg.engines.node, ">=18");
  assert.equal(pkg.scripts.test, "node --test");
  assert.equal(pkg.repository, "github:nrzz/claude-code-guardrails");
  assert.equal(pkg.homepage, "https://github.com/nrzz/claude-code-guardrails#readme");
  assert.equal(pkg.bugs, "https://github.com/nrzz/claude-code-guardrails/issues");
  assert.equal(pkg.author, "Naresh Prabu");
  assert.equal(pkg.license, "MIT");
  for (const k of ["claude-code", "claude", "guardrails", "safety", "hooks"]) assert.ok(pkg.keywords.includes(k), k);
  for (const f of ["guard.mjs", "bin", "src", "hooks", "skills", ".claude-plugin", "README.md", "LICENSE"]) {
    assert.ok(pkg.files.includes(f), `files lists ${f}`);
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
  }
  assert.ok(!pkg.files.includes("test"), "tests are not shipped");
  assert.ok(fs.existsSync(path.join(ROOT, pkg.bin["claude-guardrails"])));
});

test("zero dependencies: no dependency fields, no lockfile, no node_modules, only node: and relative imports", () => {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundledDependencies"]) assert.equal(pkg[field], undefined, field);
  for (const f of ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "node_modules"]) assert.ok(!fs.existsSync(path.join(ROOT, f)), `${f} must not exist`);
  assert.ok(code.length > 20);
  for (const file of code) {
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(text, /\brequire\(/, `${rel(file)} is ESM`);
    for (const spec of specifiers(text)) {
      if (spec.startsWith("node:")) continue;
      assert.ok(spec.startsWith("."), `${rel(file)} imports "${spec}": only node: built-ins and relative files are allowed`);
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), spec)), `${rel(file)} -> ${spec} exists`);
    }
  }
});

test("the hook loads only what it needs, never the command line or the installer, and never prints on its own", () => {
  const seen = new Set();
  const queue = [path.join(ROOT, "guard.mjs")];
  const builtins = new Set();
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, "utf8");
    for (const spec of specifiers(text)) {
      if (spec.startsWith(".")) queue.push(path.resolve(path.dirname(file), spec)); else builtins.add(spec);
    }
    assert.doesNotMatch(text, /console\.(log|error|warn|info)/, `${rel(file)} is on the hook's path and must not print`);
  }
  const files = [...seen].map(rel).sort();
  assert.ok(!files.includes("src/cli.mjs") && !files.includes("src/install.mjs"), files.join(", "));
  assert.deepEqual(files, ["guard.mjs", "src/analyze.mjs", "src/args.mjs", "src/checks.mjs", "src/config.mjs", "src/decide.mjs", "src/files.mjs", "src/fsutil.mjs", "src/gitutil.mjs", "src/hook.mjs", "src/paths.mjs", "src/rules.mjs", "src/secrets.mjs", "src/shell.mjs"]);
  assert.deepEqual([...builtins].sort(), ["node:child_process", "node:fs", "node:os", "node:path"], "no network, no worker threads, no vm");
});

test("code runs on Node 18: none of the newer built-ins are used", () => {
  const newer = /\.(toSorted|toReversed|toSpliced|with)\(|Object\.groupBy|Map\.groupBy|Promise\.withResolvers|fs\.globSync|\.isWellFormed|Array\.fromAsync|URL\.canParse|import\.meta\.(dirname|filename)|\.(union|intersection|difference|isSubsetOf)\(|process\.getBuiltinModule/;
  for (const file of code.filter((f) => !f.includes(`${path.sep}test${path.sep}`))) assert.doesNotMatch(fs.readFileSync(file, "utf8"), newer, rel(file));
});

test("no complete token or key sits in any file of the repository", () => {
  const findings = [];
  for (const file of walk(ROOT)) {
    if (/\.(png|jpg|gif|ico|zip|gz)$/.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    // the pattern file itself holds regular expressions, never matches; the other files must hold no match either
    const kinds = secretKinds(text).filter((k) => k !== "env-secret" && k !== "assigned-secret");
    if (kinds.length) findings.push(`${rel(file)}: ${kinds.join(", ")}`);
  }
  assert.deepEqual(findings, []);
});

test("LICENSE, .gitignore, .gitattributes and the CI workflow", () => {
  const license = read("LICENSE");
  assert.match(license, /^MIT License\n\nCopyright \(c\) 2026 Naresh Prabu/);
  assert.equal(read(".gitignore"), "node_modules/\n*.log\n.DS_Store\n");
  assert.equal(read(".gitattributes"), "* text=auto eol=lf\n");
  const wf = read(".github/workflows/test.yml");
  assert.match(wf, /^name: test\n/);
  assert.match(wf, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(wf, /node: \[20, 22, 24\]/);
  assert.match(wf, /- run: npm test/);
});

test("the plugin: manifest, marketplace and hook registration agree with each other and with the installer", () => {
  const plugin = readJson(path.join(ROOT, ".claude-plugin", "plugin.json"));
  assert.equal(plugin.name, "guardrails");
  assert.equal(plugin.version, pkg.version);
  assert.deepEqual(plugin.author, { name: "Naresh Prabu" });
  assert.equal(plugin.homepage, "https://github.com/nrzz/claude-code-guardrails");
  assert.equal(plugin.repository, "https://github.com/nrzz/claude-code-guardrails");
  assert.equal(plugin.license, "MIT");
  assert.ok(plugin.description.length > 40 && Array.isArray(plugin.keywords));

  const market = readJson(path.join(ROOT, ".claude-plugin", "marketplace.json"));
  assert.equal(market.$schema, "https://anthropic.com/claude-code/marketplace.schema.json");
  assert.equal(market.name, "claude-code-guardrails");
  assert.deepEqual(market.owner, { name: "Naresh Prabu" });
  assert.equal(market.plugins.length, 1);
  assert.deepEqual({ ...market.plugins[0], description: undefined }, { name: "guardrails", description: undefined, author: { name: "Naresh Prabu" }, category: "security", source: "./", homepage: "https://github.com/nrzz/claude-code-guardrails" });

  const hooks = readJson(path.join(ROOT, "hooks", "hooks.json"));
  assert.deepEqual(hooks, { hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/guard.mjs"], timeout: HOOK_TIMEOUT }] }] } });
  assert.equal(HOOK_MATCHER, "Bash|PowerShell|Read|Write|Edit|MultiEdit|NotebookEdit");
  assert.equal(HOOK_TIMEOUT, 10);
});

test("skills are user-only, so they cost no tokens in Claude's skill list, and their descriptions are short", () => {
  const dirs = fs.readdirSync(path.join(ROOT, "skills"));
  assert.deepEqual(dirs.sort(), ["allow", "status"]);
  for (const d of dirs) {
    const text = read("skills", d, "SKILL.md");
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(front, `${d}: front matter`);
    const get = (k) => (new RegExp(`^${k}: (.*)$`, "m").exec(front[1]) || [])[1];
    assert.equal(get("name"), d);
    assert.equal(get("disable-model-invocation"), "true", `${d}: disable-model-invocation`);
    assert.ok(get("description").length < 60, `${d}: description is ${get("description").length} characters`);
    assert.match(text, /\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/claude-guardrails\.mjs/);
  }
});

test("the rule catalog: ids, decisions and reasons", () => {
  assert.ok(RULE_IDS.length >= 30);
  assert.equal(new Set(RULE_IDS).size, RULE_IDS.length, "ids are unique");
  for (const id of RULE_IDS) {
    const r = RULES[id];
    assert.match(id, /^[a-z]+(-[a-z0-9]+)*$/, "kebab-case id");
    assert.ok(r.reason.length > 10 && r.reason.length < 120, `${id}: reason is ${r.reason.length} characters`);
    assert.doesNotMatch(r.reason, /^\s|\s$|\.$/, `${id}: no stray space or full stop`);
    assert.deepEqual(Object.keys(r.decisions), PRESETS, id);
    for (const p of PRESETS) assert.ok(DECISIONS.includes(r.decisions[p]), `${id}/${p}`);
    if (r.floor) assert.deepEqual(Object.values(r.decisions), ["deny", "deny", "deny"], `${id}: a floor rule is denied everywhere`);
  }
  for (const [id, r] of Object.entries(CUSTOM)) assert.ok(r.reason.length < 120, id);
});

test("every rule is stricter (or equal) as the preset gets stricter", () => {
  const rank = (d) => DECISIONS.indexOf(d);
  for (const id of RULE_IDS) {
    const d = RULES[id].decisions;
    assert.ok(rank(d.strict) >= rank(d.balanced), `${id}: strict is at least as strict as balanced`);
    assert.ok(rank(d.balanced) >= rank(d.relaxed), `${id}: balanced is at least as strict as relaxed`);
  }
});

// ---------------------------------------------------------------------------------------------
// The README keeps its promises
// ---------------------------------------------------------------------------------------------

const readme = read("README.md");

test("README: the template's sections, in order, with the badge and the install routes", () => {
  const headings = lines(readme).filter((l) => /^## /.test(l));
  assert.deepEqual(headings, ["## What it costs in tokens", "## Install", "## Use", "## Settings", "## How it works", "## What was verified, and how", "## Files", "## License"]);
  assert.match(readme, /^# Claude Code guardrails\n\n\[!\[test\]\(https:\/\/github\.com\/nrzz\/claude-code-guardrails\/actions\/workflows\/test\.yml\/badge\.svg\)\]\(https:\/\/github\.com\/nrzz\/claude-code-guardrails\/actions\/workflows\/test\.yml\)\n/);
  assert.ok(readme.includes("npx -y github:nrzz/claude-code-guardrails init"));
  assert.ok(readme.includes("/plugin marketplace add nrzz/claude-code-guardrails"));
  assert.ok(readme.includes("/plugin install guardrails@claude-code-guardrails"));
  assert.ok(readme.trimEnd().endsWith("## License\n\nMIT"));
  assert.doesNotMatch(readme, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u, "no emojis");
});

test("README: the token table says 0 for an allowed call and gives the cost of a denial", () => {
  const section = readme.split("## What it costs in tokens")[1].split("\n## ")[0];
  assert.match(section, /\| Part \| Tokens \| \|/);
  assert.match(section, /\| Every allowed call[^|]*\| 0 \|/);
  assert.match(section, /\| A denied call \| about \d+ \|/);
  assert.match(section, /\| An `ask` \| 0 extra \|/);
  const claimed = Number(/\| A denied call \| about (\d+) \|/.exec(section)[1]);
  assert.ok(claimed >= 35 && claimed <= 60);
});

test("README: the rules tables are the catalog, row for row", () => {
  const rows = new Map();
  for (const line of lines(readme)) {
    const m = /^\| `([a-z0-9-]+)` \| (allow|ask|deny) \| (allow|ask|deny) \| (allow|ask|deny) \| (.+) \|$/.exec(line);
    if (m) rows.set(m[1], { strict: m[2], balanced: m[3], relaxed: m[4], reason: m[5] });
  }
  const expected = RULE_IDS.map((id) => `| \`${id}\` | ${RULES[id].decisions.strict} | ${RULES[id].decisions.balanced} | ${RULES[id].decisions.relaxed} | ${RULES[id].reason.replace(/\|/g, "\\|")} |`);
  const found = [...rows.keys()];
  assert.deepEqual(found.sort(), [...RULE_IDS].sort(), "every rule is documented, and nothing else");
  for (const id of RULE_IDS) {
    const r = rows.get(id);
    assert.deepEqual({ strict: r.strict, balanced: r.balanced, relaxed: r.relaxed }, RULES[id].decisions, `${id}: decisions in the README`);
    assert.equal(r.reason.replace(/\\\|/g, "|"), RULES[id].reason, `${id}: reason in the README. Expected row: ${expected[RULE_IDS.indexOf(id)]}`);
  }
  // the tables follow the catalog's grouping
  const groups = [...new Set(RULE_IDS.map((id) => RULES[id].group))];
  for (const g of groups) assert.ok(readme.includes(`#### ${g}\n`), `README has the group "${g}"`);
});

test("README: the commands it shows exist, and the files it lists exist", () => {
  const help = read("src", "cli.mjs");
  for (const cmd of ["init", "uninstall", "check", "rules", "preset", "allow", "status"]) assert.ok(help.includes(`case "${cmd}"`) || help.includes(`${cmd}  `), cmd);
  const section = readme.split("\n## Files\n")[1].split("\n## ")[0];
  for (const f of ["guard.mjs", "src/", "bin/claude-guardrails.mjs", ".claude-plugin/", "hooks/hooks.json", "skills/", "test/"]) assert.ok(section.includes("`" + f + "`"), f);
  for (const f of ["guard.mjs", "src", "bin/claude-guardrails.mjs", ".claude-plugin", "hooks/hooks.json", "skills", "test"]) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test("README: plain sentences, no leftover placeholders", () => {
  assert.doesNotMatch(readme, /TESTCOUNT|TODO|FIXME|XXX|lorem/i);
  assert.doesNotMatch(readme, /\bseamless|\bsupercharge|\bblazing|\bpowerful|\brobust\b|\beffortless/i, "no marketing words");
});
