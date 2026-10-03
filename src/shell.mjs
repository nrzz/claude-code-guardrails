// A small tokenizer for Bash, PowerShell and cmd.exe command lines.
//
// It does what a safety check needs and no more: it splits a line into simple commands at
// `&&  ||  ;  |  &` and newlines, respects quotes and escapes (so text inside quotes is data, never
// a command), lifts out command substitutions `$(...)` and backticks (they run), keeps here-document
// bodies and redirections next to the command they belong to, and leaves variables unexpanded.
// It never runs anything.
//
//   tokenize("cd /tmp && rm -rf build 2>/dev/null; echo 'rm -rf /'")
//     -> [cd /tmp] [rm -rf build, redirect 2> /dev/null] [echo "rm -rf /" as one quoted word]

const DIALECTS = {
  // Bash and friends: backslash escapes, ' and " quotes, # comments, ( ) group commands.
  posix: { id: "posix", escape: "\\", single: true, comment: true, operators: ";|&<>()" },
  // PowerShell: backtick escapes (a backslash is just a path separator), ( ) are sub-expressions
  // that run, { } are script blocks whose contents are commands.
  powershell: { id: "powershell", escape: "`", single: true, comment: true, operators: ";|&>(){}" },
  // cmd.exe: ^ escapes, only " quotes, no comments.
  cmd: { id: "cmd", escape: "^", single: false, comment: false, operators: "|&<>()" },
};

const WS = new Set([" ", "\t", "\n"]);
const GROUPING = "(){}";

function newSegment(op, start, depth = 0) {
  return { op, start, end: start, depth, text: "", words: [], redirects: [], heredocs: [], herestrings: [], subs: [] };
}

export const isPipe = (op) => op === "|" || op === "|&";

/** The segments that form one pipeline with the one at `index`, in order (the one itself included). */
export function pipelineOf(segments, index) {
  let from = index;
  while (from > 0 && isPipe(segments[from].op)) from--;
  let to = index;
  while (to + 1 < segments.length && isPipe(segments[to + 1].op)) to++;
  return segments.slice(from, to + 1);
}

// Index of the bracket that closes the one just before `i`, skipping nested brackets, quotes and
// escapes. Returns the text length when it never closes: an unterminated line is read to its end.
// Substitutions nested more than MAX_NESTING deep (only a hostile or broken line has them) are
// read to the end instead of recursing, so the tokenizer can never overflow the stack.
const MAX_NESTING = 64;
let nesting = 0;
function matchClose(s, i, open, close, d) {
  if (nesting >= MAX_NESTING) return s.length;
  nesting++;
  try { return scanClose(s, i, open, close, d); } finally { nesting--; }
}

function scanClose(s, i, open, close, d) {
  const n = s.length;
  let depth = 1;
  let heredoc = null; // a <<EOF seen on this line: its body (which may hold quotes) is skipped at the line end
  while (i < n) {
    const c = s[i];
    if (d.id === "posix") {
      if (c === "<" && s[i + 1] === "<" && s[i + 2] !== "<") {
        const m = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z_]\w*))/.exec(s.slice(i, i + 200));
        if (m) { heredoc = { delim: m[2] ?? m[3] ?? m[4], strip: m[1] === "-" }; i += m[0].length; continue; }
      }
      if (c === "\n" && heredoc) { i = skipHeredocBody(s, i + 1, heredoc); heredoc = null; continue; }
    }
    if (c === d.escape) { i += 2; continue; }
    if (c === "'" && d.single) {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return n;
      i = j + 1;
      continue;
    }
    if (c === '"') { i = skipDouble(s, i + 1, d); continue; }
    if (c === "`" && d.id === "posix") {
      const j = s.indexOf("`", i + 1);
      if (j < 0) return n;
      i = j + 1;
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
    i++;
  }
  return n;
}

// Index just after a here-document body that starts at `from`: the line after its delimiter line.
function skipHeredocBody(s, from, { delim, strip }) {
  let k = from;
  while (k < s.length) {
    let e = s.indexOf("\n", k);
    if (e < 0) e = s.length;
    const line = s.slice(k, e);
    k = e + 1;
    if ((strip ? line.replace(/^\t+/, "") : line) === delim) break;
  }
  return Math.min(k, s.length);
}

// Index just after the double quote that closes the string whose first character is at `i`;
// text length + 1 when the string never closes.
function skipDouble(s, i, d) {
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === d.escape && d.id !== "cmd") { i += 2; continue; }
    if (c === "$" && s[i + 1] === "(" && d.id !== "cmd") { i = matchClose(s, i + 2, "(", ")", d) + 1; continue; }
    if (c === "`" && d.id === "posix") {
      const j = s.indexOf("`", i + 1);
      if (j < 0) return n + 1;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      if (d.id !== "posix" && s[i + 1] === '"') { i += 2; continue; } // "" is a literal quote
      return i + 1;
    }
    i++;
  }
  return n + 1;
}

const ANSI_ESC = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
const PS_ESC = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", 0: "\0" };

// The inside of a double-quoted string: process escapes, remember the substitutions that run.
function unescapeDouble(inner, d, subs) {
  if (d.id === "cmd") return inner.replace(/""/g, '"');
  let out = "";
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k];
    if (c === d.escape) {
      const e = inner[k + 1];
      if (e === undefined) { out += c; continue; }
      if (d.id === "posix") {
        if (e === "\n") { k++; continue; }
        if ("$`\"\\".includes(e)) { out += e; k++; continue; }
        out += c; // any other backslash stays
        continue;
      }
      out += PS_ESC[e] ?? e; // PowerShell: `n, `t, `"
      k++;
      continue;
    }
    if (c === '"' && d.id === "powershell" && inner[k + 1] === '"') { out += '"'; k++; continue; }
    if (c === "$" && inner[k + 1] === "(") {
      const close = matchClose(inner, k + 2, "(", ")", d);
      subs.push(inner.slice(k + 2, close));
      out += inner.slice(k, Math.min(close + 1, inner.length));
      k = close;
      continue;
    }
    if (c === "`" && d.id === "posix") {
      const close = inner.indexOf("`", k + 1);
      const end = close < 0 ? inner.length : close;
      subs.push(inner.slice(k + 1, end));
      out += inner.slice(k, Math.min(end + 1, inner.length));
      k = end;
      continue;
    }
    out += c;
  }
  return out;
}

// The $( ) and backtick substitutions in text that the shell expands (an unquoted here-document body).
function substitutionsIn(body, d) {
  const out = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") { i++; continue; }
    if (c === "$" && body[i + 1] === "(") {
      const close = matchClose(body, i + 2, "(", ")", d);
      out.push(body.slice(i + 2, close));
      i = close;
    } else if (c === "`") {
      const close = body.indexOf("`", i + 1);
      const end = close < 0 ? body.length : close;
      out.push(body.slice(i + 1, end));
      i = end;
    }
  }
  return out;
}

// $'...' ANSI-C quoting: the text after the opening quote, up to the closing one.
function ansiC(s, j) {
  let value = "";
  while (j < s.length && s[j] !== "'") {
    if (s[j] === "\\" && j + 1 < s.length) {
      const e = s[j + 1];
      const hex = e === "x" ? /^[0-9a-fA-F]{1,2}/.exec(s.slice(j + 2, j + 4)) : null;
      const oct = /[0-7]/.test(e) ? /^[0-7]{1,3}/.exec(s.slice(j + 1, j + 4)) : null;
      if (hex) { value += String.fromCharCode(parseInt(hex[0], 16)); j += 2 + hex[0].length; continue; }
      if (oct) { value += String.fromCharCode(parseInt(oct[0], 8)); j += 1 + oct[0].length; continue; }
      value += ANSI_ESC[e] ?? e;
      j += 2;
      continue;
    }
    value += s[j++];
  }
  return { value, next: j + 1 };
}

/**
 * Split one command line into segments.
 *
 * A segment is { op, words, redirects, heredocs, herestrings, subs, text }:
 *   op          the operator in front of it: null for the first, else "&&" "||" ";" "|" "|&" "&" "\n" ...
 *   words       [{ value, raw, quoted, start, end }], the command word first. `value` has quotes and
 *               escapes removed; variables and substitutions stay as written ("$HOME", "$(pwd)").
 *   redirects   [{ op, fd, target }] for > >> >| &> <> (descriptor copies such as 2>&1 are left out)
 *   heredocs    bodies of here-documents (<<EOF ... EOF) attached to this command
 *   herestrings the words after <<<
 *   subs        source text of every command substitution, backtick and process substitution in it
 *   text        the source text of the segment, for messages and user patterns
 */
export function tokenize(source, dialect = "posix") {
  const d = DIALECTS[dialect] || DIALECTS.posix;
  const s = String(source ?? "").replace(/\r\n?/g, "\n");
  const n = s.length;
  const segments = [];
  const pending = []; // here-documents whose body starts after the current line
  let seg = newSegment(null, 0);
  let depth = 0; // how many ( ... ) subshells the segment being read is inside
  let i = 0;

  const isOperator = (c) => d.operators.includes(c);

  // One word starting at `from`: quotes, escapes and substitutions resolved; it ends at white space
  // or an operator. Returns { word, next, subs }.
  function scanWord(from) {
    let j = from;
    let value = "";
    let quoted = false;
    const subs = [];
    while (j < n) {
      const c = s[j];
      if (WS.has(c) || isOperator(c)) break;

      if (c === d.escape) {
        const next = s[j + 1];
        if (next === undefined) { value += c; j++; continue; }
        if (next === "\n") { j += 2; continue; } // line continuation
        value += next;
        quoted = true;
        j += 2;
        continue;
      }
      if (c === "'" && d.single) {
        quoted = true;
        j++;
        for (;;) {
          const k = s.indexOf("'", j);
          if (k < 0) { value += s.slice(j); j = n; break; }
          value += s.slice(j, k);
          j = k + 1;
          if (d.id === "powershell" && s[j] === "'") { value += "'"; j++; continue; } // '' is a literal quote
          break;
        }
        continue;
      }
      if (c === '"') {
        quoted = true;
        const stop = skipDouble(s, j + 1, d);
        const closed = stop <= n;
        const inner = s.slice(j + 1, closed ? stop - 1 : n);
        value += unescapeDouble(inner, d, subs);
        j = closed ? stop : n;
        continue;
      }
      if (c === "$" && d.id !== "cmd") {
        const next = s[j + 1];
        if (next === "(") { // command substitution (arithmetic parses to nothing harmful)
          const close = matchClose(s, j + 2, "(", ")", d);
          subs.push(s.slice(j + 2, close));
          value += s.slice(j, Math.min(close + 1, n));
          j = close + 1;
          continue;
        }
        if (next === "{") { // ${var}: may contain spaces, as in ${x:-a b}
          const close = matchClose(s, j + 2, "{", "}", d);
          value += s.slice(j, Math.min(close + 1, n));
          j = close + 1;
          continue;
        }
        if (next === "'" && d.id === "posix") {
          const r = ansiC(s, j + 2);
          value += r.value;
          quoted = true;
          j = r.next;
          continue;
        }
      }
      if (c === "`" && d.id === "posix") { // backtick substitution
        const close = s.indexOf("`", j + 1);
        const end = close < 0 ? n : close;
        subs.push(s.slice(j + 1, end));
        value += s.slice(j, Math.min(end + 1, n));
        j = end + 1;
        continue;
      }
      value += c;
      j++;
    }
    const end = Math.min(j, n);
    return { word: { value, raw: s.slice(from, end), quoted, start: from, end }, next: end, subs };
  }

  function closeSegment(nextOp, endAt, nextStart) {
    if (seg.words.length || seg.redirects.length || seg.subs.length || seg.herestrings.length || seg.heredocs.length) {
      seg.end = endAt;
      seg.text = s.slice(seg.start, endAt).trim();
      segments.push(seg);
    }
    seg = newSegment(nextOp, nextStart, depth);
  }

  function addWord(word, subs) {
    seg.subs.push(...subs);
    if (d.id === "posix" && !word.quoted && word.value.includes("{")) {
      for (const v of braceExpand(word.value)) seg.words.push({ ...word, value: v });
    } else seg.words.push(word);
  }

  // Here-document bodies, read from the start of the line after the operator.
  function readHeredocs(from) {
    let k = from;
    for (const h of pending) {
      const lines = [];
      while (k < n) {
        let e = s.indexOf("\n", k);
        if (e < 0) e = n;
        const line = s.slice(k, e);
        k = e + 1;
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        lines.push(line);
      }
      const body = lines.join("\n");
      h.seg.heredocs.push(body);
      if (!h.quoted) h.seg.subs.push(...substitutionsIn(body, d)); // an unquoted delimiter: the body is expanded, so $(...) runs
    }
    pending.length = 0;
    return Math.min(k, n);
  }

  // After a redirection operator: read what it points at. Returns the index to continue from.
  function readRedirect(afterOp, op, fd) {
    let k = afterOp;
    while (k < n && (s[k] === " " || s[k] === "\t")) k++;
    const { word, next, subs } = scanWord(k);
    seg.subs.push(...subs);
    if (next === k) return afterOp; // nothing follows
    if (op === "<<" || op === "<<-") {
      if (word.value) pending.push({ delim: word.value, strip: op === "<<-", quoted: word.quoted, seg });
      return next;
    }
    if (op === "<<<") { seg.herestrings.push(word.value); return next; }
    if ((op === ">&" || op === "<&") && /^(\d+-?|-)$/.test(word.value)) return next; // 2>&1 copies a descriptor
    seg.redirects.push({ op, fd, target: word });
    return next;
  }

  // PowerShell here-string @' ... '@ or @" ... "@ whose @ is at `j`, or null when it is not one.
  function scanHereString(j) {
    const q = s[j + 1];
    if ((q !== "'" && q !== '"') || !/^[ \t]*\n/.test(s.slice(j + 2, j + 82))) return null;
    const bodyStart = s.indexOf("\n", j + 2) + 1;
    const closer = new RegExp(`\\n${q}@`).exec(s.slice(bodyStart - 1));
    const bodyEnd = closer ? bodyStart - 1 + closer.index : n;
    const next = closer ? bodyEnd + closer[0].length : n;
    return { value: s.slice(bodyStart, bodyEnd), next };
  }

  while (i < n) {
    const c = s[i];

    if (c === " " || c === "\t") { i++; continue; }

    if (c === "\n") {
      const at = i++;
      if (pending.length) i = readHeredocs(i);
      closeSegment("\n", at, i);
      continue;
    }

    // Comments run to the end of the line (PowerShell also has <# ... #> blocks).
    if (c === "#" && d.comment) {
      while (i < n && s[i] !== "\n") i++;
      continue;
    }
    if (c === "<" && s[i + 1] === "#" && d.id === "powershell") {
      const e = s.indexOf("#>", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }

    if (c === ";" && isOperator(";")) {
      const op = s[i + 1] === ";" ? ";;" : ";";
      closeSegment(op, i, i + op.length);
      i += op.length;
      continue;
    }

    if (c === "|") {
      const op = s[i + 1] === "|" ? "||" : s[i + 1] === "&" && d.id === "posix" ? "|&" : "|";
      closeSegment(op, i, i + op.length);
      i += op.length;
      continue;
    }

    if (c === "&") {
      if (s[i + 1] === "&") { closeSegment("&&", i, i + 2); i += 2; continue; }
      if (s[i + 1] === ">" && d.id === "posix") { // &> file and &>> file
        const op = s[i + 2] === ">" ? "&>>" : "&>";
        i = readRedirect(i + op.length, op, null);
        continue;
      }
      if (d.id === "powershell" && !seg.words.length) { i++; continue; } // the call operator: & "C:\tool.exe"
      closeSegment("&", i, i + 1);
      i++;
      continue;
    }

    if (isOperator(c) && GROUPING.includes(c)) {
      if (d.id === "powershell" && c === "(") { // a sub-expression runs, and its result is a value
        const close = matchClose(s, i + 1, "(", ")", d);
        const end = Math.min(close + 1, n);
        const raw = s.slice(i, end);
        seg.subs.push(s.slice(i + 1, close));
        seg.words.push({ value: raw, raw, quoted: true, start: i, end });
        i = close + 1;
        continue;
      }
      closeSegment(c, i, i + 1);
      if (c === "(") depth++; // a subshell: a cd inside it does not outlive it
      else if (c === ")") depth = Math.max(0, depth - 1);
      seg.depth = depth;
      i++;
      continue;
    }

    if (c === ">" || (c === "<" && d.id !== "powershell")) {
      // <( ) and >( ) are process substitutions: the inside runs, the outside is a value
      if (s[i + 1] === "(" && d.id === "posix") {
        const close = matchClose(s, i + 2, "(", ")", d);
        const end = Math.min(close + 1, n);
        const raw = s.slice(i, end);
        seg.subs.push(s.slice(i + 2, close));
        seg.words.push({ value: raw, raw, quoted: true, start: i, end });
        i = close + 1;
        continue;
      }
      // a descriptor number glued to the operator (2>) belongs to it
      let fd = null;
      const last = seg.words[seg.words.length - 1];
      if (last && last.end === i && (/^\d+$/.test(last.raw) || (d.id === "powershell" && last.raw === "*"))) { fd = last.raw; seg.words.pop(); }
      let op = c;
      if (c === ">") {
        if (s[i + 1] === ">") op = ">>";
        else if (s[i + 1] === "|") op = ">|";
        else if (s[i + 1] === "&") op = ">&";
      } else if (s.startsWith("<<<", i)) op = "<<<";
      else if (s.startsWith("<<-", i)) op = "<<-";
      else if (s.startsWith("<<", i)) op = "<<";
      else if (s[i + 1] === "&") op = "<&";
      else if (s[i + 1] === ">") op = "<>";
      i = readRedirect(i + op.length, op, fd);
      continue;
    }

    // PowerShell here-string: @' ... '@ or @" ... "@
    if (c === "@" && d.id === "powershell") {
      const hs = scanHereString(i);
      if (hs) {
        seg.words.push({ value: hs.value, raw: s.slice(i, hs.next), quoted: true, start: i, end: hs.next });
        if (s[i + 1] === '"') { // an expandable here-string can hold $( ... )
          for (const m of hs.value.matchAll(/\$\(/g)) seg.subs.push(hs.value.slice(m.index + 2, matchClose(hs.value, m.index + 2, "(", ")", d)));
        }
        i = hs.next;
        continue;
      }
    }

    const { word, next, subs } = scanWord(i);
    if (next <= i) { i++; continue; } // an operator character nothing above handles: never loop
    if (word.value === "" && !word.quoted && !subs.length) { i = next; continue; } // only a line continuation
    addWord(word, subs);
    i = next;
  }
  closeSegment(null, n, n);
  return { segments, source: s };
}

/** Brace lists: "a{b,c}d" gives ["abd", "acd"]. Only comma lists are expanded; at most `limit` words come back. */
export function braceExpand(word, limit = 32) {
  if (word.length > 1000) return [word]; // no real path is this long; do not recurse on it
  const list = firstBraceList(word);
  if (!list) return [word];
  const pre = word.slice(0, list.start);
  const post = word.slice(list.end + 1);
  const out = [];
  for (const part of list.parts) {
    for (const e of braceExpand(pre + part + post, limit)) {
      out.push(e);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function firstBraceList(word) {
  for (let i = 0; i < word.length; i++) {
    if (word[i] !== "{" || word[i - 1] === "$") continue;
    let depth = 0;
    const parts = [];
    let from = i + 1;
    for (let j = i; j < word.length; j++) {
      const c = word[j];
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        parts.push(word.slice(from, j));
        return parts.length > 1 ? { start: i, end: j, parts } : null;
      } else if (c === "," && depth === 1) { parts.push(word.slice(from, j)); from = j + 1; }
    }
    return null;
  }
  return null;
}

/**
 * The line with everything inside quotes blanked out, so structural patterns (a fork bomb) only
 * see what the shell would run, never text that is just being printed.
 */
export function maskQuoted(source, dialect = "posix") {
  const d = DIALECTS[dialect] || DIALECTS.posix;
  const s = String(source ?? "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === d.escape && i + 1 < s.length) { out += "__"; i++; continue; }
    if ((c === "'" && d.single) || c === '"') {
      let end;
      if (c === '"') end = Math.min(skipDouble(s, i + 1, d), s.length);
      else { const k = s.indexOf("'", i + 1); end = k < 0 ? s.length : k + 1; }
      out += c + "_".repeat(Math.max(0, end - i - 2)) + (end - i >= 2 ? c : "");
      i = end - 1;
      continue;
    }
    out += c;
  }
  return out;
}
