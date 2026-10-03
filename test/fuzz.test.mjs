// Whatever is thrown at it, the engine answers: never an exception, always a well-formed decision.
import test from "node:test";
import assert from "node:assert/strict";
import { LINUX, WIN, check, bash, pwsh } from "./helpers.mjs";

// A small deterministic generator, so a failure can be reproduced.
function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const FRAGMENTS = ["rm", "-rf", "-r", "-f", "/", "~", ".", "..", "*", "$HOME", '"', "'", "`", "$(", ")", "(", "{", "}", "&&", "||", ";", "|", "&", "\n", "<<EOF", "EOF", "<<<", ">", ">>", "2>&1",
  "<(", "git", "push", "--force", "origin", "main", "-C", "commit", "-am", "bash", "-c", "sh", "sudo", "env", "A=B", "xargs", "find", "-delete", "-exec", "{}", "\\", "\\;", "+", "psql", "-e",
  "DROP TABLE x", "curl", "http://x", "| sh", ".env", "Remove-Item", "-Recurse", "-Force", "C:\\", "$env:TEMP", "iex", "irm", "@'", "'@", "cmd", "/c", "rd", "/s", "/q", "powershell", "-Command",
  "#", "<#", "#>", "${", "$'a\\n'", "\u0000", "é", "😀", "  ", "\t", "echo", "cat", "tee", "cp", "mv", "sed", "-i", "dd", "of=/dev/sda", "chmod", "-R", "777", "terraform", "destroy", "docker",
  "system", "prune", "-a", "npm", "publish", "kubectl", "delete", "aws", "s3", "--recursive"];

const PATHS = ["/", "~", "C:\\", "", "a b", "../x", ".env", "\u0000", "é/😀", "C:", "//server/share", "/c/", "x".repeat(300), "${HOME}", "$(pwd)", "/home/me/proj/.git/x", "C:\\Users\\me\\proj\\.env"];

const wellFormed = (r, where) => {
  assert.ok(["allow", "ask", "deny"].includes(r.decision), where);
  if (r.decision === "allow") assert.equal(r.reason, "", where);
  else {
    assert.match(r.reason, /^guardrails: .+ \(rule [a-z-]+\)/, where);
    assert.ok(r.reason.length < 400, `${where}: ${r.reason.length} characters`);
    assert.ok(!r.reason.includes("\n"), where);
  }
  assert.ok(Array.isArray(r.findings), where);
};

test("random mixtures of shell fragments never throw, in Bash, PowerShell and Git Bash, in two presets", () => {
  const rnd = prng(20261004);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  let stopped = 0;
  for (let i = 0; i < 3000; i++) {
    let s = "";
    for (let k = 1 + Math.floor(rnd() * 12); k > 0; k--) s += pick(FRAGMENTS) + (rnd() < 0.7 ? " " : "");
    for (const [env, run] of [[LINUX, bash], [WIN, pwsh], [WIN, bash]]) {
      for (const preset of ["balanced", "strict"]) {
        let r;
        assert.doesNotThrow(() => { r = run(env, s, preset); }, JSON.stringify(s));
        wellFormed(r, JSON.stringify(s));
        if (r.decision !== "allow") stopped++;
      }
    }
  }
  assert.ok(stopped > 100, `${stopped} of 18000 were stopped: the generator reaches the rules`);
});

test("random paths never throw in the file tools, on Linux and Windows", () => {
  const rnd = prng(7);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  for (let i = 0; i < 2000; i++) {
    const p = pick(PATHS) + pick(["", "/a", "\\b", "/*", "/.git/x", ".pem", "/id_rsa"]);
    for (const tool of ["Write", "Read", "Edit", "MultiEdit"]) for (const env of [LINUX, WIN]) {
      let r;
      assert.doesNotThrow(() => { r = check(env, tool, { file_path: p }); }, JSON.stringify(p));
      wellFormed(r, `${tool} ${JSON.stringify(p)}`);
    }
  }
});

test("the same input always gives the same answer, and a decision never depends on an earlier call", () => {
  const rnd = prng(99);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const cmds = Array.from({ length: 300 }, () => Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => pick(FRAGMENTS)).join(" "));
  const first = cmds.map((c) => JSON.stringify(bash(LINUX, c)));
  for (const c of [...cmds].reverse()) bash(WIN, c); // other work in between
  assert.deepEqual(cmds.map((c) => JSON.stringify(bash(LINUX, c))), first);
});

test("a reason never contains the text of a secret that was in the command", () => {
  const secret = "gh" + "p_" + "q".repeat(36);
  for (const c of [`echo ${secret} > .env`, `cat .env # ${secret}`, `rm -rf / # ${secret}`, `git push --force origin main # ${secret}`, `psql -c "DROP TABLE ${secret}"`]) {
    const r = bash(LINUX, c);
    assert.notEqual(r.decision, "allow", c);
    assert.ok(!JSON.stringify(r).includes(secret), c);
  }
});
