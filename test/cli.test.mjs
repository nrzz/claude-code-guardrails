// The command line: check, rules, preset, allow, status, help. Each command runs as a separate process
// in a throwaway config folder and project.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readJson, runCli, world } from "./helpers.mjs";
import { RULE_IDS, RULES } from "../src/rules.mjs";
import { VERSION } from "../src/meta.mjs";

const cli = (w, args, opts = {}) => runCli(w, args, { cwd: w.proj, ...opts });

test("--help lists every command; no command prints it and fails; unknown commands fail", () => {
  const w = world();
  const help = cli(w, ["--help"]);
  assert.equal(help.status, 0);
  for (const word of ["init", "uninstall", "check", "rules", "preset", "allow", "status", "--scope", "--preset"]) assert.ok(help.stdout.includes(word), word);
  assert.equal(cli(w, []).status, 1);
  assert.match(cli(w, []).stdout, /Usage: claude-guardrails/);
  const bad = cli(w, ["frobnicate"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown command "frobnicate"/);
  assert.equal(cli(w, ["-h"]).status, 0);
  assert.equal(cli(w, ["help"]).status, 0);
});

test("--version prints the package version", () => {
  const w = world();
  assert.equal(cli(w, ["--version"]).stdout.trim(), VERSION);
  assert.equal(cli(w, ["-v"]).stdout.trim(), VERSION);
});

test("check prints the decision, the rule and the exact message", () => {
  const w = world();
  const deny = cli(w, ["check", "rm -rf /"]);
  assert.equal(deny.status, 0);
  assert.equal(deny.stdout, "deny  rm-root  (preset balanced)\n  guardrails: recursive delete of a filesystem root, home folder, system folder or the whole project [/] (rule rm-root). If this is intended, ask the user to allow it: claude-guardrails allow rm-root\n");
  const ask = cli(w, ["check", "git reset --hard"]);
  assert.equal(ask.stdout, "ask  git-reset-hard  (preset balanced)\n  guardrails: git reset --hard throws away uncommitted work (rule git-reset-hard)\n");
  assert.equal(cli(w, ["check", "ls -la"]).stdout, "allow  (nothing matched; preset balanced)\n");
});

test("check takes the command as several words, and after -- anything", () => {
  const w = world();
  assert.match(cli(w, ["check", "--", "git", "push", "--force", "origin", "main"]).stdout, /^deny {2}git-force-push-protected/);
  assert.match(cli(w, ["check", "git", "reset", "--hard"]).stdout, /^ask {2}git-reset-hard/, "no quotes and no -- needed");
  assert.match(cli(w, ["check", "--preset", "relaxed", "git", "reset", "--hard"]).stdout, /^allow/, "options come before the command");
  assert.match(cli(w, ["check", "git reset --hard", "--preset", "relaxed"]).stdout, /^allow/, "a quoted command may be followed by options");
  assert.match(cli(w, ["check", "--json", "rm", "-rf", "/"]).stdout, /"rule":"rm-root"/);
});

test("check --preset shows what another preset would do", () => {
  const w = world();
  assert.match(cli(w, ["check", "--preset", "relaxed", "git reset --hard"]).stdout, /^allow {2}\(nothing matched; preset relaxed\)/);
  // (the sandbox is under the temp folder, so "outside the project" has to be somewhere else)
  assert.match(cli(w, ["check", "--preset", "strict", "rm -rf /opt/guardrails-outside"]).stdout, /^deny {2}rm-outside-project {2}\(preset strict\)/);
  assert.match(cli(w, ["check", "--preset", "balanced", "rm -rf /opt/guardrails-outside"]).stdout, /^ask/);
  const bad = cli(w, ["check", "--preset", "paranoid", "ls"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown preset "paranoid"/);
});

test("check --json is machine readable", () => {
  const w = world();
  const j = JSON.parse(cli(w, ["check", "--json", "git push --force origin main"]).stdout);
  assert.equal(j.decision, "deny");
  assert.equal(j.rule, "git-force-push-protected");
  assert.equal(j.preset, "balanced");
  assert.deepEqual(j.findings, [{ rule: "git-force-push-protected", detail: "main", decision: "deny" }]);
  assert.equal(JSON.parse(cli(w, ["check", "--json", "ls"]).stdout).decision, "allow");
});

test("check --tool Write --file checks a path; Read, Edit, MultiEdit, NotebookEdit and PowerShell too", () => {
  const w = world();
  assert.match(cli(w, ["check", "--tool", "Write", "--file", path.join(w.proj, ".env")]).stdout, /^deny {2}secret-file-write/);
  assert.match(cli(w, ["check", "--tool", "Write", "--file", ".env"]).stdout, /^deny {2}secret-file-write/, "relative to the working folder");
  assert.match(cli(w, ["check", "--tool", "Read", "--file", path.join(w.proj, ".env")]).stdout, /^ask {2}secret-file-read/);
  assert.match(cli(w, ["check", "--tool", "Edit", "--file", path.join(w.proj, "package-lock.json")]).stdout, /^ask {2}lockfile-edit/);
  assert.match(cli(w, ["check", "--tool", "MultiEdit", "--file", path.join(w.proj, ".git", "config")]).stdout, /^deny {2}git-dir-write/);
  assert.match(cli(w, ["check", "--tool", "NotebookEdit", "--file", path.join(w.proj, ".env")]).stdout, /^deny/);
  assert.match(cli(w, ["check", "--file", path.join(w.proj, "src", "a.js")]).stdout, /^allow/, "--file alone means Write");
  assert.match(cli(w, ["check", "--tool", "PowerShell", "Remove-Item -Recurse -Force /"]).stdout, /^deny {2}rm-root/);
});

test("check reads your config files, so you can try a rule before relying on it", () => {
  const w = world();
  assert.match(cli(w, ["check", "make deploy"]).stdout, /^allow/);
  fs.mkdirSync(path.join(w.proj, ".claude"));
  fs.writeFileSync(path.join(w.proj, ".claude", "guardrails.json"), JSON.stringify({ deny: ["^make deploy"] }));
  assert.match(cli(w, ["check", "make deploy"]).stdout, /^deny {2}custom-deny/);
  assert.match(cli(w, ["check", "--project", w.root, "make deploy"]).stdout, /^allow/, "--project points at another project");
});

test("check --cwd decides relative paths from another folder", () => {
  const w = world();
  const sub = path.join(w.proj, "src");
  fs.mkdirSync(sub);
  assert.match(cli(w, ["check", "--cwd", sub, "rm -rf .."]).stdout, /^deny {2}rm-root/);
  assert.match(cli(w, ["check", "--cwd", sub, "rm -rf ../dist"]).stdout, /^allow/);
});

test("check without what to check, with an unknown tool or an unknown option is a usage error", () => {
  const w = world();
  assert.equal(cli(w, ["check"]).status, 1);
  assert.match(cli(w, ["check"]).stderr, /check needs a command/);
  assert.match(cli(w, ["check", "--tool", "Write"]).stderr, /--tool Write needs --file/);
  assert.match(cli(w, ["check", "--tool", "Frob", "x"]).stderr, /unknown --tool "Frob"/);
  assert.match(cli(w, ["check", "--bogus", "x"]).stderr, /unknown option --bogus/);
});

test("rules lists every rule with the three presets, marks the always-blocked ones", () => {
  const w = world();
  const r = cli(w, ["rules"]);
  assert.equal(r.status, 0);
  for (const id of RULE_IDS) assert.ok(r.stdout.includes(id), id);
  const row = (id) => r.stdout.split("\n").find((l) => l.startsWith(id + (RULES[id].floor ? "*" : " ")));
  assert.match(row("rm-root"), /^rm-root\* +deny +deny +deny +recursive delete/);
  assert.match(row("git-reset-hard"), /^git-reset-hard +ask +ask +allow +git reset --hard/);
  assert.match(row("publish"), /^publish +ask +ask +allow/);
  assert.match(row("sql-destructive"), /^sql-destructive +deny +ask +ask/);
  assert.match(r.stdout, /always blocked: no pattern in guardrails\.json switches these off/);
  const one = cli(w, ["rules", "--preset", "strict"]);
  assert.match(one.stdout.split("\n")[0], /^rule +strict +what$/);
  assert.match(cli(w, ["rules", "--preset", "nope"]).stderr, /unknown preset/);
});

test("preset shows the preset in force and where it comes from, and sets it for a scope", () => {
  const w = world();
  assert.match(cli(w, ["preset"]).stdout, /^balanced {2}\(from the default\)/);
  const set = cli(w, ["preset", "strict"]);
  assert.equal(set.status, 0, set.out);
  assert.deepEqual(readJson(path.join(w.cfg, "guardrails.json")), { preset: "strict" });
  assert.match(cli(w, ["preset"]).stdout, /^strict {2}\(from the user config\)/);
  assert.equal(cli(w, ["preset", "relaxed", "--scope", "project"]).status, 0);
  assert.deepEqual(readJson(path.join(w.proj, ".claude", "guardrails.json")), { preset: "relaxed" });
  assert.match(cli(w, ["preset"]).stdout, /^relaxed {2}\(from the project config\)/, "the project's wins");
  assert.match(cli(w, ["preset", "paranoid"]).stderr, /unknown preset "paranoid"/);
  assert.match(cli(w, ["preset", "strict", "--scope", "everywhere"]).stderr, /--scope must be user or project/);
});

test("preset keeps other keys and refuses a broken file", () => {
  const w = world();
  fs.writeFileSync(path.join(w.cfg, "guardrails.json"), JSON.stringify({ allow: ["git-clean"] }));
  assert.equal(cli(w, ["preset", "strict"]).status, 0);
  assert.deepEqual(readJson(path.join(w.cfg, "guardrails.json")), { allow: ["git-clean"], preset: "strict" });
  fs.writeFileSync(path.join(w.cfg, "guardrails.json"), "{ broken");
  const r = cli(w, ["preset", "relaxed"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /left alone/);
  assert.equal(fs.readFileSync(path.join(w.cfg, "guardrails.json"), "utf8"), "{ broken");
});

test("allow adds a rule to the project's file by default, once, and check then agrees", () => {
  const w = world();
  assert.match(cli(w, ["check", "git reset --hard"]).stdout, /^ask/);
  const r = cli(w, ["allow", "git-reset-hard"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /allowed git-reset-hard in .*guardrails\.json/);
  assert.match(r.stdout, /committed with the project/);
  assert.deepEqual(readJson(path.join(w.proj, ".claude", "guardrails.json")), { allow: ["git-reset-hard"] });
  cli(w, ["allow", "git-reset-hard"]);
  assert.deepEqual(readJson(path.join(w.proj, ".claude", "guardrails.json")), { allow: ["git-reset-hard"] }, "no duplicate");
  assert.match(cli(w, ["check", "git reset --hard"]).stdout, /^allow/);
  assert.match(cli(w, ["check", "git clean -fd"]).stdout, /^ask/, "only that rule");
});

test("allow --scope user writes to your own file", () => {
  const w = world();
  assert.equal(cli(w, ["allow", "publish", "--scope", "user"]).status, 0);
  assert.deepEqual(readJson(path.join(w.cfg, "guardrails.json")), { allow: ["publish"] });
  assert.ok(!fs.existsSync(path.join(w.proj, ".claude", "guardrails.json")));
});

test("allow rejects unknown rules with suggestions, and warns about always-blocked ones", () => {
  const w = world();
  const unknown = cli(w, ["allow", "git-reset"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown rule "git-reset"\. Did you mean: .*git-reset-hard/);
  assert.match(cli(w, ["allow", "banana"]).stderr, /Unknown rule "banana"/);
  assert.match(cli(w, ["allow"]).stderr, /allow needs a rule id/);
  const floor = cli(w, ["allow", "rm-root"]);
  assert.equal(floor.status, 0);
  assert.match(floor.stdout, /note: rm-root is an always-blocked rule/);
  assert.match(cli(w, ["check", "rm -rf /"]).stdout, /^allow/, "the exact id works");
});

test("status before and after init", () => {
  const w = world();
  const before = cli(w, ["status"]);
  assert.equal(before.status, 0);
  assert.match(before.stdout, new RegExp(`^claude-code-guardrails ${VERSION.replace(/\./g, "\\.")}`));
  assert.match(before.stdout, /preset +balanced \(the default\)/);
  assert.match(before.stdout, /protected +main, master, release\/\*, production/);
  assert.match(before.stdout, /hook \(user\) +no settings file/);
  assert.match(before.stdout, /errors\.log +none/);
  assert.equal(cli(w, ["init"]).status, 0);
  const after = cli(w, ["status"]);
  assert.match(after.stdout, /hook \(user\) +installed -> .*claude-code-guardrails.guard\.mjs$/m);
  assert.ok(!/script is missing/.test(after.stdout));
  fs.rmSync(path.join(w.cfg, "claude-code-guardrails", "guard.mjs"));
  assert.match(cli(w, ["status"]).stdout, /script is missing: run init again/);
});

test("status shows project installs, lists, warnings and the last logged error", () => {
  const w = world();
  assert.equal(cli(w, ["init", "--scope", "project", "--preset", "strict"]).status, 0);
  fs.writeFileSync(path.join(w.cfg, "guardrails.json"), JSON.stringify({ allow: ["git-clean"], deny: ["^make deploy", "("], protectedBranches: ["develop"] }));
  fs.mkdirSync(path.join(w.cfg, "claude-code-guardrails"), { recursive: true });
  fs.writeFileSync(path.join(w.cfg, "claude-code-guardrails", "errors.log"), "2026-10-04T10:00:00.000Z Error: first\n2026-10-04T10:05:00.000Z Error: boom\n");
  const s = cli(w, ["status"]).stdout;
  assert.match(s, /preset +strict \(project config\)/);
  assert.match(s, /protected +develop/);
  assert.match(s, /hook \(project\) +installed -> \$\{CLAUDE_PROJECT_DIR\}\/\.claude\/guardrails\/guard\.mjs/);
  assert.match(s, /allow +git-clean/);
  assert.match(s, /deny +\^make deploy {2}\(/);
  assert.match(s, /warning +"deny" entry "\(" is neither a rule id nor a valid regular expression/);
  assert.match(s, /errors\.log +2 line\(s\) in .*; last: 2026-10-04T10:05:00\.000Z Error: boom/);
});

test("the command line never touches anything outside the sandbox", () => {
  const w = world();
  const real = process.env.CLAUDE_CONFIG_DIR;
  assert.ok(real.startsWith(path.dirname(w.root)) || real.includes("gr-t-"), "the test process itself runs against a throwaway config folder");
  cli(w, ["init"]);
  cli(w, ["allow", "publish"]);
  cli(w, ["preset", "strict"]);
  cli(w, ["uninstall", "--purge"]);
  assert.deepEqual(fs.readdirSync(w.home), [], "the home folder stays empty");
});
