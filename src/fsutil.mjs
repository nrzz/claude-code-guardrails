// Small file helpers: tolerant reads, atomic writes, recursive copy, backup names.
import fs from "node:fs";
import path from "node:path";

export const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

/** File text with a BOM removed, or null when it cannot be read. */
export function readText(file) {
  try { return fs.readFileSync(file, "utf8").replace(/^﻿/, ""); } catch { return null; }
}

/**
 * Read a JSON object file without ever modifying it.
 * status: "missing" | "ok" (data is a plain object; an empty file counts as {}) | "invalid".
 */
export function readJsonFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return e && e.code === "ENOENT" ? { status: "missing", data: {}, raw: null } : { status: "invalid", data: null, raw: null, error: "cannot be read" };
  }
  const text = raw.replace(/^﻿/, "");
  if (!text.trim()) return { status: "ok", data: {}, raw };
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object" && !Array.isArray(data)) return { status: "ok", data, raw };
    return { status: "invalid", data: null, raw, error: "is not a JSON object" };
  } catch (e) {
    return { status: "invalid", data: null, raw, error: "is not valid JSON" };
  }
}

/**
 * Write through a temp file and rename, so a reader never sees half a file. Falls back to a direct
 * write where rename-over-existing is refused (Windows, file held open by another process).
 */
export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    fs.writeFileSync(file, data);
  }
}

/** The indentation a JSON text already uses (two spaces when it has none). */
export function detectIndent(raw) {
  const m = /^[ \t]+(?=")/m.exec(raw || "");
  return m ? m[0] : "  ";
}

/** Write JSON the way the file (given as its old text) was written: its indentation and its line endings. */
export function writeJsonFile(file, data, raw = null) {
  const text = JSON.stringify(data, null, detectIndent(raw)) + "\n";
  writeFileAtomic(file, raw && raw.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text);
}

/** Copy a folder recursively, overwriting files. Symbolic links are skipped. */
export function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

// Remove whatever is in `to` but no longer in `from`.
function prune(from, to) {
  for (const entry of fs.readdirSync(to, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (!fs.existsSync(src)) fs.rmSync(dst, { recursive: true, force: true });
    else if (entry.isDirectory()) prune(src, dst);
  }
}

/** Make `to` mirror `from`: copy everything over, then drop files an older version left behind. */
export function syncDir(from, to) {
  copyDir(from, to);
  prune(from, to);
}

const two = (n) => String(n).padStart(2, "0");

/** 20261003-201530 (local time), used in backup file names. */
export function timestamp(d = new Date()) {
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

/** A path that does not exist yet: `base`, else `base-1`, `base-2` ... */
export function uniquePath(base) {
  if (!fs.existsSync(base)) return base;
  for (let i = 1; i < 1000; i++) if (!fs.existsSync(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

/** Two spellings of one folder, symbolic links resolved (macOS: /var is a link to /private/var). */
export function samePath(a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); }
}
