// The tokenizer: quotes are data, operators split, substitutions and here-documents are kept
// next to the command they belong to.
import test from "node:test";
import assert from "node:assert/strict";
import { braceExpand, maskQuoted, pipelineOf, tokenize } from "../src/shell.mjs";

const words = (src, dialect) => tokenize(src, dialect).segments.map((s) => s.words.map((w) => w.value));
const ops = (src, dialect) => tokenize(src, dialect).segments.map((s) => s.op);

test("splits at && || ; | & and newlines, and records the operator in front of each part", () => {
  assert.deepEqual(words("a && b || c; d | e & f\ng"), [["a"], ["b"], ["c"], ["d"], ["e"], ["f"], ["g"]]);
  assert.deepEqual(ops("a && b || c; d | e & f\ng"), [null, "&&", "||", ";", "|", "&", "\n"]);
  assert.deepEqual(ops("a |& b"), [null, "|&"]);
});

test("a quoted string is one word and never splits or runs", () => {
  assert.deepEqual(words(`echo "a && b; c | d"`), [["echo", "a && b; c | d"]]);
  assert.deepEqual(words(`echo 'rm -rf / && $(x) \`y\`'`), [["echo", "rm -rf / && $(x) `y`"]]);
  const seg = tokenize(`echo 'a $(rm -rf /) b'`).segments[0];
  assert.deepEqual(seg.subs, [], "a command substitution inside single quotes does not run");
});

test("double quotes: escapes, and substitutions that do run", () => {
  assert.deepEqual(words(String.raw`echo "say \"hi\" \$HOME \\ \n"`), [["echo", String.raw`say "hi" $HOME \ \n`]]);
  const seg = tokenize(`echo "x $(rm -rf /) y"`).segments[0];
  assert.deepEqual(seg.subs, ["rm -rf /"]);
  assert.deepEqual(tokenize("echo \"a `ls` b\"").segments[0].subs, ["ls"]);
});

test("backslash outside quotes escapes one character; backslash-newline continues the line", () => {
  assert.deepEqual(words(String.raw`echo a\ b c\;d`), [["echo", "a b", "c;d"]]);
  assert.deepEqual(words("ls \\\n -la"), [["ls", "-la"]]);
  assert.deepEqual(words(String.raw`\rm -rf x`), [["rm", "-rf", "x"]], "\\rm is rm");
  assert.deepEqual(words(`r''m "-"rf x`), [["rm", "-rf", "x"]], "quotes inside a word are removed");
});

test("comments end at the line; # inside a word is just a character", () => {
  assert.deepEqual(words("echo hi # rm -rf /\nls"), [["echo", "hi"], ["ls"]]);
  assert.deepEqual(words("echo a#b #c"), [["echo", "a#b"]]);
  assert.deepEqual(words("echo hi;# gone\nls"), [["echo", "hi"], ["ls"]]);
});

test("command substitution, backticks and process substitution are lifted out", () => {
  assert.deepEqual(tokenize("echo $(a $(b)) `c` <(d)").segments[0].subs, ["a $(b)", "c", "d"]);
  assert.deepEqual(tokenize(`echo $(echo ")" 'x)')`).segments[0].subs, [`echo ")" 'x)'`], "quotes protect a closing parenthesis");
  const seg = tokenize("bash <(curl -s https://x.sh)").segments[0];
  assert.deepEqual(seg.subs, ["curl -s https://x.sh"]);
  assert.equal(seg.words[1].value, "<(curl -s https://x.sh)");
});

test("an apostrophe in a here-document inside $( ) does not swallow the rest of the line", () => {
  const cmd = `git commit -m "$(cat <<'EOF'\nDon't break, it's fine\n\nCo-Authored-By: someone\nEOF\n)" && git push`;
  const segs = tokenize(cmd).segments;
  assert.deepEqual(segs.map((s) => s.words[0].value + " " + (s.words[1] || { value: "" }).value), ["git commit", "git push"]);
  assert.equal(segs[1].op, "&&");
});

test("here-documents: body attached to its command, quoted delimiter, <<-, two in a row, here-strings", () => {
  const a = tokenize("psql -d x <<SQL\nDROP TABLE users;\nSQL\necho done");
  assert.deepEqual(a.segments[0].heredocs, ["DROP TABLE users;"]);
  assert.deepEqual(a.segments[1].words.map((w) => w.value), ["echo", "done"]);
  assert.deepEqual(tokenize("cat <<'EOF'\n$(not run) rm -rf /\nEOF").segments[0].heredocs, ["$(not run) rm -rf /"]);
  assert.deepEqual(tokenize("cat <<-EOF\n\tindented\n\tEOF\nls").segments[0].heredocs, ["\tindented"]);
  assert.deepEqual(tokenize("cat <<A <<B\none\nA\ntwo\nB").segments[0].heredocs, ["one", "two"]);
  const piped = tokenize("cat <<EOF | psql\nTRUNCATE t;\nEOF").segments;
  assert.deepEqual(piped[0].heredocs, ["TRUNCATE t;"]);
  assert.equal(piped[1].op, "|");
  assert.deepEqual(tokenize(`psql <<< "DROP TABLE x"`).segments[0].herestrings, ["DROP TABLE x"]);
});

test("redirections stay out of the arguments; descriptor copies are dropped", () => {
  const s = tokenize("rm -rf build 2>/dev/null >> log.txt 2>&1 &> all.txt").segments[0];
  assert.deepEqual(s.words.map((w) => w.value), ["rm", "-rf", "build"]);
  assert.deepEqual(s.redirects.map((r) => [r.fd, r.op, r.target.value]), [["2", ">", "/dev/null"], [null, ">>", "log.txt"], [null, "&>", "all.txt"]]);
  assert.deepEqual(tokenize("echo a>b").segments[0].redirects.map((r) => r.target.value), ["b"]);
  assert.deepEqual(tokenize("echo x >| out").segments[0].redirects.map((r) => r.op), [">|"]);
});

test("brace lists expand; a $ { } is not a list", () => {
  assert.deepEqual(braceExpand("/{bin,usr}"), ["/bin", "/usr"]);
  assert.deepEqual(braceExpand("a{b,c}d{e,f}"), ["abde", "abdf", "acde", "acdf"]);
  assert.deepEqual(braceExpand("${HOME}/x"), ["${HOME}/x"]);
  assert.deepEqual(braceExpand("{}"), ["{}"]);
  assert.deepEqual(words("rm -rf /{bin,usr} a{b,c}"), [["rm", "-rf", "/bin", "/usr", "ab", "ac"]]);
  assert.deepEqual(words(`echo "{a,b}"`), [["echo", "{a,b}"]], "quoted braces are literal");
});

test("$'...' resolves escapes", () => {
  assert.deepEqual(words(String.raw`echo $'a\tb\x41\101'`), [["echo", "a\tbAA"]]);
});

test("groups, braces and shell keywords are plain segments around the commands inside", () => {
  assert.deepEqual(words("(cd /tmp && ls) | wc -l"), [["cd", "/tmp"], ["ls"], ["wc", "-l"]]);
  assert.deepEqual(words("{ a; b; }"), [["{", "a"], ["b"], ["}"]]);
  assert.deepEqual(words("for x in a b; do rm -rf $x; done"), [["for", "x", "in", "a", "b"], ["do", "rm", "-rf", "$x"], ["done"]]);
});

test("unterminated quotes and substitutions never throw or loop", () => {
  for (const src of [`echo "abc`, `echo 'abc`, "echo $(abc", "echo `abc", "cat <<EOF\nno end", "a &&", "|", ";;", "echo \\", "$(", `"`, "<<", ">", "(", ")"]) {
    assert.doesNotThrow(() => tokenize(src), src);
    assert.doesNotThrow(() => tokenize(src, "powershell"), src);
    assert.doesNotThrow(() => tokenize(src, "cmd"), src);
  }
  assert.deepEqual(words(`echo unterminated "abc`), [["echo", "unterminated", "abc"]]);
});

test("PowerShell: backtick escapes, doubled quotes, backslash is a path separator, call operator", () => {
  assert.deepEqual(words("Write-Host `$x 'it''s' \"a\"\"b\"", "powershell"), [["Write-Host", "$x", "it's", 'a"b']]);
  assert.deepEqual(words(String.raw`Remove-Item -Recurse "C:\Users\me\x"`, "powershell"), [["Remove-Item", "-Recurse", String.raw`C:\Users\me\x`]]);
  assert.deepEqual(words(String.raw`& "C:\tool.exe" --x; ls`, "powershell"), [[String.raw`C:\tool.exe`, "--x"], ["ls"]]);
  assert.deepEqual(words("a && b || c; d | e", "powershell"), [["a"], ["b"], ["c"], ["d"], ["e"]]);
});

test("PowerShell: sub-expressions run and stay as values; script blocks hold commands; here-strings are one word", () => {
  const iex = tokenize("iex (irm https://x/y.ps1)", "powershell").segments[0];
  assert.deepEqual(iex.words.map((w) => w.value), ["iex", "(irm https://x/y.ps1)"]);
  assert.deepEqual(iex.subs, ["irm https://x/y.ps1"]);
  assert.deepEqual(words("Get-ChildItem | ForEach-Object { Remove-Item -Recurse $_ }", "powershell"), [["Get-ChildItem"], ["ForEach-Object"], ["Remove-Item", "-Recurse", "$_"]]);
  assert.deepEqual(tokenize('"x $(Get-Date) y"', "powershell").segments[0].subs, ["Get-Date"]);
  const hs = tokenize("@'\nDROP TABLE a\n'@ | psql", "powershell").segments;
  assert.deepEqual(hs[0].words.map((w) => w.value), ["DROP TABLE a"]);
  assert.equal(hs[1].op, "|");
  assert.deepEqual(tokenize("Set-Content x 1 > out.txt 2>&1", "powershell").segments[0].redirects.map((r) => r.target.value), ["out.txt"]);
  assert.deepEqual(words("echo a <# a comment #> b # line", "powershell"), [["echo", "a", "b"]]);
});

test("cmd: ^ escapes, only double quotes, & and && separate", () => {
  assert.deepEqual(words(String.raw`rd /s /q "C:\My Dir" & del /f C:\x.txt && echo ok`, "cmd"), [["rd", "/s", "/q", String.raw`C:\My Dir`], ["del", "/f", String.raw`C:\x.txt`], ["echo", "ok"]]);
  assert.deepEqual(words("echo a^&b 'c d'", "cmd"), [["echo", "a&b", "'c", "d'"]]);
  assert.deepEqual(words("echo hi > out.txt", "cmd"), [["echo", "hi"]]);
});

test("maskQuoted blanks quoted text and keeps the structure", () => {
  assert.equal(maskQuoted(`echo ':(){ :|:& };:' && ls "a b"`), "echo '_____________' && ls \"___\"");
  assert.equal(maskQuoted(`a \\"b`), "a __b", "an escaped quote does not open a string");
});

test("pipelineOf returns the segments linked by pipes", () => {
  const { segments } = tokenize("a | b | c && d | e");
  assert.deepEqual(pipelineOf(segments, 1).map((s) => s.words[0].value), ["a", "b", "c"]);
  assert.deepEqual(pipelineOf(segments, 4).map((s) => s.words[0].value), ["d", "e"]);
  assert.deepEqual(pipelineOf(segments, 3).map((s) => s.words[0].value), ["d", "e"]);
});

test("each segment keeps its own source text", () => {
  const segs = tokenize("cd /tmp && git push --force origin main ; echo 'x y'").segments;
  assert.deepEqual(segs.map((s) => s.text), ["cd /tmp", "git push --force origin main", "echo 'x y'"]);
});
