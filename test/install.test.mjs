// init and uninstall: the hook entry in settings.json, backups, dedupe, round trips, both scopes.
// Everything runs in throwaway config folders and projects, never the real ~/.claude.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, ls, readJson, runCli, runNode, world } from "./helpers.mjs";
import { addHook, hookEntry, isOurHook, removeHook, shapeProblem } from "../src/install.mjs";
import { HOOK_MATCHER, HOOK_TIMEOUT } from "../src/meta.mjs";

const MATCHER = "Bash|PowerShell|Read|Write|Edit|MultiEdit|NotebookEdit";
const settingsOf = (w) => path.join(w.cfg, "settings.json");
const guardOf = (w) => path.join(w.cfg, "claude-code-guardrails", "guard.mjs");
const backups = (dir, base = "settings.json") => ls(dir).filter((f) => f.startsWith(`${base}.bak-guardrails-`));

// A settings file with plenty of other things in it, so "touches only its own entry" means something.
const RICH = {
  model: "opus",
  permissions: { allow: ["Bash(npm test:*)"], deny: ["Read(./.env)"] },
  env: { FOO: "bar" },
  statusLine: { type: "command", command: "node status.mjs" },
  hooks: {
    SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "node", args: ["start.mjs"] }] }],
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "node", args: ["/opt/other-guard/check.mjs"], timeout: 5 }] },
      { hooks: [{ type: "command", command: "echo before-everything" }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
  },
};

test("the hook entry: exec form, the matcher and the timeout from the spec", () => {
  assert.equal(HOOK_MATCHER, MATCHER);
  assert.equal(HOOK_TIMEOUT, 10);
  assert.deepEqual(hookEntry("/x/guard.mjs"), { type: "command", command: "node", args: ["/x/guard.mjs"], timeout: 10 });
});

// ---------------------------------------------------------------------------------------------
// user scope
// ---------------------------------------------------------------------------------------------

test("init (user scope) in an empty config folder: copies the scripts, writes one entry, proves it works", () => {
  const w = world();
  const r = runCli(w, ["init"], { cwd: w.proj });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /copied guard\.mjs, src\/ and bin\//);
  assert.match(r.out, /PreToolUse hook added \(new file\)/);
  assert.match(r.out, /self-test: `rm -rf \/` is denied/);
  assert.deepEqual(readJson(settingsOf(w)), { hooks: { PreToolUse: [{ matcher: MATCHER, hooks: [{ type: "command", command: "node", args: [guardOf(w)], timeout: 10 }] }] } });
  assert.deepEqual(backups(w.cfg), [], "no backup when there was nothing to back up");
  for (const f of ["guard.mjs", "src/hook.mjs", "src/decide.mjs", "src/shell.mjs", "bin/claude-guardrails.mjs"]) assert.ok(fs.existsSync(path.join(w.cfg, "claude-code-guardrails", f)), f);
  // the installed copy runs on its own
  const ev = JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf ~" }, cwd: w.proj });
  assert.equal(JSON.parse(runNode(guardOf(w), [], { w, input: ev }).stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(ls(w.cfg).filter((f) => !["settings.json", "claude-code-guardrails"].includes(f)), [], "nothing else was written to the config folder");
});

test("init keeps every other setting and every other hook, and backs the file up first", () => {
  const w = world();
  fs.writeFileSync(settingsOf(w), JSON.stringify(RICH, null, 4) + "\n");
  const before = fs.readFileSync(settingsOf(w), "utf8");
  const r = runCli(w, ["init"], { cwd: w.proj });
  assert.equal(r.status, 0, r.out);
  const after = readJson(settingsOf(w));
  const { PreToolUse, ...otherHooks } = after.hooks;
  assert.deepEqual({ ...after, hooks: otherHooks }, { ...RICH, hooks: { SessionStart: RICH.hooks.SessionStart, Stop: RICH.hooks.Stop } }, "nothing but PreToolUse changed");
  assert.deepEqual(PreToolUse.slice(0, 2), RICH.hooks.PreToolUse, "the existing PreToolUse hooks stay first and unchanged");
  assert.deepEqual(PreToolUse[2], { matcher: MATCHER, hooks: [hookEntry(guardOf(w))] });
  const [backup] = backups(w.cfg);
  assert.match(backup, /^settings\.json\.bak-guardrails-\d{8}-\d{6}(-\d+)?$/);
  assert.equal(fs.readFileSync(path.join(w.cfg, backup), "utf8"), before, "the backup is the original, byte for byte");
  assert.match(fs.readFileSync(settingsOf(w), "utf8"), /^ {4}"model"/m, "the file's own 4-space indentation is kept");
  assert.ok(r.out.includes(path.join(w.cfg, backup)), "the backup path is printed");
});

test("a settings.json written with tabs and Windows line endings keeps both", () => {
  const w = world();
  const original = JSON.stringify({ model: "opus", env: { A: "1" } }, null, "\t").replace(/\n/g, "\r\n") + "\r\n";
  fs.writeFileSync(settingsOf(w), original);
  assert.equal(runCli(w, ["init"], { cwd: w.proj }).status, 0);
  const after = fs.readFileSync(settingsOf(w), "utf8");
  assert.ok(after.includes("\r\n") && !/[^\r]\n/.test(after), "every line ends with CRLF");
  assert.match(after, /^\t"model"/m, "tab indentation");
  assert.equal(readJson(settingsOf(w)).model, "opus");
  assert.equal(fs.readFileSync(path.join(w.cfg, backups(w.cfg)[0]), "utf8"), original, "the backup is the original");
  assert.equal(runCli(w, ["uninstall"], { cwd: w.proj }).status, 0);
  assert.deepEqual(readJson(settingsOf(w)), { model: "opus", env: { A: "1" } });
});

test("init twice: one entry, no second backup, and it says so", () => {
  const w = world();
  fs.writeFileSync(settingsOf(w), JSON.stringify(RICH, null, 2) + "\n");
  assert.equal(runCli(w, ["init"], { cwd: w.proj }).status, 0);
  const once = fs.readFileSync(settingsOf(w), "utf8");
  const nBackups = backups(w.cfg).length;
  const again = runCli(w, ["init"], { cwd: w.proj });
  assert.equal(again.status, 0, again.out);
  assert.match(again.out, /settings\.json already has the guardrails hook/);
  assert.equal(fs.readFileSync(settingsOf(w), "utf8"), once, "the file is not rewritten");
  assert.equal(backups(w.cfg).length, nBackups, "no new backup");
  const ours = readJson(settingsOf(w)).hooks.PreToolUse.flatMap((g) => g.hooks).filter(isOurHook);
  assert.equal(ours.length, 1);
});

test("init replaces an entry of ours that points somewhere else, and drops duplicates", () => {
  const w = world();
  const stale = { type: "command", command: "node", args: [path.join(w.root, "old", "claude-code-guardrails", "guard.mjs")], timeout: 3 };
  const settings = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [stale, { type: "command", command: "echo keep" }] }, { matcher: MATCHER, hooks: [stale] }] } };
  fs.writeFileSync(settingsOf(w), JSON.stringify(settings, null, 2));
  assert.equal(runCli(w, ["init"], { cwd: w.proj }).status, 0);
  const groups = readJson(settingsOf(w)).hooks.PreToolUse;
  assert.deepEqual(groups, [{ matcher: "Bash", hooks: [{ type: "command", command: "echo keep" }] }, { matcher: MATCHER, hooks: [hookEntry(guardOf(w))] }]);
  assert.equal(backups(w.cfg).length, 1);
});

test("a settings.json that is not valid JSON is left alone: exit 1, the snippet to add by hand, nothing copied", () => {
  const w = world();
  const broken = '{ "model": "opus", }';
  fs.writeFileSync(settingsOf(w), broken);
  const r = runCli(w, ["init"], { cwd: w.proj });
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(settingsOf(w), "utf8"), broken, "untouched, byte for byte");
  assert.deepEqual(backups(w.cfg), []);
  assert.match(r.stderr, /is not valid JSON, so I left everything untouched/);
  assert.match(r.stderr, /"PreToolUse"/);
  assert.ok(r.stderr.includes(JSON.stringify(guardOf(w)).slice(1, -1)), "the snippet names the script path");
  assert.ok(!fs.existsSync(path.join(w.cfg, "claude-code-guardrails")), "nothing was copied either");
});

test("settings.json in an odd shape is left alone too", () => {
  for (const [content, why] of [["[]", /not a JSON object/], ['{"hooks": []}', /"hooks" is not an object/], ['{"hooks": {"PreToolUse": {}}}', /"hooks.PreToolUse" is not a list/], ['"text"', /not a JSON object/]]) {
    const w = world();
    fs.writeFileSync(settingsOf(w), content);
    const r = runCli(w, ["init"], { cwd: w.proj });
    assert.equal(r.status, 1, content);
    assert.equal(fs.readFileSync(settingsOf(w), "utf8"), content);
    assert.match(r.stderr, why);
  }
  assert.equal(shapeProblem({ hooks: { PreToolUse: [] } }), "");
  assert.equal(shapeProblem({}), "");
});

test("an empty settings.json file counts as an empty object", () => {
  const w = world();
  fs.writeFileSync(settingsOf(w), "");
  assert.equal(runCli(w, ["init"], { cwd: w.proj }).status, 0);
  assert.equal(readJson(settingsOf(w)).hooks.PreToolUse.length, 1);
});

test("uninstall removes exactly what init added: round trip", () => {
  const w = world();
  fs.writeFileSync(settingsOf(w), JSON.stringify(RICH, null, 2) + "\n");
  assert.equal(runCli(w, ["init"], { cwd: w.proj }).status, 0);
  const r = runCli(w, ["uninstall"], { cwd: w.proj });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /removed the guardrails hook/);
  assert.deepEqual(readJson(settingsOf(w)), RICH, "settings are what they were before init");
  assert.ok(!fs.existsSync(path.join(w.cfg, "claude-code-guardrails")), "our copy is gone");
  assert.equal(backups(w.cfg).length, 2, "one backup from init, one from uninstall");
});

test("uninstall from a config that init created from nothing leaves an empty object", () => {
  const w = world();
  assert.equal(runCli(w, ["init"], { cwd: w.proj }).status, 0);
  assert.equal(runCli(w, ["uninstall"], { cwd: w.proj }).status, 0);
  assert.deepEqual(readJson(settingsOf(w)), {});
  const again = runCli(w, ["uninstall"], { cwd: w.proj });
  assert.equal(again.status, 0);
  assert.match(again.out, /nothing to remove/);
  assert.equal(backups(w.cfg).length, 1, "a second uninstall changes nothing and backs nothing up");
});

test("uninstall keeps your rules unless asked, and never deletes a folder that is not ours", () => {
  const w = world();
  assert.equal(runCli(w, ["init", "--preset", "strict"], { cwd: w.proj }).status, 0);
  const cfgFile = path.join(w.cfg, "guardrails.json");
  assert.deepEqual(readJson(cfgFile), { preset: "strict" });
  const keep = runCli(w, ["uninstall"], { cwd: w.proj });
  assert.match(keep.out, /kept .*guardrails\.json/);
  assert.ok(fs.existsSync(cfgFile));
  assert.equal(runCli(w, ["init"], { cwd: w.proj }).status, 0);
  assert.equal(runCli(w, ["uninstall", "--purge"], { cwd: w.proj }).status, 0);
  assert.ok(!fs.existsSync(cfgFile));
  // a folder with our name but not our guard.mjs is never removed
  fs.mkdirSync(path.join(w.cfg, "claude-code-guardrails"));
  fs.writeFileSync(path.join(w.cfg, "claude-code-guardrails", "mine.txt"), "mine");
  assert.equal(runCli(w, ["uninstall"], { cwd: w.proj }).status, 0);
  assert.ok(fs.existsSync(path.join(w.cfg, "claude-code-guardrails", "mine.txt")));
});

test("uninstall with an invalid settings.json changes nothing", () => {
  const w = world();
  assert.equal(runCli(w, ["init"], { cwd: w.proj }).status, 0);
  fs.writeFileSync(settingsOf(w), "{ nope");
  const r = runCli(w, ["uninstall"], { cwd: w.proj });
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(settingsOf(w), "utf8"), "{ nope");
  assert.ok(fs.existsSync(guardOf(w)), "the copy stays too");
});

test("init --preset writes the preset to your guardrails.json and keeps the other keys; a bad preset changes nothing", () => {
  const w = world();
  fs.writeFileSync(path.join(w.cfg, "guardrails.json"), JSON.stringify({ allow: ["git-clean"], note: "x" }));
  assert.equal(runCli(w, ["init", "--preset", "relaxed"], { cwd: w.proj }).status, 0);
  assert.deepEqual(readJson(path.join(w.cfg, "guardrails.json")), { allow: ["git-clean"], note: "x", preset: "relaxed" });
  const w2 = world();
  const bad = runCli(w2, ["init", "--preset", "paranoid"], { cwd: w2.proj });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown preset "paranoid"/);
  assert.deepEqual(ls(w2.cfg), []);
});

// ---------------------------------------------------------------------------------------------
// project scope
// ---------------------------------------------------------------------------------------------

test("init --scope project vendors the scripts into .claude/guardrails and uses ${CLAUDE_PROJECT_DIR}", () => {
  const w = world();
  const r = runCli(w, ["init", "--scope", "project", "--preset", "strict"], { cwd: w.proj });
  assert.equal(r.status, 0, r.out);
  const dir = path.join(w.proj, ".claude", "guardrails");
  for (const f of ["guard.mjs", "src/hook.mjs", "src/decide.mjs", "bin/claude-guardrails.mjs"]) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.deepEqual(readJson(path.join(w.proj, ".claude", "settings.json")), {
    hooks: { PreToolUse: [{ matcher: MATCHER, hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/.claude/guardrails/guard.mjs"], timeout: 10 }] }] },
  });
  assert.deepEqual(readJson(path.join(w.proj, ".claude", "guardrails.json")), { preset: "strict" });
  assert.deepEqual(ls(w.cfg), [], "project scope writes nothing to the user's config folder");
  assert.ok(!fs.existsSync(path.join(dir, "package.json")), "no package.json is needed next to the vendored script");
  // the vendored copy works from the project, with the project's preset
  const ev = (command) => JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: w.proj });
  assert.equal(JSON.parse(runNode(path.join(dir, "guard.mjs"), [], { w, input: ev("rm -rf /") }).stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(JSON.parse(runNode(path.join(dir, "guard.mjs"), [], { w, input: ev("git push origin main") }).stdout).hookSpecificOutput.permissionDecision, "ask", "strict, from the project's file");
});

test("project scope: other settings are kept, a second init changes nothing, uninstall removes the folder and the entry", () => {
  const w = world();
  fs.mkdirSync(path.join(w.proj, ".claude"), { recursive: true });
  const file = path.join(w.proj, ".claude", "settings.json");
  fs.writeFileSync(file, JSON.stringify(RICH, null, 2));
  assert.equal(runCli(w, ["init", "--scope", "project"], { cwd: w.proj }).status, 0);
  const once = fs.readFileSync(file, "utf8");
  assert.equal(backups(path.join(w.proj, ".claude")).length, 1);
  const again = runCli(w, ["init", "--scope", "project"], { cwd: w.proj });
  assert.match(again.out, /already has the guardrails hook/);
  assert.equal(fs.readFileSync(file, "utf8"), once);
  fs.writeFileSync(path.join(w.proj, ".claude", "guardrails.json"), JSON.stringify({ allow: ["git-clean"] }));
  const un = runCli(w, ["uninstall", "--scope", "project"], { cwd: w.proj });
  assert.equal(un.status, 0, un.out);
  assert.deepEqual(readJson(file), RICH);
  assert.ok(!fs.existsSync(path.join(w.proj, ".claude", "guardrails")));
  assert.ok(fs.existsSync(path.join(w.proj, ".claude", "guardrails.json")), "the project's rules stay");
});

test("init from a subfolder of the project installs at the project root", () => {
  const w = world();
  const sub = path.join(w.proj, "src", "deep");
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(runCli(w, ["init", "--scope", "project"], { cwd: sub, env: { CLAUDE_PROJECT_DIR: undefined } }).status, 0);
  assert.ok(fs.existsSync(path.join(w.proj, ".claude", "guardrails", "guard.mjs")));
  assert.ok(!fs.existsSync(path.join(sub, ".claude")));
});

test("init run from the installed copy does not copy files onto themselves", () => {
  const w = world();
  assert.equal(runCli(w, ["init"], { cwd: w.proj }).status, 0);
  const installedCli = path.join(w.cfg, "claude-code-guardrails", "bin", "claude-guardrails.mjs");
  const r = runNode(installedCli, ["init"], { w, cwd: w.proj });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /running from the installed copy/);
  assert.match(r.out, /already has the guardrails hook/);
  assert.ok(runNode(installedCli, ["--version"], { w }).stdout.trim().length > 0);
  // uninstall from the installed copy removes the entry but leaves its own folder (it is still running from it)
  const un = runNode(installedCli, ["uninstall"], { w, cwd: w.proj });
  assert.equal(un.status, 0, un.out);
  assert.deepEqual(readJson(settingsOf(w)), {});
});

// ---------------------------------------------------------------------------------------------
// recognising our entry
// ---------------------------------------------------------------------------------------------

test("isOurHook recognises our script by its path, in either form, and nothing else", () => {
  const ours = [
    { type: "command", command: "node", args: ["/home/me/.claude/claude-code-guardrails/guard.mjs"] },
    { type: "command", command: "node", args: ["C:\\Users\\me\\.claude\\claude-code-guardrails\\guard.mjs"] },
    { type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/.claude/guardrails/guard.mjs"] },
    { type: "command", command: 'node "/home/me/.claude/claude-code-guardrails/guard.mjs"' },
    { type: "command", command: "node /repo/claude-code-guardrails/guard.mjs", timeout: 3 },
  ];
  const foreign = [
    { type: "command", command: "node", args: ["/opt/other/guard.mjs"] },
    { type: "command", command: "node", args: ["/home/me/my-guardrails/guard.mjs"] },
    { type: "command", command: "node", args: ["/home/me/.claude/claude-code-guardrails/guard.mjs.bak"] },
    { type: "command", command: "echo claude-code-guardrails" },
    { type: "command", command: "node", args: ["/x/claude-code-guardrails/other.mjs"] },
    {}, null, "text", 42,
  ];
  for (const h of ours) assert.equal(isOurHook(h), true, JSON.stringify(h));
  for (const h of foreign) assert.equal(isOurHook(h), false, JSON.stringify(h));
});

test("addHook and removeHook: pure, idempotent, and careful with groups that hold other hooks too", () => {
  const script = "/c/claude-code-guardrails/guard.mjs";
  const mixed = { hooks: { PreToolUse: [{ matcher: "X", hooks: [hookEntry(script), { type: "command", command: "echo other" }] }] } };
  const frozen = JSON.parse(JSON.stringify(mixed));
  const added = addHook(mixed, script);
  assert.deepEqual(mixed, frozen, "the input is not modified");
  assert.equal(added.changed, true, "our entry sat in the wrong group (matcher X): it is moved");
  assert.deepEqual(added.settings.hooks.PreToolUse, [{ matcher: "X", hooks: [{ type: "command", command: "echo other" }] }, { matcher: MATCHER, hooks: [hookEntry(script)] }]);
  assert.equal(addHook(added.settings, script).changed, false);
  const removed = removeHook(added.settings);
  assert.equal(removed.removed, 1);
  assert.deepEqual(removed.settings, { hooks: { PreToolUse: [{ matcher: "X", hooks: [{ type: "command", command: "echo other" }] }] } });
  assert.equal(removeHook(removed.settings).removed, 0);
  assert.deepEqual(removeHook({ hooks: { PreToolUse: [{ matcher: MATCHER, hooks: [hookEntry(script)] }] } }).settings, {});
  assert.deepEqual(removeHook({ model: "x" }), { settings: { model: "x" }, removed: 0 });
});

test("init needs no network and writes only inside the config folder and the project", () => {
  const w = world();
  const before = new Set(ls(w.root));
  assert.equal(runCli(w, ["init", "--scope", "project"], { cwd: w.proj }).status, 0);
  assert.equal(runCli(w, ["init"], { cwd: w.proj }).status, 0);
  assert.deepEqual(ls(w.root).filter((x) => !before.has(x)), [], "nothing new next to the project, config and home folders");
  assert.deepEqual(ls(w.home), [], "the home folder is untouched");
  // and the package itself is not modified by running from it
  assert.ok(fs.existsSync(path.join(ROOT, "guard.mjs")));
});
