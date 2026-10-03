// The file rules: what Write, Edit, MultiEdit, NotebookEdit and Read do with each path.
// Decisions are written in the order strict, balanced, relaxed: A = allow, K = ask, D = deny.
import test from "node:test";
import assert from "node:assert/strict";
import { LINUX, MAC, WIN, WORD, check } from "./helpers.mjs";
import { secretFileKind, secretKinds } from "../src/secrets.mjs";
import { FAKE } from "./helpers.mjs";

const PRESETS = ["strict", "balanced", "relaxed"];

function table(title, env, rows) {
  for (const [tool, file, d, rule] of rows) {
    test(`${title}: ${tool} ${file}`, () => {
      const field = tool === "NotebookEdit" ? "notebook_path" : "file_path";
      PRESETS.forEach((preset, i) => {
        const r = check(env, tool, { [field]: file }, preset);
        assert.equal(r.decision, WORD[d[i]], `${preset}: ${r.reason || "was allowed"}`);
        if (d[i] !== "A" && rule) assert.equal(r.rule, rule, `${preset}: rule`);
      });
    });
  }
}

const P = "/home/me/proj";

table("secrets files cannot be written", LINUX, [
  ["Write", `${P}/.env`, "DDD", "secret-file-write"],
  ["Edit", `${P}/.env`, "DDD", "secret-file-write"],
  ["MultiEdit", `${P}/.env`, "DDD", "secret-file-write"],
  ["Write", `${P}/.env.local`, "DDD", "secret-file-write"],
  ["Write", `${P}/.env.production`, "DDD", "secret-file-write"],
  ["Write", `${P}/.env.development.local`, "DDD", "secret-file-write"],
  ["Write", `${P}/apps/web/.env`, "DDD", "secret-file-write"],
  ["Write", `${P}/prod.env`, "DDD", "secret-file-write"],
  ["Write", `${P}/secrets.yaml`, "DDD", "secret-file-write"],
  ["Edit", `${P}/secrets.json`, "DDD", "secret-file-write"],
  ["Write", `${P}/config/secrets.toml`, "DDD", "secret-file-write"],
  ["Write", `${P}/server.pem`, "DDD", "secret-file-write"],
  ["Write", `${P}/tls.key`, "DDD", "secret-file-write"],
  ["Write", `${P}/cert.pfx`, "DDD", "secret-file-write"],
  ["Write", `${P}/store.p12`, "DDD", "secret-file-write"],
  ["Write", `${P}/credentials.json`, "DDD", "secret-file-write"],
  ["Write", `${P}/.npmrc`, "DDD", "secret-file-write"],
  ["Write", `${P}/.pypirc`, "DDD", "secret-file-write"],
  ["Write", `${P}/.netrc`, "DDD", "secret-file-write"],
  ["Write", `${P}/.git-credentials`, "DDD", "secret-file-write"],
  ["Write", "/home/me/.ssh/id_rsa", "DDD", "secret-file-write"],
  ["Write", "/home/me/.ssh/id_ed25519", "DDD", "secret-file-write"],
  ["Write", "/home/me/.ssh/id_ecdsa", "DDD", "secret-file-write"],
  ["Write", "/home/me/.ssh/id_rsa_work", "DDD", "secret-file-write"],
  ["Write", "/home/me/.ssh/config", "DDD", "secret-file-write"],
  ["Write", "/home/me/.ssh/authorized_keys", "DDD", "secret-file-write"],
  ["Write", "/home/me/.aws/credentials", "DDD", "secret-file-write"],
  ["Write", "/home/me/.docker/config.json", "DDD", "secret-file-write"],
  ["Write", "/home/me/.kube/config", "DDD", "secret-file-write"],
  ["Write", "/home/me/.gnupg/private-keys-v1.d/x.key", "DDD", "secret-file-write"],
  ["NotebookEdit", `${P}/.env`, "DDD", "secret-file-write"],
]);

table("templates and public keys are not secrets", LINUX, [
  ["Write", `${P}/.env.example`, "AAA"],
  ["Write", `${P}/.env.sample`, "AAA"],
  ["Write", `${P}/.env.template`, "AAA"],
  ["Write", `${P}/.env.dist`, "AAA"],
  ["Write", `${P}/.env.local.example`, "AAA"],
  ["Write", `${P}/secrets.example.yaml`, "AAA"],
  ["Write", `${P}/credentials.json.example`, "AAA"],
  ["Write", `${P}/src/environment.ts`, "AAA"],
  ["Write", `${P}/src/env.js`, "AAA"],
  ["Write", `${P}/.envrc`, "AAA"],
  ["Write", `${P}/keyboard.js`, "AAA"],
  ["Write", "/home/me/.ssh/id_rsa.pub", "DKK", "write-outside-project"],
  ["Write", "/home/me/.ssh/known_hosts", "DKK", "write-outside-project"],
  ["Write", "/home/me/.aws/config", "DKK", "write-outside-project"],
]);

table("lockfiles change through the package manager", LINUX, [
  ["Edit", `${P}/package-lock.json`, "DKA", "lockfile-edit"],
  ["Edit", `${P}/pnpm-lock.yaml`, "DKA", "lockfile-edit"],
  ["Edit", `${P}/yarn.lock`, "DKA", "lockfile-edit"],
  ["Edit", `${P}/Cargo.lock`, "DKA", "lockfile-edit"],
  ["Edit", `${P}/poetry.lock`, "DKA", "lockfile-edit"],
  ["Edit", `${P}/go.sum`, "DKA", "lockfile-edit"],
  ["Edit", `${P}/packages.lock.json`, "DKA", "lockfile-edit"],
  ["Edit", `${P}/Gemfile.lock`, "DKA", "lockfile-edit"],
  ["Edit", `${P}/composer.lock`, "DKA", "lockfile-edit"],
  ["Edit", `${P}/uv.lock`, "DKA", "lockfile-edit"],
  ["Edit", `${P}/npm-shrinkwrap.json`, "DKA", "lockfile-edit"],
  ["Write", `${P}/apps/web/yarn.lock`, "DKA", "lockfile-edit"],
  ["MultiEdit", `${P}/package-lock.json`, "DKA", "lockfile-edit"],
  ["Read", `${P}/package-lock.json`, "AAA"],
  ["Edit", `${P}/package.json`, "AAA"],
  ["Edit", `${P}/go.mod`, "AAA"],
]);

table("inside .git/ is off limits", LINUX, [
  ["Edit", `${P}/.git/config`, "DDD", "git-dir-write"],
  ["Write", `${P}/.git/hooks/pre-commit`, "DDD", "git-dir-write"],
  ["Write", `${P}/.git/HEAD`, "DDD", "git-dir-write"],
  ["Edit", `${P}/sub/.git/config`, "DDD", "git-dir-write"],
  ["Read", `${P}/.git/config`, "AAA"],
  ["Write", `${P}/.gitignore`, "AAA"],
  ["Write", `${P}/.gitattributes`, "AAA"],
  ["Write", `${P}/.gitmodules`, "AAA"],
  ["Write", `${P}/.github/CODEOWNERS`, "AAA"],
]);

table("CI workflows", LINUX, [
  ["Write", `${P}/.github/workflows/ci.yml`, "KAA", "workflow-edit"],
  ["Edit", `${P}/.github/workflows/release.yaml`, "KAA", "workflow-edit"],
  ["Write", `${P}/.github/dependabot.yml`, "AAA"],
  ["Write", `${P}/docs/workflows/ci.yml`, "AAA"],
]);

table("outside the project and the temp folder", LINUX, [
  ["Write", "/etc/hosts", "DKK", "write-outside-project"],
  ["Write", "/home/me/other/a.js", "DKK", "write-outside-project"],
  ["Write", "/home/me/.bashrc", "DKK", "write-outside-project"],
  ["Write", "/usr/local/bin/x", "DKK", "write-outside-project"],
  ["Edit", `${P}/../other/x`, "DKK", "write-outside-project"],
  ["Write", "/home/me/proj-two/a.js", "DKK", "write-outside-project"],
  ["Write", "/tmp/x.txt", "AAA"],
  ["Write", "/var/tmp/x", "AAA"],
  ["Write", `${P}/src/a.js`, "AAA"],
  ["Write", `${P}/src/../lib/a.js`, "AAA"],
  ["NotebookEdit", `${P}/analysis.ipynb`, "AAA"],
  ["NotebookEdit", "/home/me/other/a.ipynb", "DKK", "write-outside-project"],
  ["Read", "/etc/passwd", "AAA"],
  ["Read", "/home/me/other/a.js", "AAA"],
]);

table("Claude's own config folder is not outside, but its settings are guarded", LINUX, [
  ["Write", "/home/me/.claude/projects/p/memory/a.md", "AAA"],
  ["Write", "/home/me/.claude/plans/x.md", "AAA"],
  ["Edit", "/home/me/.claude/CLAUDE.md", "AAA"],
  ["Write", "/home/me/.claude/skills/x/SKILL.md", "AAA"],
  ["Write", "/home/me/.claude/settings.json", "DKK", "guardrails-tamper"],
  ["Edit", "/home/me/.claude/settings.local.json", "DKK", "guardrails-tamper"],
  ["Write", "/home/me/.claude/guardrails.json", "DKK", "guardrails-tamper"],
  ["Write", "/home/me/.claude/claude-code-guardrails/guard.mjs", "DKK", "guardrails-tamper"],
  ["Edit", `${P}/.claude/settings.json`, "DKK", "guardrails-tamper"],
  ["Edit", `${P}/.claude/settings.local.json`, "DKK", "guardrails-tamper"],
  ["Write", `${P}/.claude/guardrails.json`, "DKK", "guardrails-tamper"],
  ["Write", `${P}/.claude/guardrails/guard.mjs`, "DKK", "guardrails-tamper"],
  ["Edit", `${P}/.claude/guardrails/src/decide.mjs`, "DKK", "guardrails-tamper"],
  ["Write", `${P}/.claude/skills/x/SKILL.md`, "AAA"],
  ["Write", `${P}/.claude/commands/x.md`, "AAA"],
  ["Write", `${P}/CLAUDE.md`, "AAA"],
  ["Read", `${P}/.claude/settings.json`, "AAA"],
]);

table("reading", LINUX, [
  ["Read", `${P}/.env`, "DKA", "secret-file-read"],
  ["Read", `${P}/.env.production`, "DKA", "secret-file-read"],
  ["Read", `${P}/.env.example`, "AAA"],
  ["Read", "/home/me/.ssh/id_rsa", "DKA", "secret-file-read"],
  ["Read", "/home/me/.ssh/id_rsa.pub", "AAA"],
  ["Read", "/home/me/.aws/credentials", "DKA", "secret-file-read"],
  ["Read", `${P}/.npmrc`, "DKA", "secret-file-read"],
  ["Read", `${P}/secrets.yaml`, "DKA", "secret-file-read"],
  ["Read", `${P}/src/a.js`, "AAA"],
  ["Read", `${P}/README.md`, "AAA"],
]);

table("relative paths resolve against the working folder", LINUX, [
  ["Write", ".env", "DDD", "secret-file-write"],
  ["Write", "src/a.js", "AAA"],
  ["Write", "../other/x", "DKK", "write-outside-project"],
  ["Write", "./package-lock.json", "DKA", "lockfile-edit"],
]);

table("Windows paths", WIN, [
  ["Write", "C:\\Users\\me\\proj\\.env", "DDD", "secret-file-write"],
  ["Write", "C:/Users/me/proj/.env", "DDD", "secret-file-write"],
  ["Write", "c:\\users\\me\\PROJ\\.ENV.local", "DDD", "secret-file-write"],
  ["Write", "C:\\Users\\me\\proj\\src\\a.js", "AAA"],
  ["Write", "C:/Users/me/proj/src/a.js", "AAA"],
  ["Write", "c:\\users\\me\\PROJ\\SRC\\a.js", "AAA"],
  ["Write", "src\\a.js", "AAA"],
  ["Write", "C:\\Users\\me\\other\\a.js", "DKK", "write-outside-project"],
  ["Write", "C:\\Users\\me\\proj2\\a.js", "DKK", "write-outside-project"],
  ["Write", "D:\\x.txt", "DKK", "write-outside-project"],
  ["Write", "C:\\Windows\\System32\\drivers\\etc\\hosts", "DKK", "write-outside-project"],
  ["Write", "\\\\server\\share\\x.txt", "DKK", "write-outside-project"],
  ["Write", "C:\\Users\\me\\AppData\\Local\\Temp\\x.txt", "AAA"],
  ["Write", "C:\\Users\\me\\AppData\\Local\\Temp", "DKK", "write-outside-project"],
  ["Edit", "c:\\users\\me\\PROJ\\package-lock.json", "DKA", "lockfile-edit"],
  ["Edit", "C:\\Users\\me\\proj\\.git\\config", "DDD", "git-dir-write"],
  ["Write", "C:\\Users\\me\\proj\\.github\\workflows\\ci.yml", "KAA", "workflow-edit"],
  ["Write", "C:\\Users\\me\\.ssh\\id_ed25519", "DDD", "secret-file-write"],
  ["Read", "C:\\Users\\me\\.ssh\\id_ed25519", "DKA", "secret-file-read"],
  ["Read", "C:\\Users\\me\\.ssh\\id_ed25519.pub", "AAA"],
  ["Write", "C:\\Users\\me\\.claude\\settings.json", "DKK", "guardrails-tamper"],
  ["Write", "C:\\Users\\me\\.claude\\projects\\p\\memory\\m.md", "AAA"],
  ["Write", "C:\\Users\\me\\proj\\.claude\\guardrails.json", "DKK", "guardrails-tamper"],
]);

table("macOS paths", MAC, [
  ["Write", "/Users/me/proj/src/a.js", "AAA"],
  ["Write", "/private/var/folders/zz/T/x", "AAA"],
  ["Write", "/var/folders/zz/T/x", "AAA"],
  ["Write", "/Users/me/other/a.js", "DKK", "write-outside-project"],
  ["Write", "/Users/me/.ssh/id_rsa", "DDD", "secret-file-write"],
  ["Write", "/Library/LaunchDaemons/x.plist", "DKK", "write-outside-project"],
]);

test("a project that is a whole home folder only counts paths two levels down as inside it", () => {
  const home = { ...LINUX, cwd: "/home/me", projectDir: "/home/me" };
  const w = (p, preset = "balanced") => check(home, "Write", { file_path: p }, preset).decision;
  assert.equal(w("/home/me/work/proj/a.js"), "allow");
  assert.equal(w("/home/me/notes.md"), "ask");
  assert.equal(w("/home/me/.bashrc"), "ask");
  assert.equal(check(home, "Bash", { command: "rm -rf ~" }).decision, "deny");
  assert.equal(check(home, "Bash", { command: "rm -rf ~/work/proj/build" }).decision, "allow");
  assert.equal(check(home, "Bash", { command: "rm -rf ~/Documents" }).decision, "ask");
});

test("the same for a project that is a whole drive", () => {
  const drive = { ...WIN, cwd: "D:\\", projectDir: "D:\\" };
  const w = (p) => check(drive, "Write", { file_path: p }).decision;
  assert.equal(w("D:\\work\\proj\\a.js"), "allow");
  assert.equal(w("D:\\work\\a.js"), "allow");
  assert.equal(w("D:\\notes.txt"), "ask");
  assert.equal(w("E:\\work\\proj\\a.js"), "ask");
  assert.equal(check(drive, "Bash", { command: "rm -rf /d/" }).decision, "deny");
  assert.equal(check(drive, "Bash", { command: "rm -rf /d/work/proj/build" }).decision, "allow");
});

test("unknown tools, missing fields and odd input are allowed without a fuss", () => {
  assert.equal(check(LINUX, "Glob", { pattern: "**/*" }).decision, "allow");
  assert.equal(check(LINUX, "mcp__x__y", { command: "rm -rf /" }).decision, "allow");
  assert.equal(check(LINUX, "Bash", {}).decision, "allow");
  assert.equal(check(LINUX, "Bash", { command: 42 }).decision, "allow");
  assert.equal(check(LINUX, "Bash", { command: "" }).decision, "allow");
  assert.equal(check(LINUX, "Write", {}).decision, "allow");
  assert.equal(check(LINUX, "Write", { file_path: "" }).decision, "allow");
  assert.equal(check(LINUX, "Read", null).decision, "allow");
  assert.equal(check(LINUX, "", {}).decision, "allow");
});

// ---------------------------------------------------------------------------------------------
// The names and contents that count as secrets
// ---------------------------------------------------------------------------------------------

test("secretFileKind: names and folders", () => {
  const yes = [".env", ".env.local", ".env.production", "a/b/.env", "prod.env", "id_rsa", "id_ed25519", "id_rsa_backup", "x.pem", "x.key", "x.pfx", "x.p12",
    "credentials.json", ".aws/credentials", "secrets.yaml", "secrets.json", ".npmrc", ".pypirc", ".netrc", "_netrc", ".git-credentials", ".ssh/config", ".ssh/authorized_keys",
    ".gnupg/pubring.kbx", ".docker/config.json", ".kube/config", "C:\\Users\\me\\.ssh\\id_rsa", "C:\\x\\.ENV"];
  const no = ["", ".env.example", ".env.sample", ".env.template", ".env.dist", "secrets.example.yaml", "id_rsa.pub", "id_ed25519.pub", ".ssh/known_hosts", ".ssh/id_rsa.pub", "env.js", "environment.ts", ".envrc",
    "credentials", "config.json", ".aws/config", "keys.js", "monkey.ts", "package.json", "README.md", ".github/workflows/ci.yml"];
  for (const p of yes) assert.notEqual(secretFileKind(p), "", `${p} should be a secrets file`);
  for (const p of no) assert.equal(secretFileKind(p), "", `${p} should not be a secrets file`);
});

test("secretKinds finds the kinds of secret and never reports placeholders", () => {
  assert.deepEqual(secretKinds(`token = "${FAKE.github}"`), ["github-token"]);
  assert.deepEqual(secretKinds(`k = ${FAKE.aws}`), ["aws-access-key"]);
  assert.ok(secretKinds(FAKE.awsSecret).includes("aws-secret"));
  assert.ok(secretKinds(FAKE.anthropic).includes("anthropic-key"));
  assert.ok(secretKinds(FAKE.stripe).includes("stripe-key"));
  assert.ok(secretKinds(FAKE.slack).includes("slack-token"));
  assert.deepEqual(secretKinds(FAKE.pem), ["private-key"]);
  assert.deepEqual(secretKinds("-----BEGIN " + "OPENSSH PRIVATE KEY-----\nabc"), ["private-key"], "a header alone is enough");
  assert.ok(secretKinds(FAKE.password).includes("env-secret"));
  assert.deepEqual(secretKinds("postgres://app:" + "s3cretpass" + "@db:5432/x"), ["url-password"]);
  assert.deepEqual(secretKinds("Authorization: Bearer " + "abcdefghijklmnopqrstuvwxyz0123"), ["bearer-token"]);
  for (const ok of ["password: string", "PASSWORD=${DB_PASSWORD}", "API_KEY=changeme", "API_KEY=xxxxxxxx", "TOKEN=<your-token>", "SECRET=$SECRET", "password = 'your-password'", "const apiKey = process.env.KEY", "hello world", ""]) {
    assert.deepEqual(secretKinds(ok), [], JSON.stringify(ok));
  }
});
