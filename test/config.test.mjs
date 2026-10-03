// guardrails.json: precedence of project, user and default; allow, deny and ask entries; custom patterns.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FAKE, LINUX, bash, check, fakeGit, tmp, world } from "./helpers.mjs";
import { addEntryTo, configDir, defaultConfig, findProjectRoot, loadConfig, projectConfigFile, setPresetIn, updateConfigFile, userConfigFile } from "../src/config.mjs";
import { decide, reasonText } from "../src/decide.mjs";

const writeUser = (w, data) => fs.writeFileSync(path.join(w.cfg, "guardrails.json"), typeof data === "string" ? data : JSON.stringify(data));
const writeProject = (w, data) => {
  fs.mkdirSync(path.join(w.proj, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(w.proj, ".claude", "guardrails.json"), typeof data === "string" ? data : JSON.stringify(data));
};
const load = (w) => loadConfig({ env: { CLAUDE_CONFIG_DIR: w.cfg }, projectDir: w.proj });

// ---------------------------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------------------------

test("the default preset is balanced", () => {
  const w = world();
  const c = load(w);
  assert.equal(c.preset, "balanced");
  assert.equal(c.presetSource, "default");
  assert.deepEqual(c.protectedBranches, ["main", "master", "release/*", "production"]);
  assert.deepEqual(c.warnings, []);
});

test("a project preset wins over a user preset, which wins over the default", () => {
  const w = world();
  writeUser(w, { preset: "strict" });
  assert.deepEqual([load(w).preset, load(w).presetSource], ["strict", "user"]);
  writeProject(w, { preset: "relaxed" });
  assert.deepEqual([load(w).preset, load(w).presetSource], ["relaxed", "project"]);
  writeProject(w, { allow: ["git-reset-hard"] });
  assert.deepEqual([load(w).preset, load(w).presetSource], ["strict", "user"], "a project without a preset leaves yours in force");
});

test("allow, deny and ask lists of both files are joined, without duplicates", () => {
  const w = world();
  writeUser(w, { allow: ["git-clean", "^npm run"], deny: ["publish"], ask: ["^make"] });
  writeProject(w, { allow: ["git-reset-hard", "git-clean"], deny: ["^docker"], ask: [] });
  const c = load(w);
  assert.deepEqual(c.allow.entries, ["git-reset-hard", "git-clean", "^npm run"]);
  assert.deepEqual(c.deny.entries, ["^docker", "publish"]);
  assert.deepEqual(c.ask.entries, ["^make"]);
  assert.deepEqual([...c.allow.ids], ["git-reset-hard", "git-clean"]);
  assert.equal(c.allow.res.length, 1);
});

test("protectedBranches replaces the default; the two files' lists are joined", () => {
  const w = world();
  assert.deepEqual(load(w).protectedBranches, ["main", "master", "release/*", "production"]);
  writeUser(w, { protectedBranches: ["develop"] });
  assert.deepEqual(load(w).protectedBranches, ["develop"]);
  writeProject(w, { protectedBranches: ["staging", "develop"] });
  assert.deepEqual(load(w).protectedBranches, ["staging", "develop"]);
  writeProject(w, { protectedBranches: [] });
  assert.deepEqual(load(w).protectedBranches, ["develop"]);
});

test("custom protected branches change what a force push is", () => {
  const cfg = { protectedBranches: ["develop", "stable/*"] };
  assert.equal(bash(LINUX, "git push -f origin develop", "balanced", cfg).rule, "git-force-push-protected");
  assert.equal(bash(LINUX, "git push -f origin stable/1.x", "balanced", cfg).rule, "git-force-push-protected");
  assert.equal(bash(LINUX, "git push -f origin main", "balanced", cfg).rule, "git-force-push", "main is no longer protected once you name your own");
  assert.equal(bash(LINUX, "git push origin develop", "strict", cfg).rule, "git-push-protected");
});

// ---------------------------------------------------------------------------------------------
// Problems in the files are warnings, never failures
// ---------------------------------------------------------------------------------------------

test("an invalid file is ignored with a warning", () => {
  const w = world();
  writeUser(w, "{ not json");
  writeProject(w, "[1, 2]");
  const c = load(w);
  assert.equal(c.preset, "balanced");
  assert.equal(c.warnings.length, 2);
  assert.match(c.warnings[0], /user config .*not valid JSON; ignored/);
  assert.match(c.warnings[1], /project config .*not a JSON object; ignored/);
  assert.deepEqual([c.files.user.status, c.files.project.status], ["invalid", "invalid"]);
});

test("wrong types, unknown keys, bad presets and bad patterns are reported and skipped", () => {
  const w = world();
  writeUser(w, { preset: "paranoid", allow: "git-clean", deny: ["(", 7, "^ok"], ask: [], color: "blue" });
  const c = load(w);
  assert.equal(c.preset, "balanced");
  assert.ok(c.warnings.some((x) => /preset "paranoid" is not one of strict, balanced, relaxed/.test(x)));
  assert.ok(c.warnings.some((x) => /"allow" must be a list/.test(x)));
  assert.ok(c.warnings.some((x) => /"deny" has entries that are not text/.test(x)));
  assert.ok(c.warnings.some((x) => /unknown key "color"/.test(x)));
  assert.ok(c.warnings.some((x) => /neither a rule id nor a valid regular expression/.test(x)));
  assert.deepEqual(c.deny.res.map((r) => r.source), ["^ok"], "the good pattern still works");
});

test("an empty file is an empty config", () => {
  const w = world();
  writeUser(w, "");
  assert.deepEqual(load(w).warnings, []);
});

// ---------------------------------------------------------------------------------------------
// allow
// ---------------------------------------------------------------------------------------------

test("allow by rule id switches a rule off everywhere", () => {
  assert.equal(bash(LINUX, "git reset --hard", "balanced").decision, "ask");
  assert.equal(bash(LINUX, "git reset --hard", "balanced", { allow: ["git-reset-hard"] }).decision, "allow");
  assert.equal(bash(LINUX, "git reset --hard", "strict", { allow: ["git-reset-hard"] }).decision, "allow");
  assert.equal(bash(LINUX, "git clean -fd", "balanced", { allow: ["git-reset-hard"] }).decision, "ask", "other rules stay");
  assert.equal(bash(LINUX, "npm publish", "balanced", { allow: ["publish"] }).decision, "allow");
});

test("allow by pattern lowers ask and non-floor deny for the segment it matches", () => {
  assert.equal(bash(LINUX, "git reset --hard HEAD~1", "balanced", { allow: ["^git reset --hard HEAD~1$"] }).decision, "allow");
  assert.equal(bash(LINUX, "git reset --hard HEAD~2", "balanced", { allow: ["^git reset --hard HEAD~1$"] }).decision, "ask");
  assert.equal(bash(LINUX, "rm -rf ../scratch", "strict", { allow: ["^rm -rf \\.\\./scratch$"] }).decision, "allow", "strict deny can be allowed by a pattern");
  assert.equal(bash(LINUX, "git push --force origin main", "balanced", { allow: ["^git push --force origin main$"] }).decision, "allow", "a policy deny is not a floor rule");
});

test("a pattern is tested against the segment that raised the rule, so allowing one command never unlocks the others", () => {
  const cfg = { allow: ["git status", "^npm run", "echo"] };
  assert.equal(bash(LINUX, "git status && git push --force origin dev", "balanced", cfg).decision, "ask");
  assert.equal(bash(LINUX, "git status && git push --force origin main", "balanced", cfg).decision, "deny");
  assert.equal(bash(LINUX, "npm run build $(git reset --hard)", "balanced", cfg).decision, "ask");
  assert.equal(bash(LINUX, "echo hi; git reset --hard", "balanced", cfg).decision, "ask");
  assert.equal(bash(LINUX, "bash -c 'git reset --hard'", "balanced", { allow: ["^bash -c"] }).decision, "ask", "the inner command is what is judged");
});

test("floor rules cannot be allowed by a pattern, only by their exact id", () => {
  for (const cmd of ["rm -rf /", "mkfs.ext4 /dev/sda1", "shutdown -h now", "chmod -R 777 /", ":(){ :|:& };:", "echo x > .env"]) {
    assert.equal(bash(LINUX, cmd, "relaxed", { allow: [".*", "rm", "^.*$", "sh"] }).decision, "deny", cmd);
  }
  assert.equal(bash(LINUX, "rm -rf /", "balanced", { allow: ["rm-root"] }).decision, "allow");
  assert.equal(bash(LINUX, "mkfs.ext4 /dev/sda1", "balanced", { allow: ["disk-wipe"] }).decision, "allow");
  assert.equal(bash(LINUX, "echo x > .env", "balanced", { allow: ["secret-file-write"] }).decision, "allow");
  assert.equal(check(LINUX, "Write", { file_path: "/home/me/proj/.env" }, "balanced", { allow: ["^/home/me/proj/\\.env$"] }).decision, "deny");
  assert.equal(check(LINUX, "Write", { file_path: "/home/me/proj/.env" }, "balanced", { allow: ["secret-file-write"] }).decision, "allow");
});

test("allow patterns for files match the path with forward slashes, or the path inside the project", () => {
  const cfg = { allow: ["^/home/me/other/"] };
  assert.equal(check(LINUX, "Write", { file_path: "/home/me/other/a.js" }, "balanced", cfg).decision, "allow");
  assert.equal(check(LINUX, "Write", { file_path: "/home/me/elsewhere/a.js" }, "balanced", cfg).decision, "ask");
  assert.equal(check(LINUX, "Edit", { file_path: "/home/me/proj/package-lock.json" }, "balanced", { allow: ["^package-lock\\.json$"] }).decision, "allow", "relative to the project");
  const win = { ...LINUX, platform: "win32", cwd: "C:\\Users\\me\\proj", projectDir: "C:\\Users\\me\\proj", home: "C:\\Users\\me", tmpDirs: [], configDir: "C:\\Users\\me\\.claude" };
  assert.equal(check(win, "Write", { file_path: "D:\\shared\\x.txt" }, "balanced", { allow: ["^D:/shared/"] }).decision, "allow");
});

// ---------------------------------------------------------------------------------------------
// deny and ask
// ---------------------------------------------------------------------------------------------

test("deny by rule id raises a rule to deny in every preset", () => {
  assert.equal(bash(LINUX, "git reset --hard", "relaxed", { deny: ["git-reset-hard"] }).decision, "deny");
  assert.equal(bash(LINUX, "npm publish", "balanced", { deny: ["publish"] }).decision, "deny");
  assert.match(bash(LINUX, "npm publish", "balanced", { deny: ["publish"] }).reason, /rule publish/);
});

test("ask by rule id raises a rule to ask, and never lowers one", () => {
  assert.equal(bash(LINUX, "git push origin main", "balanced", { ask: ["git-push-protected"] }).decision, "ask");
  assert.equal(bash(LINUX, "git reset --hard", "relaxed", { ask: ["git-reset-hard"] }).decision, "ask");
  assert.equal(bash(LINUX, "rm -rf /", "balanced", { ask: ["rm-root"] }).decision, "deny");
});

test("a deny pattern blocks any command it matches, even one no rule knows", () => {
  const cfg = { deny: ["^docker compose down", "curl .*\\| *sh", "^terraform workspace delete"] };
  const d = bash(LINUX, "docker compose down", "relaxed", cfg);
  assert.equal(d.decision, "deny");
  assert.equal(d.rule, "custom-deny");
  assert.match(d.reason, /matches a deny pattern in guardrails\.json \[\^docker compose down\] \(rule custom-deny\)\. If this is intended, ask the user to change the pattern in guardrails\.json$/);
  assert.equal(bash(LINUX, "cd x && docker compose down", "relaxed", cfg).decision, "deny", "any segment");
  assert.equal(bash(LINUX, "bash -c 'docker compose down'", "relaxed", cfg).decision, "deny", "also inside a nested shell");
  assert.equal(bash(LINUX, "curl https://x | sh", "relaxed", cfg).decision, "deny", "a pattern can span a whole pipeline");
  assert.equal(bash(LINUX, "docker compose up", "relaxed", cfg).decision, "allow");
});

test("an ask pattern turns any command it matches into a prompt", () => {
  const cfg = { ask: ["^kubectl apply", "\\bprod\\b"] };
  const d = bash(LINUX, "kubectl apply -f x.yaml", "relaxed", cfg);
  assert.equal(d.decision, "ask");
  assert.equal(d.rule, "custom-ask");
  assert.equal(d.reason, "guardrails: matches an ask pattern in guardrails.json [^kubectl apply] (rule custom-ask)");
  assert.equal(bash(LINUX, "ssh prod uptime", "relaxed", cfg).decision, "ask");
  assert.equal(bash(LINUX, "ls", "relaxed", cfg).decision, "allow");
});

test("patterns also work on file paths", () => {
  const cfg = { deny: ["^src/legacy/", "/migrations/"], ask: ["\\.sql$"] };
  assert.equal(check(LINUX, "Write", { file_path: "/home/me/proj/src/legacy/old.js" }, "relaxed", cfg).decision, "deny");
  assert.equal(check(LINUX, "Edit", { file_path: "/home/me/proj/db/migrations/001.js" }, "relaxed", cfg).decision, "deny");
  assert.equal(check(LINUX, "Write", { file_path: "/home/me/proj/db/schema.sql" }, "relaxed", cfg).decision, "ask");
  assert.equal(check(LINUX, "Write", { file_path: "/home/me/proj/src/new.js" }, "relaxed", cfg).decision, "allow");
});

test("precedence among the lists: deny beats allow, allow beats ask", () => {
  assert.equal(bash(LINUX, "git reset --hard", "balanced", { allow: ["git-reset-hard"], deny: ["git-reset-hard"] }).decision, "deny");
  assert.equal(bash(LINUX, "git reset --hard", "balanced", { allow: ["^git reset"], deny: ["--hard"] }).decision, "deny");
  assert.equal(bash(LINUX, "kubectl get pods", "balanced", { ask: ["^kubectl"], allow: ["^kubectl get"] }).decision, "allow");
  assert.equal(bash(LINUX, "kubectl apply -f x", "balanced", { ask: ["^kubectl"], allow: ["^kubectl get"] }).decision, "ask");
  assert.equal(bash(LINUX, "git reset --hard", "balanced", { ask: ["git-reset-hard"], allow: ["^git reset"] }).decision, "allow");
});

test("a rule id in the ask list makes a plain push consult git", () => {
  const g = fakeGit("main");
  const env = { ...LINUX, git: g.run };
  assert.equal(bash(env, "git push", "balanced").decision, "allow");
  assert.equal(g.calls.length, 0);
  assert.equal(bash(env, "git push", "balanced", { ask: ["git-push-protected"] }).decision, "ask");
  assert.equal(g.calls.length, 1);
});

test("the findings list reports everything that matched, strictest first as the verdict", () => {
  const d = bash(LINUX, "git reset --hard && git push -f origin main && npm publish", "balanced");
  assert.equal(d.decision, "deny");
  assert.equal(d.rule, "git-force-push-protected");
  assert.deepEqual(d.findings.map((f) => `${f.rule}:${f.decision}`).sort(), ["git-force-push-protected:deny", "git-reset-hard:ask", "publish:ask"]);
});

test("when two denials tie, a floor rule is the one reported", () => {
  const d = bash(LINUX, "git push -f origin main; rm -rf /", "balanced");
  assert.equal(d.rule, "rm-root");
});

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

test("deny and ask messages have a fixed, short shape", () => {
  const deny = bash(LINUX, "git push --force origin main");
  assert.equal(deny.reason, "guardrails: force push to, or deletion of, a protected branch [main] (rule git-force-push-protected). If this is intended, ask the user to allow it: claude-guardrails allow git-force-push-protected");
  const ask = bash(LINUX, "git reset --hard");
  assert.equal(ask.reason, "guardrails: git reset --hard throws away uncommitted work (rule git-reset-hard)");
  assert.equal(reasonText({ rule: "publish", detail: "" }, "deny"), "guardrails: publishes a package, release or image (npm, cargo, twine, gh release, docker push ...) (rule publish). If this is intended, ask the user to allow it: claude-guardrails allow publish");
});

test("a message never runs long, even for long paths and many findings", () => {
  const long = "/home/me/proj/" + "very-long-folder-name/".repeat(20) + ".env";
  const d = check(LINUX, "Write", { file_path: long });
  assert.ok(d.reason.length < 330, `${d.reason.length} characters`);
  const many = bash(LINUX, "rm -rf " + "../x".repeat(3000));
  assert.ok(many.reason.length < 330, `${many.reason.length} characters`);
});

// ---------------------------------------------------------------------------------------------
// Writing the files, finding the project
// ---------------------------------------------------------------------------------------------

test("setPresetIn and addEntryTo keep every other key, add once, and refuse a broken file", () => {
  const dir = tmp("gr-c-");
  const file = path.join(dir, "g.json");
  assert.equal(setPresetIn(file, "strict").ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { preset: "strict" });
  fs.writeFileSync(file, JSON.stringify({ preset: "strict", note: "mine", allow: ["a-rule"] }, null, 4));
  assert.equal(addEntryTo(file, "allow", "git-clean").ok, true);
  assert.equal(addEntryTo(file, "allow", "git-clean").changed, false, "no duplicate");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { preset: "strict", note: "mine", allow: ["a-rule", "git-clean"] });
  assert.match(fs.readFileSync(file, "utf8"), /^ {4}"preset"/m, "the file's own indentation is kept");
  fs.writeFileSync(file, "{ broken");
  const r = updateConfigFile(file, (d) => { d.preset = "relaxed"; });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(file, "utf8"), "{ broken", "left untouched");
});

test("configDir follows CLAUDE_CONFIG_DIR", () => {
  assert.equal(configDir({ CLAUDE_CONFIG_DIR: "/x/y" }), path.resolve("/x/y"));
  assert.equal(configDir({ CLAUDE_CONFIG_DIR: "  " }), path.join(process.env.HOME || process.env.USERPROFILE, ".claude"));
  assert.equal(userConfigFile({ CLAUDE_CONFIG_DIR: "/x/y" }), path.join(path.resolve("/x/y"), "guardrails.json"));
  assert.equal(projectConfigFile("/p"), path.join("/p", ".claude", "guardrails.json"));
});

test("findProjectRoot: the nearest .git or .claude, and never above the home or temp folder", () => {
  const w = world();
  const deep = path.join(w.proj, "a", "b", "c");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findProjectRoot(deep, { home: w.home, tmp: w.root }), w.proj);
  // a folder with no marker below a "home" that has a .claude folder: the walk stops at home
  const fakeHome = path.join(w.root, "fakehome");
  const lonely = path.join(fakeHome, "notes", "x");
  fs.mkdirSync(lonely, { recursive: true });
  fs.mkdirSync(path.join(fakeHome, ".claude"));
  assert.equal(findProjectRoot(lonely, { home: fakeHome, tmp: path.join(w.root, "elsewhere") }), lonely);
  // ... and at the temp folder, even when something above it has a marker
  const fakeTmp = path.join(w.root, "faketmp");
  const inTmp = path.join(fakeTmp, "work", "x");
  fs.mkdirSync(inTmp, { recursive: true });
  fs.mkdirSync(path.join(w.root, ".claude"));
  assert.equal(findProjectRoot(inTmp, { home: path.join(w.root, "nohome"), tmp: fakeTmp }), inTmp);
});

test("defaultConfig compiles overrides the same way the file loader does", () => {
  const c = defaultConfig({ preset: "strict", allow: ["git-clean", "^x"] });
  assert.equal(c.preset, "strict");
  assert.deepEqual([...c.allow.ids], ["git-clean"]);
  assert.equal(c.allow.res.length, 1);
});

test("decide works on a file-backed config end to end", () => {
  const w = world();
  writeUser(w, { preset: "strict", allow: ["git-push-protected"] });
  writeProject(w, { deny: ["^make deploy"], preset: "relaxed" });
  const config = load(w);
  const env = { ...LINUX };
  const run = (command) => decide({ tool_name: "Bash", tool_input: { command }, cwd: env.cwd }, { env, config }).decision;
  assert.equal(run("git reset --hard"), "allow", "relaxed from the project");
  assert.equal(run("make deploy"), "deny", "the project's own pattern");
  assert.equal(run("git push origin main"), "allow");
});
