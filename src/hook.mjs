// The PreToolUse hook: read the event from stdin, decide, print a decision or nothing at all.
//
// Printing nothing is how a call is allowed, and it is the common case: the model sees nothing, the
// person sees nothing, and Claude Code's own permission prompts stay in charge. A hook must never
// get in the way of a session, so any error ends silently with exit code 0 (and a line in
// <configDir>/claude-code-guardrails/errors.log).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir, findProjectRoot, guardDir, loadConfig } from "./config.mjs";
import { decide, hookOutput } from "./decide.mjs";
import { runGit } from "./gitutil.mjs";

const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

/** The machine and project the checks reason about, from the hook input and the environment. */
export function realEnvironment(input = {}, penv = process.env) {
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const projectDir = (penv.CLAUDE_PROJECT_DIR && penv.CLAUDE_PROJECT_DIR.trim()) || findProjectRoot(cwd);
  const tmp = os.tmpdir();
  const list = (xs) => [...new Set(xs.filter(Boolean))];
  return {
    platform: process.platform,
    cwd,
    projectDir,
    projectDirs: list([projectDir, real(projectDir)]), // macOS: /var is a link to /private/var
    home: os.homedir(),
    tmpDirs: list([tmp, real(tmp), "/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp", penv.TEMP, penv.TMP, penv.TMPDIR]),
    configDir: configDir(penv),
    git: runGit,
  };
}

function logError(cfg, err) {
  try {
    const dir = guardDir(cfg);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "errors.log");
    try { if (fs.statSync(file).size > 200000) fs.writeFileSync(file, fs.readFileSync(file, "utf8").slice(-50000)); } catch { /* new file */ }
    // The stack and message only: never the command or the event, which can hold secrets.
    fs.appendFileSync(file, `${new Date().toISOString()} ${String((err && err.stack) || err).split("\n").slice(0, 4).join(" | ")}\n`);
  } catch { /* nowhere to log: stay quiet */ }
}

// The event from stdin. Claude Code closes stdin after writing it; should one ever not, the answer
// is given as soon as a complete JSON document has arrived (or after 8 seconds), never waited for.
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8").replace(/^﻿/, ""));
      process.stdin.destroy(); // let the process end even if the pipe stays open
    };
    const timer = setTimeout(finish, 8000);
    process.stdin.on("data", (d) => {
      chunks.push(d);
      if (d[d.length - 1] === 0x7d || d[d.length - 1] === 0x0a) { // "}" or a newline: maybe the whole event
        try { JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^﻿/, "")); finish(); } catch { /* more is coming */ }
      }
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

export async function runHook() {
  process.exitCode = 0;
  if (process.stdin.isTTY) {
    process.stderr.write("claude-code-guardrails: this is a Claude Code hook; it reads a PreToolUse event as JSON on stdin. Run `claude-guardrails --help` for the command line.\n");
    return;
  }
  let cfg = null;
  try {
    const raw = await readStdin();
    let input;
    try { input = JSON.parse(raw); } catch { return; } // not an event: nothing to say
    if (!input || typeof input !== "object") return;
    const env = realEnvironment(input);
    cfg = env.configDir;
    const config = loadConfig({ env: process.env, projectDir: env.projectDir });
    const out = hookOutput(decide(input, { env, config }));
    if (out) process.stdout.write(out);
  } catch (err) {
    logError(cfg || configDir(), err);
  }
}
