// The file rules, for one path and one kind of access. Used for the Write, Edit, MultiEdit,
// NotebookEdit and Read tools, and for what a shell command does to files (redirects, tee, cp, mv,
// sed -i, rm ...), so the same rules cannot be sidestepped by going through the shell.
//
//   op "read"    only secrets files matter (they would land in the conversation)
//   op "write"   everything: secrets, .git, lockfiles, workflows, the guardrails files, outside the project
//   op "delete"  secrets files and the guardrails files; deleting a lockfile to reinstall is routine

import { secretFileKind } from "./secrets.mjs";

const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "cargo.lock", "poetry.lock",
  "pipfile.lock", "uv.lock", "composer.lock", "go.sum", "packages.lock.json", "gemfile.lock",
]);

// Files that switch the guard off or change what it decides: its config and scripts, and the
// settings files that register its hook.
const TAMPER_NAME = /(^|\/)\.claude\/(guardrails\.json|guardrails(\/|$)|settings(\.local)?\.json$)/i;

const baseName = (p) => p.replace(/\/+$/, "").split("/").pop();
const shorten = (s, n = 60) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// /dev/null and the other places a shell may write that are not files.
const HARMLESS_DEVICE = /^\/dev\/(?:null|zero|full|random|urandom|stdin|stdout|stderr|tty|ptmx|console|fd\/\d+|pts\/\d+|shm(?:\/.*)?)$/;
// Block devices: writing to one overwrites a disk.
const BLOCK_DEVICE = /^\/dev\/(?:sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d|disk\d|rdisk\d|mapper\/|md\d|dm-\d|loop\d|sr\d|mem$|kmem$|port$)/;

/** What a shell redirect or a dd target points at: "null" (ignore), "disk" (block device) or "file". */
export function targetKind(value) {
  const t = String(value).trim().replace(/\\/g, "/");
  if (/^(?:nul:?|\$null)$/i.test(t) || HARMLESS_DEVICE.test(t)) return "null";
  if (BLOCK_DEVICE.test(t)) return "disk";
  return "file";
}

/**
 * Check one path. `a` is the analysis context; findings go to a.add(rule, detail, subject).
 * opts.nameOnly: judge the name alone, not where it points (a copy into a folder that may not be one).
 */
export function checkFile(a, value, op, subject, opts = {}) {
  const text = String(value).replace(/\\/g, "/");
  const kind = secretFileKind(text);
  if (kind) a.add(op === "read" ? "secret-file-read" : "secret-file-write", `${kind}: ${shorten(baseName(text))}`, subject);
  if (op === "read") return;

  const resolved = opts.nameOnly ? { unknown: true } : a.paths.resolve(value, a.cwdKey);
  const key = resolved.unknown ? null : resolved.key;
  const configKey = a.env.configDir ? a.paths.keyOf(a.env.configDir, null) : null;

  const inConfigDir = !!key && !!configKey && a.paths.under(key, configKey);
  const tampers = TAMPER_NAME.test(text) || (op === "delete" && /(^|\/)\.claude\/?$/.test(text))
    || (inConfigDir && (/^(?:guardrails\.json|settings(?:\.local)?\.json)$/.test(key.slice(configKey.length + 1)) || key === configKey + "/claude-code-guardrails" || key.startsWith(configKey + "/claude-code-guardrails/")));
  if (tampers) a.add("guardrails-tamper", shorten(baseName(text)), subject);
  if (op !== "write") return;

  if (/(^|\/)\.git(\/|$)/.test(text) || (key && a.paths.hasGitFolder(key))) a.add("git-dir-write", shorten(text), subject);
  if (LOCKFILES.has(baseName(text).toLowerCase())) a.add("lockfile-edit", baseName(text), subject);
  if (/(^|\/)\.github\/workflows\/[^/]+$/.test(text)) a.add("workflow-edit", shorten(baseName(text)), subject);
  // Outside the project and the temp folder. Claude's own config folder (memory, plans) is not "outside".
  if (key && !a.paths.insideProject(key) && !a.paths.underTemp(key) && !inConfigDir) a.add("write-outside-project", shorten(text), subject);
}
