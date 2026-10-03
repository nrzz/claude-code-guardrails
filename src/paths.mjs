// Paths as the checks need them: expand ~ and the few variables whose value is known, make the
// result absolute, normalize it, and answer "is this inside the project / the temp folder / a
// root or system folder?".
//
// Everything here is string work driven by an `env` object ({ platform, cwd, projectDir, home,
// tmpDirs }), so the same code can be tested as Windows or as Linux on any machine, and a check
// never touches the file system.
//
// A path becomes a "key": absolute, forward slashes, no trailing slash, lower case on Windows.
//   posix:    /home/me/app            win32:  c:/users/me/app    //server/share/x    /tmp/x (Git Bash)

import path from "node:path";

// Top-level folders whose deletion or recursive chmod is never what anyone meant.
const POSIX_SYSTEM = new Set([
  "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64", "/libx32", "/media", "/mnt", "/nix", "/opt",
  "/proc", "/root", "/run", "/sbin", "/snap", "/srv", "/sys", "/usr", "/var",
  "/users", "/system", "/library", "/applications", "/volumes", "/private", // macOS, lower case: compared lower case
]);
const WIN_SYSTEM = /^[a-z]:\/(windows|users|program files|program files \(x86\)|programdata|recovery|boot|windows\/(system32|syswow64|winsxs))$/;

// Glob components that match everything in a folder.
const ALL_GLOB = /^(\*+|\.\*|\*\.\*|\.\[!\.\]\*|\.\.\?\*)$/;

const trimSlash = (k) => (k.length > 1 && k.endsWith("/") && !/^[a-z]:\/$/.test(k) ? k.slice(0, -1) : k);

export function makePaths(env) {
  const win = env.platform === "win32";
  const fold = (s) => (win ? s.toLowerCase() : s);

  // Turn text into a key, relative paths against `baseKey`. Null when it cannot be made absolute.
  function keyOf(text, baseKey) {
    let t = String(text);
    if (win) {
      t = t.replace(/\\/g, "/");
      t = t.replace(/^\/(?:mnt\/|cygdrive\/)?([a-zA-Z])(?=\/|$)/, "$1:"); // Git Bash, WSL, Cygwin: /c/Users -> c:/Users
    }
    let drive = "";
    let rest = t;
    const dm = win ? /^([a-zA-Z]):(?![^/])/.exec(t) : null; // "C:" or "C:/..." but not "C:foo"
    if (dm) { drive = dm[1].toLowerCase() + ":"; rest = t.slice(2); }
    else if (win && /^[a-zA-Z]:/.test(t)) return null; // "C:foo" is relative to a drive's own working folder
    else if (win && t.startsWith("//")) return fold(trimSlash("//" + path.posix.normalize("/" + t.slice(2)).slice(1)));

    if (!drive && !rest.startsWith("/")) { // relative: join with the base
      if (!baseKey) return null;
      const b = splitKey(baseKey);
      return fold(b.drive + trimSlash(path.posix.normalize(`${b.rest}/${rest}`)));
    }
    return fold(drive + trimSlash(path.posix.normalize(rest || "/")));
  }

  const splitKey = (key) => {
    const m = /^([a-z]:)?(\/.*)$/.exec(key);
    return m ? { drive: m[1] || "", rest: m[2] } : { drive: "", rest: "/" };
  };

  const withSlash = (k) => (k.endsWith("/") ? k : k + "/");
  const under = (child, base) => !!child && !!base && (child === base || child.startsWith(withSlash(base)));

  const homeKey = env.home ? keyOf(env.home, null) : null;
  const projectKeys = [...new Set([env.projectDir, ...(env.projectDirs || [])].filter(Boolean).map((p) => keyOf(p, null)).filter(Boolean))];
  const tmpKeys = [...new Set((env.tmpDirs || []).filter(Boolean).map((p) => keyOf(p, null)).filter(Boolean))];
  const baseCwd = keyOf(env.cwd || env.projectDir || "/", null);
  const projectIsBroad = projectKeys.some((p) => p === "/" || /^[a-z]:\/$/.test(p) || (homeKey && under(homeKey, p)));

  // Values of the variables worth knowing. Anything else makes a path unknown.
  function knownVar(name, cwdKey) {
    const n = win ? name.toLowerCase() : name;
    const pick = (...names) => names.includes(n) || (win && names.map((x) => x.toLowerCase()).includes(n));
    if (pick("HOME", "USERPROFILE")) return env.home || null;
    if (pick("PWD")) return cwdKey;
    if (pick("TMPDIR", "TMP", "TEMP")) return env.tmpDirs && env.tmpDirs[0] ? env.tmpDirs[0] : null;
    if (pick("CLAUDE_PROJECT_DIR")) return env.projectDir || null;
    if (win && pick("SystemDrive")) return "C:";
    if (win && pick("SystemRoot", "windir")) return "C:/Windows";
    if (win && pick("ProgramFiles")) return "C:/Program Files";
    if (win && pick("ProgramData")) return "C:/ProgramData";
    if (win && env.home && pick("APPDATA")) return env.home + "/AppData/Roaming";
    if (win && env.home && pick("LOCALAPPDATA")) return env.home + "/AppData/Local";
    return null;
  }

  // ~ and variables expanded where their value is known; { unknown: true } when something is left.
  function expand(value, cwdKey) {
    let t = String(value);
    if (/^(\$\(\s*pwd(\s+-[LP])?\s*\)|`\s*pwd\s*`)$/.test(t.trim())) return { text: cwdKey || "", unknown: !cwdKey };
    if (/^\(.*\)$/s.test(t) || /^[<>]\(/.test(t)) return { unknown: true }; // a PowerShell ( ... ) or a <( ... ): computed, not a path
    const tilde = /^~([^/\\]*)(?=[/\\]|$)/.exec(t);
    if (tilde) {
      if (tilde[1] === "" && env.home) t = env.home + t.slice(1);
      else if (tilde[1] === "+" && cwdKey) t = cwdKey + t.slice(2);
      else return { unknown: true };
    }
    let unknown = false;
    const sub = (m, name) => { const v = knownVar(name, cwdKey); if (v === null) unknown = true; return v === null ? m : v; };
    t = t.replace(/\$\{?env:([A-Za-z_][A-Za-z0-9_]*)\}?/gi, (m, a) => sub(m, a)); // PowerShell: $env:TEMP and ${env:TEMP}
    t = t.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => sub(m, a || b));
    t = t.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, a) => sub(m, a)); // cmd: %TEMP%
    if (unknown || /\$|`|%[A-Za-z_]+%|\{\}/.test(t)) return { unknown: true };
    return { text: t };
  }

  /**
   * A path word -> { unknown } or { key, glob, globAll }.
   * `key` is the folder (or file) in front of the first wildcard; globAll means the wildcard is the
   * last component and matches everything ("dist/*"), so the key's whole contents are meant.
   */
  function resolve(value, cwdKey = baseCwd) {
    const ex = expand(value, cwdKey);
    if (ex.unknown || ex.text === "") return { unknown: true };
    const text = win ? ex.text.replace(/\\/g, "/") : ex.text;
    const parts = text.split("/");
    const at = parts.findIndex((p) => /[*?[]/.test(p));
    if (at < 0) {
      const key = keyOf(ex.text, cwdKey);
      return key ? { key, glob: false, globAll: false } : { unknown: true };
    }
    const prefix = parts.slice(0, at).join("/");
    const lastGlob = at === parts.length - 1 || (at === parts.length - 2 && parts[parts.length - 1] === "");
    const globAll = lastGlob && ALL_GLOB.test(parts[at]);
    const key = keyOf(prefix === "" ? (text.startsWith("/") ? "/" : ".") : prefix, cwdKey);
    return key ? { key, glob: true, globAll } : { unknown: true };
  }

  const isFsRoot = (k) => k === "/" || /^[a-z]:\/$/.test(k) || /^\/\/[^/]+(\/[^/]+)?$/.test(k);

  // A folder nobody should delete or recursively chmod: a drive or filesystem root, a system
  // folder, the home folder or something that contains it, the project folder or the working
  // folder, or something that contains either.
  function rootish(key, cwdKey = baseCwd) {
    if (!key) return false;
    if (isFsRoot(key) || POSIX_SYSTEM.has(key.toLowerCase()) || WIN_SYSTEM.test(key.toLowerCase())) return true;
    if (homeKey && under(homeKey, key)) return true;
    if (projectKeys.some((p) => under(p, key))) return true;
    return !!cwdKey && under(cwdKey, key);
  }

  // A fixed system folder, for commands where "." and the home folder are normal arguments (chmod -R).
  const systemFolder = (key) => !!key && (isFsRoot(key) || POSIX_SYSTEM.has(key.toLowerCase()) || WIN_SYSTEM.test(key.toLowerCase()));

  function insideProject(key) {
    return projectKeys.some((p) => {
      if (!under(key, p)) return false;
      if (!projectIsBroad) return true;
      // The project is a whole home folder or drive: only paths two levels down count as inside.
      const depth = key === p ? 0 : key.slice(withSlash(p).length).split("/").length;
      return depth >= 2;
    });
  }
  const underTemp = (key) => tmpKeys.some((t) => key !== t && under(key, t));
  const isTempRoot = (key) => tmpKeys.includes(key);
  const hasGitFolder = (key) => key.split("/").includes(".git");

  // Path for display and user patterns: forward slashes, relative to the project when inside it.
  function relative(key) {
    for (const p of projectKeys) if (under(key, p) && key !== p) return key.slice(withSlash(p).length);
    return key;
  }

  return { win, keyOf, resolve, under, rootish, systemFolder, insideProject, underTemp, isTempRoot, hasGitFolder, relative, homeKey, projectKeys, tmpKeys, baseCwd, isFsRoot };
}
