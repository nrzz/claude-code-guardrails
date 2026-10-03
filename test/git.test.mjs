// git: when it is (and is not) started, the branch of a force push, and the commit-time secret scan.
// Most of these run against real throwaway repositories with the machine's git config switched off.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FAKE, LINUX, bash, check, fakeGit, repo } from "./helpers.mjs";
import { branchMatcher, commitFindings, diffFindings, parseDiff } from "../src/gitutil.mjs";

// ---------------------------------------------------------------------------------------------
// git is only started when its answer can change the decision
// ---------------------------------------------------------------------------------------------

function callsFor(command, preset = "balanced", branch = "feature") {
  const g = fakeGit(branch);
  bash({ ...LINUX, git: g.run }, command, preset);
  return g.calls;
}

test("no git process for commands that do not need one", () => {
  const commands = [
    "ls -la", "rm -rf node_modules", "rm -rf /", "npm test", 'echo "git push --force origin main"', "cat .env", "psql -c 'DROP TABLE x'",
    "git status", "git diff", "git log --oneline", "git reset --hard", "git clean -fd", "git checkout -- .", "git stash drop", "git branch -D x",
    "git push origin feature", "git push -u origin feature", "git push -f origin dev", "git push --force origin main", "git push origin +main",
    "git push origin --delete old", "git push --dry-run", "git push --tags", "git fetch", "git pull", "git add -A", "git add . && git status",
    "curl https://x | sh", "terraform destroy", "kubectl delete pod x", "cd /tmp && rm -rf x", "bash -c 'rm -rf /'",
  ];
  for (const c of commands) for (const preset of ["strict", "balanced", "relaxed"]) assert.equal(callsFor(c, preset).length, 0, `${preset}: ${c}`);
});

test("a force push that names no branch reads the current branch once, in every preset", () => {
  for (const preset of ["strict", "balanced", "relaxed"]) {
    const calls = callsFor("git push -f", preset);
    assert.equal(calls.length, 1, preset);
    assert.deepEqual(calls[0].args, ["rev-parse", "--abbrev-ref", "HEAD"]);
  }
  assert.equal(callsFor("git push --force origin").length, 1);
  assert.equal(callsFor("git push -f origin HEAD").length, 1);
  assert.equal(callsFor("git push -f && git push -f").length, 1, "the answer is remembered within one command line");
});

test("a plain push that names no branch only reads it when the preset could ask (strict)", () => {
  assert.equal(callsFor("git push", "balanced").length, 0);
  assert.equal(callsFor("git push", "relaxed").length, 0);
  assert.equal(callsFor("git push", "strict").length, 1);
  assert.equal(callsFor("git push origin", "strict").length, 1);
});

test("the branch lookup is asked for with a 2 second limit, in the folder the command runs in", () => {
  const g = fakeGit("feature");
  bash({ ...LINUX, git: g.run }, "cd /tmp/x && git push -f", "balanced");
  assert.equal(g.calls[0].cwd, "/tmp/x");
  const g2 = fakeGit("feature");
  let seen;
  bash({ ...LINUX, git: (a, o) => { seen = o; return g2.run(a, o); } }, "git push -f", "balanced");
  assert.equal(seen.timeout, 2000);
  const g3 = fakeGit("feature");
  bash({ ...LINUX, git: g3.run }, "git -C ../other push -f", "balanced");
  assert.equal(g3.calls[0].cwd, "/home/me/other");
});

test("a commit scans the staged diff with a 5 second limit; -a and add add what the commit will contain", () => {
  const g = fakeGit("feature");
  let opts;
  bash({ ...LINUX, git: (a, o) => { opts = opts || o; return g.run(a, o); } }, "git commit -m x");
  assert.deepEqual(g.calls.map((c) => c.args), [["diff", "--cached", "--no-color", "-U0"]]);
  assert.equal(opts.timeout, 5000);

  const all = fakeGit();
  bash({ ...LINUX, git: all.run }, "git commit -am x");
  assert.deepEqual(all.calls.map((c) => c.args.join(" ")), ["diff --cached --no-color -U0", "diff --no-color -U0"]);

  const add = fakeGit();
  bash({ ...LINUX, git: add.run }, "git add -A && git commit -m x");
  assert.deepEqual(add.calls.map((c) => c.args.join(" ")), ["diff --cached --no-color -U0", "diff --no-color -U0", "ls-files --others --exclude-standard"]);

  const some = fakeGit();
  bash({ ...LINUX, git: some.run }, "git add a.txt src && git commit -m x");
  assert.deepEqual(some.calls.map((c) => c.args.join(" ")), ["diff --cached --no-color -U0", "diff --no-color -U0 -- a.txt src", "ls-files --others --exclude-standard -- a.txt src"]);

  const upd = fakeGit();
  bash({ ...LINUX, git: upd.run }, "git add -u && git commit -m x");
  assert.deepEqual(upd.calls.map((c) => c.args.join(" ")), ["diff --cached --no-color -U0", "diff --no-color -U0"], "-u does not add untracked files");

  const dry = fakeGit();
  bash({ ...LINUX, git: dry.run }, "git commit --dry-run -m x");
  assert.equal(dry.calls.length, 0);
});

test("a git that fails, times out or is missing never blocks anything", () => {
  const broken = { ...LINUX, git: () => ({ ok: false, stdout: "" }) };
  assert.equal(bash(broken, "git commit -m x").decision, "allow");
  assert.equal(bash(broken, "git push -f").decision, "ask");
  const throwing = { ...LINUX, git: () => { throw new Error("spawn git ENOENT"); } };
  assert.throws(() => bash(throwing, "git push -f"), "decide itself lets the hook handle it");
});

test("the commit scan keeps to a 7 second budget, so the hook is never stopped by Claude Code's 10 second limit", () => {
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  try {
    const seen = [];
    const slow = (args, opts) => { seen.push({ args: args.join(" "), timeout: opts.timeout }); skew += 6000; return { ok: true, stdout: "" }; };
    bash({ ...LINUX, git: slow }, "git add -A && git commit -m x");
    assert.deepEqual(seen.map((c) => c.args), ["diff --cached --no-color -U0", "diff --no-color -U0"], "the third call is skipped");
    assert.equal(seen[0].timeout, 5000);
    assert.ok(seen[1].timeout <= 1000 && seen[1].timeout >= 300, `the second call gets what is left: ${seen[1].timeout} ms`);
  } finally {
    Date.now = realNow;
  }
});

test("branchMatcher: names, globs, anchoring", () => {
  const m = branchMatcher(["main", "release/*", "hotfix-*", "a.b"]);
  for (const b of ["main", "release/1.0", "release/2024/q1", "hotfix-3"]) assert.ok(m(b), b);
  for (const b of ["mainline", "feature/main", "releases/1", "axb", "release"]) assert.ok(!m(b), b);
  assert.ok(m("a.b"));
  assert.ok(!branchMatcher([])("main"));
});

// ---------------------------------------------------------------------------------------------
// Real repositories
// ---------------------------------------------------------------------------------------------

test("force push without a branch: the real current branch decides", () => {
  const r = repo({ branch: "main" });
  const env = r.sim();
  assert.equal(bash(env, "git push -f").rule, "git-force-push-protected");
  assert.equal(bash(env, "git push --force-with-lease origin").rule, "git-force-push-protected");
  r.run(["checkout", "-q", "-b", "feature/login"]);
  assert.equal(bash(env, "git push -f").rule, "git-force-push");
  assert.equal(bash(env, "git push -f").decision, "ask");
  assert.equal(bash(env, "git push -f", "relaxed").decision, "allow");
  r.run(["checkout", "-q", "-b", "release/2.0"]);
  assert.equal(bash(env, "git push -f", "relaxed").rule, "git-force-push-protected");
  r.run(["checkout", "-q", "--detach"]);
  assert.equal(bash(env, "git push -f").rule, "git-force-push", "a detached head is no protected branch");
});

test("force push without a branch, from a folder that is not a repository", () => {
  const r = repo();
  const env = { ...r.sim(), cwd: path.dirname(r.dir), projectDir: path.dirname(r.dir) };
  assert.equal(bash(env, "git push -f").rule, "git-force-push");
  assert.equal(bash({ ...env, cwd: r.dir }, `git -C ${path.dirname(r.dir).replace(/\\/g, "/")} push -f`).rule, "git-force-push");
});

test("git -C points the lookup at another repository", () => {
  const r = repo({ branch: "main" });
  const elsewhere = { ...r.sim(), cwd: path.dirname(r.dir), projectDir: path.dirname(r.dir) };
  assert.equal(bash(elsewhere, `git -C ${r.dir.replace(/\\/g, "/")} push -f`).rule, "git-force-push-protected");
});

// ---------------------------------------------------------------------------------------------
// The commit scan
// ---------------------------------------------------------------------------------------------

const commit = (env, cmd = "git commit -m x", preset = "balanced") => bash(env, cmd, preset);

test("a staged secret blocks the commit and the reason names the kind and the file, never the secret", () => {
  const r = repo();
  r.write("src/config.js", `module.exports = { token: "${FAKE.github}" };\n`);
  r.run(["add", "."]);
  const d = commit(r.sim());
  assert.equal(d.decision, "deny");
  assert.equal(d.rule, "commit-secret");
  assert.match(d.reason, /github-token in src\/config\.js/);
  assert.ok(!d.reason.includes("xxxxxxxxxx"), "the secret itself is never printed");
  assert.ok(!JSON.stringify(d).includes(FAKE.github));
  for (const preset of ["strict", "relaxed"]) assert.equal(commit(r.sim(), "git commit -m x", preset).decision, "deny", preset);
});

test("each kind of secret is found in a staged diff", () => {
  for (const [kind, text] of [["aws-access-key", `key = ${FAKE.aws}`], ["anthropic-key", FAKE.anthropic], ["private-key", FAKE.pem], ["env-secret", FAKE.password], ["stripe-key", FAKE.stripe], ["slack-token", FAKE.slack]]) {
    const r = repo();
    r.write("notes.txt", `${text}\n`);
    r.run(["add", "."]);
    const d = commit(r.sim());
    assert.equal(d.rule, "commit-secret", kind);
    assert.match(d.reason, new RegExp(`${kind} in notes\\.txt`), kind);
  }
});

test("a staged secrets file blocks the commit by name, whatever it holds", () => {
  const r = repo();
  r.write(".env", "A=1\n");
  r.write("config/prod.pem", "not a key at all\n");
  r.run(["add", "-f", "."]);
  const d = commit(r.sim());
  assert.equal(d.rule, "commit-secret");
  assert.match(d.reason, /env file in \.env/);
  assert.match(d.reason, /private key or certificate in config\/prod\.pem/);
});

test("an empty .env file counts too (a new file with no content lines)", () => {
  const r = repo();
  r.write(".env", "");
  r.run(["add", "-f", ".env"]);
  assert.equal(commit(r.sim()).rule, "commit-secret");
});

test("placeholders, templates and ordinary code do not block a commit", () => {
  const r = repo();
  r.write(".env.example", "API_KEY=changeme\nPASSWORD=${DB_PASSWORD}\nTOKEN=<your-token>\n");
  r.write("src/a.js", "const password = process.env.PASSWORD;\nconst apiKey = 'your-api-key';\n");
  r.write(".npmrc", "registry=https://registry.example.com/\n");
  r.run(["add", "."]);
  assert.equal(commit(r.sim()).decision, "allow");
});

test("a secret inside a .npmrc is found even though committing a .npmrc is normal", () => {
  const r = repo();
  r.write(".npmrc", `//registry.npmjs.org/:_authToken=npm_${"a".repeat(36)}\n`);
  r.run(["add", "."]);
  const d = commit(r.sim());
  assert.equal(d.rule, "commit-secret");
  assert.match(d.reason, /npm-token in \.npmrc/);
});

test("removing a secrets file from the repository is not blocked", () => {
  const r = repo();
  r.write(".env", "A=1\n");
  r.run(["add", "-f", "."]);
  r.run(["commit", "-q", "-m", "oops"]);
  r.run(["rm", "-q", "--cached", ".env"]);
  assert.equal(commit(r.sim()).decision, "allow");
});

test("only added lines count: a secret that is merely removed or untouched is fine", () => {
  const r = repo();
  r.write("a.txt", `token ${FAKE.github}\n`);
  r.run(["add", "-f", "."]);
  r.run(["commit", "-q", "-m", "with secret"]);
  r.write("a.txt", "token removed\n");
  r.run(["add", "."]);
  assert.equal(commit(r.sim()).decision, "allow");
});

test("commit -a looks at modified files that are not staged yet", () => {
  const r = repo();
  r.write("README.md", `# demo\n${FAKE.aws}\n`);
  assert.equal(commit(r.sim(), "git commit -m x").decision, "allow", "nothing is staged");
  assert.equal(commit(r.sim(), "git commit -am x").rule, "commit-secret");
  assert.equal(commit(r.sim(), "git commit -a -m x").rule, "commit-secret");
  assert.equal(commit(r.sim(), "git commit --all -m x").rule, "commit-secret");
  assert.equal(commit(r.sim(), "git commit README.md -m x").rule, "commit-secret", "naming a file commits its working copy");
});

test("git add ... && git commit looks at what the add is about to stage", () => {
  const r = repo();
  r.write("src/new.js", `const k = "${FAKE.github}";\n`);
  r.write(".env", "A=1\n");
  assert.equal(commit(r.sim(), "git add -A && git commit -m x").rule, "commit-secret");
  assert.equal(commit(r.sim(), "git add . && git commit -m x").rule, "commit-secret");
  assert.equal(commit(r.sim(), "git add src && git commit -m x").rule, "commit-secret");
  assert.equal(commit(r.sim(), "git add src/new.js; git commit -m x").rule, "commit-secret");
  assert.equal(commit(r.sim(), "git add .env && git commit -m x").rule, "commit-secret");
  // files the add does not name are not part of the commit
  r.write("fine.txt", "ok\n");
  assert.equal(commit(r.sim(), "git add fine.txt && git commit -m x").decision, "allow");
  assert.equal(commit(r.sim(), "git add README.md && git commit -m x").decision, "allow");
  // a bash -c wrapper does not hide it
  assert.equal(commit(r.sim(), `bash -c "git add -A && git commit -m x"`).rule, "commit-secret");
});

test("git add -u stages modified files but never untracked ones", () => {
  const r = repo();
  r.write("untracked-secret.txt", `${FAKE.github}\n`);
  assert.equal(commit(r.sim(), "git add -u && git commit -m x").decision, "allow");
  r.write("README.md", `${FAKE.github}\n`);
  assert.equal(commit(r.sim(), "git add -u && git commit -m x").rule, "commit-secret");
});

test("a commit with nothing to scan, in a repository or not", () => {
  const r = repo();
  assert.equal(commit(r.sim()).decision, "allow");
  assert.equal(commit(r.sim(), "git commit --amend --no-edit").decision, "allow");
  assert.equal(commit(r.sim(), "git commit --dry-run").decision, "allow");
  const outside = { ...r.sim(), cwd: path.dirname(r.dir), projectDir: path.dirname(r.dir) };
  assert.equal(commit(outside).decision, "allow", "not a repository: nothing to scan");
});

test("git -C scans the other repository, and the commit message is never mistaken for a path", () => {
  const r = repo();
  r.write("a.txt", `${FAKE.github}\n`);
  r.run(["add", "."]);
  const elsewhere = { ...r.sim(), cwd: path.dirname(r.dir), projectDir: path.dirname(r.dir) };
  assert.equal(commit(elsewhere, `git -C ${r.dir.replace(/\\/g, "/")} commit -m "fix .env"`).rule, "commit-secret");
  assert.equal(commit(r.sim(), 'git commit -m "update .env.example docs"').rule, "commit-secret", "the staged secret is still found");
});

test("many findings are summarised, and binary or huge untracked files are skipped", () => {
  const r = repo();
  for (let i = 0; i < 5; i++) r.write(`k${i}.txt`, `${FAKE.github}\n`);
  r.run(["add", "."]);
  const d = commit(r.sim());
  assert.match(d.reason, /and 2 more/);
  assert.ok(d.reason.length < 330, `${d.reason.length} characters`);

  const r2 = repo();
  fs.writeFileSync(path.join(r2.dir, "blob.bin"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(FAKE.github)]));
  fs.writeFileSync(path.join(r2.dir, "big.txt"), `${FAKE.github}\n${"x".repeat(300000)}`);
  assert.equal(commit(r2.sim(), "git add -A && git commit -m x").decision, "allow");
});

test("commit-secret is a floor rule: a pattern cannot allow it, the exact id can", () => {
  const r = repo();
  r.write("a.txt", `${FAKE.github}\n`);
  r.run(["add", "."]);
  assert.equal(bash(r.sim(), "git commit -m x", "relaxed", { allow: ["git commit"] }).decision, "deny");
  assert.equal(bash(r.sim(), "git commit -m x", "relaxed", { allow: ["^git commit"] }).decision, "deny");
  assert.equal(bash(r.sim(), "git commit -m x", "balanced", { allow: ["commit-secret"] }).decision, "allow");
});

// ---------------------------------------------------------------------------------------------
// Reading a diff
// ---------------------------------------------------------------------------------------------

test("parseDiff: names with spaces, renames, new empty files, deletions, and content that looks like a header", () => {
  const diff = [
    "diff --git a/dir one/file two.txt b/dir one/file two.txt",
    "index 111..222 100644",
    "--- a/dir one/file two.txt\t",
    "+++ b/dir one/file two.txt\t",
    "@@ -0,0 +1,2 @@",
    "+first",
    "+++ looks like a header but is content",
    "diff --git a/old.txt b/new.txt",
    "similarity index 100%",
    "rename from old.txt",
    "rename to new.txt",
    "diff --git a/empty.env b/empty.env",
    "new file mode 100644",
    "index 0000000..e69de29",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
  ].join("\n");
  const { files, deleted } = parseDiff(diff);
  assert.deepEqual([...files.keys()], ["dir one/file two.txt", "new.txt", "empty.env", "gone.txt"]);
  assert.equal(files.get("dir one/file two.txt"), "first\n++ looks like a header but is content");
  assert.equal(files.get("gone.txt"), "");
  assert.deepEqual([...deleted], ["gone.txt"]);
  assert.deepEqual(diffFindings(parseDiff(diff)), [{ file: "empty.env", kind: "env file" }]);
});

test("commitFindings deduplicates, and reads untracked files itself", () => {
  const diff = `diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+${FAKE.github}\n+${FAKE.github}\n`;
  const git = (args) => {
    if (args[0] === "diff") return { ok: true, stdout: diff };
    if (args[0] === "ls-files") return { ok: true, stdout: ".env\nnotes.txt\n" };
    return { ok: false, stdout: "" };
  };
  const files = { ".env": "A=1\n", "notes.txt": `${FAKE.aws}\n` };
  const found = commitFindings(git, { cwd: "/r", unstaged: null, untracked: { paths: null } }, (f) => Buffer.from(files[path.basename(f)] || ""));
  assert.deepEqual(found, [{ file: "a.txt", kind: "github-token" }, { file: ".env", kind: "env file" }, { file: "notes.txt", kind: "aws-access-key" }]);
});
