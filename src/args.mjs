// Argument parsing helpers shared by the checks. They work on tokenizer words ({ value, ... }),
// never on a string, so quoting has already been resolved.

export const EMPTY = new Set();

const synth = (value) => ({ value, raw: value, quoted: false });

/**
 * Split a command's arguments into option tokens, positionals and option values.
 *   flags    every option token as written ("-rf", "--force", "--message=x")
 *   pos      positional words in order (everything after `--` included)
 *   dd       the words after `--` only
 *   values   Map(option -> [word]) for the options named in `valueOpts`, which take a value, and
 *            for any --long=value
 */
export function parseArgs(args, valueOpts = EMPTY) {
  const flags = [];
  const pos = [];
  const dd = [];
  const values = new Map();
  const put = (k, w) => { if (!values.has(k)) values.set(k, []); values.get(k).push(typeof w === "string" ? synth(w) : w); };
  let i = 0;
  let rest = false;
  while (i < args.length) {
    const w = args[i];
    const t = w.value;
    if (rest) { pos.push(w); dd.push(w); i++; continue; }
    if (t === "--") { rest = true; i++; continue; }
    if (t === "-" || !t.startsWith("-")) { pos.push(w); i++; continue; }
    flags.push(t);
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      if (eq > 0) put(t.slice(0, eq), t.slice(eq + 1));
      else if (valueOpts.has(t) && i + 1 < args.length) put(t, args[++i]);
    } else {
      for (let j = 1; j < t.length; j++) { // a short cluster: -n5, -oL, -uroot, -Eu root
        const f = "-" + t[j];
        if (!valueOpts.has(f)) continue;
        if (t.length > j + 1) put(f, t.slice(j + 1));
        else if (i + 1 < args.length) put(f, args[++i]);
        break;
      }
    }
    i++;
  }
  return { flags, pos, dd, values };
}

/** Index of the first argument that is not an option (options with values included). */
export function skipOptions(args, valueOpts = EMPTY) {
  let i = 0;
  while (i < args.length) {
    const t = args[i].value;
    if (t === "--") return i + 1;
    if (t === "-" || !t.startsWith("-")) return i;
    if (t.startsWith("--")) {
      i += !t.includes("=") && valueOpts.has(t) ? 2 : 1;
      continue;
    }
    let takesNext = false;
    for (let j = 1; j < t.length; j++) {
      if (valueOpts.has("-" + t[j])) { takesNext = j === t.length - 1; break; }
    }
    i += takesNext ? 2 : 1;
  }
  return i;
}

// Is any short option cluster containing one of `letters`?  shortHas(["-rf"], "rR") -> true
export const shortHas = (flags, letters) => flags.some((f) => f.length > 1 && f[0] === "-" && f[1] !== "-" && [...letters].some((l) => f.slice(1).includes(l)));

// Is any option exactly one of `names` (a value after = is ignored)?
export const longIs = (flags, ...names) => flags.some((f) => names.includes(f.split("=")[0]));

export const vals = (words) => words.map((w) => w.value);

/** A word the tokenizer did not produce, for commands built from other commands (find -exec). */
export const syntheticWord = synth;

// ---------------------------------------------------------------------------------------------
// PowerShell parameters: -Name value, -Name:value, case-insensitive, abbreviations allowed
// ---------------------------------------------------------------------------------------------

/**
 * Parse PowerShell arguments. `valueParams` and `switchParams` list the cmdlet's parameters in
 * lower case; a parameter may be written as any prefix of at least two letters. An unknown
 * parameter counts as a switch, so a stray -rf is seen as a switch named "rf".
 * Returns { named: Map(param -> [word]), switches: Set, pos: [word] }.
 */
export function parsePs(args, valueParams, switchParams = []) {
  const named = new Map();
  const switches = new Set();
  const pos = [];
  const resolve = (name) => {
    if (valueParams.includes(name)) return ["value", name];
    if (switchParams.includes(name)) return ["switch", name];
    if (name.length >= 2) {
      const s = switchParams.find((p) => p.startsWith(name));
      if (s) return ["switch", s];
      const v = valueParams.find((p) => p.startsWith(name));
      if (v) return ["value", v];
    }
    return ["switch", name];
  };
  for (let i = 0; i < args.length; i++) {
    const t = args[i].value;
    const m = /^-([A-Za-z][A-Za-z0-9]*):?(.*)$/s.exec(t);
    if (!m || /^["']/.test(args[i].raw)) { pos.push(args[i]); continue; } // a wholly quoted word is a string, not a parameter
    const [kind, key] = resolve(m[1].toLowerCase());
    if (kind === "switch") { switches.add(key); continue; }
    let w = null;
    if (m[2] !== "") w = synth(m[2]);
    else if (i + 1 < args.length) w = args[++i];
    if (w) { if (!named.has(key)) named.set(key, []); named.get(key).push(w); }
  }
  return { named, switches, pos };
}
