// Everything that talks to git: the runner, the current branch, protected-branch matching and the
// secret scan of what a commit is about to contain. git is only started for `git commit` and for a
// push that names no branch (see checks.mjs); every other check is pure string work.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { secretFileKind, secretKinds } from "./secrets.mjs";

/** Run git. Never throws: { ok: false } on any failure, a timeout included. */
export function runGit(args, { cwd, timeout = 5000 } = {}) {
  try {
    const r = spawnSync("git", args, {
      cwd, encoding: "utf8", timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    if (r.error || r.status !== 0) return { ok: false, stdout: "" };
    return { ok: true, stdout: r.stdout || "" };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/** Branch patterns such as "main" or "release/*" -> a test function. `*` matches anything. */
export function branchMatcher(patterns) {
  const res = (patterns || []).filter((p) => typeof p === "string" && p).map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));
  return (branch) => res.some((re) => re.test(branch));
}

// ---------------------------------------------------------------------------------------------
// Reading a unified diff (git diff -U0): which files, and what was added to each
// ---------------------------------------------------------------------------------------------

const unquote = (p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1).replace(/\\(.)/g, "$1") : p);

/**
 * { files: Map(name -> text of the added lines), deleted: Set(name) }. Files with no content
 * lines (an empty new file, a pure rename) are listed too.
 */
export function parseDiff(diff) {
  const files = new Map();
  const deleted = new Set();
  let current = null;
  let inHeader = false;
  const touch = (name) => { if (name && !files.has(name)) files.set(name, []); return name; };
  for (const line of String(diff).split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      current = null;
      // "a/P b/P": when both sides are the same path, half of what is left is the path
      const rest = line.slice(11);
      const len = (rest.length - 5) / 2;
      if (rest.startsWith("a/") && Number.isInteger(len) && rest.slice(2, 2 + len) === rest.slice(5 + len)) current = touch(rest.slice(2, 2 + len));
      continue;
    }
    if (inHeader) {
      if (line.startsWith("@@")) { inHeader = false; continue; }
      if (line.startsWith("deleted file mode") && current) deleted.add(current);
      else if (line.startsWith("rename to ") || line.startsWith("copy to ")) current = touch(unquote(line.slice(line.indexOf(" to ") + 4)));
      else if (line.startsWith("+++ ")) {
        const p = unquote(line.slice(4).replace(/\t.*$/, "")); // git appends a tab to names with spaces
        current = p === "/dev/null" ? current : touch(p.replace(/^b\//, ""));
      }
      continue;
    }
    if (current && line.startsWith("+")) files.get(current).push(line.slice(1));
  }
  return { files: new Map([...files].map(([k, v]) => [k, v.join("\n")])), deleted };
}

const MAX_SCAN_CHARS = 1000000; // per file; a secret is never this far into a file that matters

// .npmrc is committed on purpose in many projects (registry settings): only what is inside it counts.
const blockedName = (name) => (/(^|\/)\.npmrc$/.test(name) ? "" : secretFileKind(name));

/** [{ file, kind }] for one parsed diff: secrets in added lines, and secrets files being added. */
export function diffFindings({ files, deleted }) {
  const out = [];
  for (const [name, text] of files) {
    if (deleted.has(name)) continue;
    const kind = blockedName(name);
    if (kind) out.push({ file: name, kind });
    for (const k of secretKinds(text.slice(0, MAX_SCAN_CHARS))) out.push({ file: name, kind: k });
  }
  return out;
}

const SCAN_BUDGET_MS = 7000;
const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_BYTES = 256 * 1024;

/**
 * What the commit is about to contain, as far as it can be known before the command runs.
 * plan: { cwd, unstaged: null | { paths: string[] | null }, untracked: null | { paths: string[] | null } }
 * The staged diff is always scanned; the others cover `git commit -a`, `git add ... && git commit`.
 * Returns [{ file, kind }], deduplicated. Secret values are never part of the result.
 */
export function commitFindings(git, plan, readFile = (f) => fs.readFileSync(f)) {
  const found = [];
  // Each call may take 5 s, the whole scan 7 s: the hook itself is stopped at 10. What cannot be scanned in time is skipped.
  const deadline = Date.now() + SCAN_BUDGET_MS;
  const run = (args) => {
    const left = deadline - Date.now();
    return left < 300 ? { ok: false, stdout: "" } : git(args, { cwd: plan.cwd, timeout: Math.min(5000, left) });
  };
  const scanDiff = (r) => { if (r.ok) found.push(...diffFindings(parseDiff(r.stdout))); };

  scanDiff(run(["diff", "--cached", "--no-color", "-U0"]));
  if (plan.unstaged) scanDiff(run(["diff", "--no-color", "-U0", ...(plan.unstaged.paths ? ["--", ...plan.unstaged.paths] : [])]));
  if (plan.untracked) {
    const r = run(["ls-files", "--others", "--exclude-standard", ...(plan.untracked.paths ? ["--", ...plan.untracked.paths] : [])]);
    if (r.ok) {
      for (const name of r.stdout.split("\n").filter(Boolean).slice(0, MAX_UNTRACKED_FILES)) {
        const kind = blockedName(name);
        if (kind) found.push({ file: name, kind });
        try {
          const buf = readFile(path.resolve(plan.cwd || ".", name));
          if (buf.length > MAX_UNTRACKED_BYTES || buf.includes(0)) continue; // too big to be a config file, or binary
          for (const k of secretKinds(buf.toString("utf8"))) found.push({ file: name, kind: k });
        } catch { /* gone or unreadable: nothing to scan */ }
      }
    }
  }
  const seen = new Set();
  return found.filter((f) => { const id = `${f.file}\0${f.kind}`; if (seen.has(id)) return false; seen.add(id); return true; });
}
