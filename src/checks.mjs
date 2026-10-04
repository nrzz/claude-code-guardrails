// The checks: what is dangerous about each command, once the tokenizer has done its work.
// Every check receives a context `c`:
//   c.a         the analysis (paths, settings, findings: a.add(rule, detail, subject))
//   c.seg       the tokenizer segment (words, redirects, heredocs ...)    c.k, c.segments: where it sits
//   c.name      the command name, lower case, wrappers (sudo, env ...) already stripped
//   c.args      the words after the command name
//   c.dialect   "posix" | "powershell" | "cmd"
//   c.extra     { unknownArgs: true } when more arguments will arrive from elsewhere (xargs)

import { longIs, parseArgs, parsePs, shortHas, syntheticWord, vals } from "./args.mjs";
import { checkFile, targetKind } from "./files.mjs";
import { commitFindings } from "./gitutil.mjs";
import { pipelineOf, isPipe } from "./shell.mjs";

const shorten = (s, n = 60) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
const baseOf = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop();
const joinName = (dir, name) => `${String(dir).replace(/[\\/]+$/, "")}/${name}`;

// ---------------------------------------------------------------------------------------------
// Deleting: rm, Remove-Item, rd, del, rimraf, find -delete
// ---------------------------------------------------------------------------------------------

const POSIX_RM = new Set(["rm", "rimraf", "unlink"]);
const PS_REMOVE = new Set(["remove-item", "ri", "rm", "rmdir", "rd", "del", "erase"]);
const CMD_REMOVE = new Set(["rd", "rmdir", "del", "erase"]);
export const DELETE_NAMES = [...new Set([...POSIX_RM, ...PS_REMOVE, ...CMD_REMOVE])];

const PS_REMOVE_VALUE = ["path", "literalpath", "include", "exclude", "filter", "credential", "stream", "erroraction", "errorvariable", "warningaction", "warningvariable", "informationaction", "informationvariable", "outvariable", "outbuffer", "pipelinevariable"];
const PS_REMOVE_SWITCH = ["recurse", "force", "confirm", "whatif", "usetransaction", "verbose", "debug"];
// -Recurse, any abbreviation of it, and the bash habit -rf
const isPsRecurse = (s) => "recurse".startsWith(s) || /^[rfvi]*r[rfvi]*$/.test(s);
const isPsWhatIf = (s) => s.length >= 2 && "whatif".startsWith(s);

// Get-ChildItem C:\logs -Recurse | Remove-Item: what the listing names is what gets deleted
const PS_LISTERS = new Set(["get-childitem", "gci", "ls", "dir", "get-item", "gi"]);
function psPipedTargets(c) {
  const line = pipelineOf(c.segments, c.k);
  const mine = line.indexOf(c.seg);
  for (let i = mine - 1; i >= 0; i--) {
    if (!PS_LISTERS.has(c.nameOf(line[i]))) continue;
    const p = parsePs(c.argsOf(line[i]), ["path", "literalpath", "filter", "include", "exclude", "depth", "attributes"], ["recurse", "force", "file", "directory", "hidden", "readonly", "system", "name"]);
    const paths = [...(p.named.get("path") || []), ...(p.named.get("literalpath") || []), ...p.pos];
    const narrowed = line.slice(i + 1, mine).some((m) => ["where-object", "where", "?"].includes(c.nameOf(m)));
    return {
      targets: paths.length ? paths : [syntheticWord(".")],
      recursive: [...p.switches].some(isPsRecurse),
      filtered: narrowed || p.named.has("filter") || p.named.has("include") || p.named.has("exclude"),
    };
  }
  return null;
}

export function checkDelete(c) {
  const { name, args, dialect } = c;
  let targets;
  const opts = { recursive: false, filtered: false, dryRun: false };
  if (dialect === "powershell" && PS_REMOVE.has(name)) {
    const p = parsePs(args, PS_REMOVE_VALUE, PS_REMOVE_SWITCH);
    targets = [...(p.named.get("path") || []), ...(p.named.get("literalpath") || []), ...p.pos];
    opts.recursive = [...p.switches].some(isPsRecurse);
    opts.dryRun = [...p.switches].some(isPsWhatIf);
    opts.filtered = p.named.has("include") || p.named.has("filter") || p.named.has("exclude");
    if (!targets.length && isPipe(c.seg.op)) {
      const piped = psPipedTargets(c);
      if (piped) { targets = piped.targets; opts.recursive = opts.recursive || piped.recursive; opts.filtered = opts.filtered || piped.filtered; }
    }
  } else if (dialect === "cmd" && CMD_REMOVE.has(name)) {
    const isSwitch = (w) => /^\/[a-zA-Z?](:.*)?$/.test(w.value);
    targets = args.filter((w) => !isSwitch(w));
    opts.recursive = args.some((w) => /^\/s$/i.test(w.value));
  } else if (POSIX_RM.has(name)) {
    const p = parseArgs(args);
    targets = p.pos;
    opts.recursive = name === "rimraf" || shortHas(p.flags, "rR") || longIs(p.flags, "--recursive");
  } else return;
  evalDelete(c, targets, opts);
}

/**
 * The targets of a delete. Secrets files and the guardrails files count however it is spelled; a
 * recursive delete is judged by where it points: a root or the project itself is always blocked,
 * a .git folder or a place outside the project and the temp folder is the preset's call.
 * opts: { recursive, filtered (only some matches under each target), dryRun }
 */
export function evalDelete(c, targets, opts) {
  const { a, seg } = c;
  if (opts.dryRun) return;
  for (const w of targets) checkFile(a, w.value, "delete", seg.text);
  if (!opts.recursive) return;
  if (!targets.length) {
    // Paths come from somewhere this check cannot see: xargs, or a PowerShell pipeline
    if (c.extra.unknownArgs || (c.dialect === "powershell" && isPipe(seg.op))) a.add("rm-outside-project", "paths from a pipe", seg.text);
    return;
  }
  for (const w of targets) {
    const r = a.paths.resolve(w.value, a.cwdKey);
    if (r.unknown) { a.add("rm-outside-project", `${shorten(w.value)} (cannot be resolved)`, seg.text); continue; }
    const onlyMatches = (r.glob && !r.globAll) || opts.filtered;
    if (!onlyMatches && a.paths.rootish(r.key, a.cwdKey)) { a.add("rm-root", shorten(w.value), seg.text); continue; }
    if (a.paths.hasGitFolder(r.key)) { a.add("rm-git-dir", shorten(w.value), seg.text); continue; }
    const temp = a.paths.underTemp(r.key) || (r.glob && a.paths.isTempRoot(r.key)); // /tmp/* is inside the temp folder, /tmp is not
    if (!a.paths.insideProject(r.key) && !temp) a.add("rm-outside-project", shorten(w.value), seg.text);
  }
}

// ---------------------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------------------

const GIT_GLOBAL_VALUE = new Set(["-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix", "--attr-source"]);
const PUSH_VALUE = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
const WHOLE_TREE = /^(\.|\.\/|\*|:\/|:\/\.|\.\/\*)$/;

// A folder usable as a child process's working folder.
const spawnCwd = (a, key) => (key && !(a.paths.win && key.startsWith("/")) ? key : a.paths.win ? a.env.cwd || null : key);

function currentBranch(a, dirKey) {
  const cwd = spawnCwd(a, dirKey);
  if (!cwd) return null;
  if (a.branchCache.has(cwd)) return a.branchCache.get(cwd);
  const r = a.git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 2000 });
  const b = r.ok ? r.stdout.trim() : "";
  const branch = b && b !== "HEAD" ? b : null; // "HEAD" means a detached head: no branch
  a.branchCache.set(cwd, branch);
  return branch;
}

export function checkGit(c) {
  const { a, seg, args } = c;
  let dirKey = a.cwdKey;
  let i = 0;
  while (i < args.length && args[i].value.startsWith("-")) { // git -C dir -c k=v --no-pager <command>
    const t = args[i].value;
    if (t === "-C") {
      const r = i + 1 < args.length && dirKey !== null ? a.paths.resolve(args[i + 1].value, dirKey) : { unknown: true };
      dirKey = r.unknown ? null : r.key;
      i += 2;
    } else i += GIT_GLOBAL_VALUE.has(t) ? 2 : 1;
  }
  const sub = args[i] && args[i].value;
  const rest = args.slice(i + 1);
  const subject = seg.text;
  switch (sub) {
    case "push": return gitPush(c, rest, dirKey);
    case "commit": return gitCommit(c, rest, dirKey);
    case "add": return gitAdd(c, rest);
    case "reset": if (longIs(parseArgs(rest).flags, "--hard")) a.add("git-reset-hard", "", subject); return;
    case "clean": {
      const { flags } = parseArgs(rest);
      const dry = shortHas(flags, "n") || longIs(flags, "--dry-run");
      if (!dry && (shortHas(flags, "f") || longIs(flags, "--force"))) a.add("git-clean", "", subject);
      return;
    }
    case "checkout": {
      const p = parseArgs(rest, new Set(["-b", "-B", "--orphan"]));
      if (shortHas(p.flags, "bB") || longIs(p.flags, "--orphan")) return; // creating a branch
      const paths = p.dd.length ? p.dd : p.pos.length === 1 ? p.pos : [];
      if (shortHas(p.flags, "f") || longIs(p.flags, "--force") || paths.some((w) => WHOLE_TREE.test(w.value))) a.add("git-discard", "", subject);
      return;
    }
    case "restore": {
      const p = parseArgs(rest, new Set(["-s", "--source"]));
      const stagedOnly = (shortHas(p.flags, "S") || longIs(p.flags, "--staged")) && !(shortHas(p.flags, "W") || longIs(p.flags, "--worktree"));
      if (!stagedOnly && p.pos.some((w) => WHOLE_TREE.test(w.value))) a.add("git-discard", "", subject);
      return;
    }
    case "switch": {
      const { flags } = parseArgs(rest, new Set(["-c", "-C", "--create", "--force-create"]));
      if (shortHas(flags, "f") || longIs(flags, "--force", "--discard-changes")) a.add("git-discard", "", subject);
      return;
    }
    case "stash": {
      const first = parseArgs(rest).pos[0];
      if (first && (first.value === "drop" || first.value === "clear")) a.add("git-stash-drop", "", subject);
      return;
    }
    case "branch": {
      const { flags } = parseArgs(rest);
      const del = shortHas(flags, "dD") || longIs(flags, "--delete");
      if (shortHas(flags, "D") || (del && (shortHas(flags, "f") || longIs(flags, "--force")))) a.add("git-branch-delete", "", subject);
      return;
    }
    default:
  }
}

// git push: which branches does it touch, and does it rewrite them?
function gitPush(c, args, dirKey) {
  const { a, seg } = c;
  const { flags, pos } = parseArgs(args, PUSH_VALUE);
  if (isDryRun(flags) || shortHas(flags, "n")) return; // nothing is pushed
  const forceFlag = shortHas(flags, "f") || longIs(flags, "--force", "--force-with-lease", "--force-if-includes");
  const mirror = longIs(flags, "--mirror");
  const deleting = shortHas(flags, "d") || longIs(flags, "--delete");
  const everything = mirror || longIs(flags, "--all", "--branches");

  // [{ branch: name | "*" (all) | null (the current branch) | undefined (not a branch), force }]
  const targets = [];
  for (const w of pos.slice(1)) {
    const plus = w.value.startsWith("+");
    const spec = plus ? w.value.slice(1) : w.value;
    const colon = spec.lastIndexOf(":");
    const src = colon < 0 ? spec : spec.slice(0, colon);
    let dst = colon < 0 ? spec : spec.slice(colon + 1);
    const del = deleting || (colon >= 0 && src === "");
    let branch;
    if (dst === "HEAD") branch = null;
    else if (dst.startsWith("refs/heads/")) branch = dst.slice(11);
    else if (dst.startsWith("refs/")) branch = undefined; // a tag or a note
    else branch = dst;
    if (branch && branch.includes("*")) branch = "*";
    if (dst === "") branch = undefined;
    targets.push({ branch, force: plus || del });
  }
  if (!targets.length) {
    if (everything) targets.push({ branch: "*", force: false });
    else if (!longIs(flags, "--tags")) targets.push({ branch: null, force: false }); // the current branch
    else if (forceFlag) a.add("git-force-push", "tags", seg.text);
  }

  const forced = (t) => t.force || forceFlag || mirror || deleting;
  const needsBranch = targets.some((t) => t.branch === null && (forced(t) || a.mayFire("git-push-protected")));
  let current;
  const resolved = (t) => {
    if (t.branch !== null) return t.branch;
    if (current === undefined) current = needsBranch ? currentBranch(a, dirKey) : null;
    return current;
  };
  const isProtected = (t) => { const b = resolved(t); return b === "*" || (!!b && a.isProtected(b)); };

  const hitForced = targets.filter(forced);
  if (hitForced.length) {
    const protectedOnes = hitForced.filter(isProtected);
    if (protectedOnes.length) a.add("git-force-push-protected", shorten(protectedOnes.map((t) => (resolved(t) === "*" ? "all branches" : resolved(t))).join(", ")), seg.text);
    else a.add("git-force-push", shorten(hitForced.map((t) => resolved(t)).filter(Boolean).join(", ")), seg.text);
  }
  const plain = targets.filter((t) => !forced(t) && isProtected(t));
  if (plain.length) a.add("git-push-protected", shorten(plain.map((t) => resolved(t)).join(", ")), seg.text);
}

// `git add` earlier in the same command line: the commit that follows will contain more than the
// index holds right now, so the scan has to look at the working tree too.
function gitAdd(c, args) {
  const { a } = c;
  const { flags, pos } = parseArgs(args);
  const all = shortHas(flags, "A") || longIs(flags, "--all");
  const update = shortHas(flags, "u") || longIs(flags, "--update");
  const paths = pos.map((w) => w.value);
  if (!all && !update && !paths.length) return; // git add -p and the like
  a.adds.push({ paths: all || (update && !paths.length) ? null : paths, untracked: all || (!update && paths.length > 0) });
}

const COMMIT_VALUE = new Set(["-m", "-F", "-C", "-c", "-t", "--message", "--file", "--author", "--date", "--reuse-message", "--reedit-message", "--template", "--fixup", "--squash", "--cleanup", "--trailer"]);
const mergePaths = (x, y) => (!x ? y : x.paths === null || y.paths === null ? { paths: null } : { paths: [...x.paths, ...y.paths] });

function gitCommit(c, args, dirKey) {
  const { a, seg } = c;
  const { flags, pos, dd } = parseArgs(args, COMMIT_VALUE);
  if (longIs(flags, "--dry-run")) return;
  const cwd = spawnCwd(a, dirKey);
  if (!cwd) return;
  const plan = { cwd, unstaged: null, untracked: null };
  if (shortHas(flags, "a") || longIs(flags, "--all")) plan.unstaged = mergePaths(plan.unstaged, { paths: null });
  const named = [...pos, ...dd].map((w) => w.value);
  if (named.length) plan.unstaged = mergePaths(plan.unstaged, { paths: named });
  for (const add of a.adds) {
    plan.unstaged = mergePaths(plan.unstaged, { paths: add.paths });
    if (add.untracked) plan.untracked = mergePaths(plan.untracked, { paths: add.paths });
  }
  const found = commitFindings(a.git, plan);
  if (!found.length) return;
  // "kind in file" for as many as fit on one short line, then a count: never the secret itself
  const items = found.map((f) => `${f.kind} in ${shorten(f.file, 40)}`);
  const shown = [];
  let length = 0;
  for (const item of items) {
    if (shown.length >= 3 || (shown.length && length + item.length > 100)) break;
    shown.push(item);
    length += item.length + 2;
  }
  a.add("commit-secret", shown.join(", ") + (items.length > shown.length ? ` and ${items.length - shown.length} more` : ""), seg.text);
}

// ---------------------------------------------------------------------------------------------
// Databases: destructive SQL given to a database client
// ---------------------------------------------------------------------------------------------

const SQL_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3", "sqlcmd", "mongosh", "mongo", "redis-cli", "clickhouse-client", "cockroach", "usql", "pgcli", "mycli", "litecli", "sqlplus", "duckdb", "bq"]);

// /* block comments */ removed in one pass (an unclosed one runs to the end).
function stripBlockComments(text) {
  let out = "";
  let i = 0;
  for (;;) {
    const open = text.indexOf("/*", i);
    if (open < 0) return out + text.slice(i);
    out += text.slice(i, open) + " ";
    const close = text.indexOf("*/", open + 2);
    if (close < 0) return out;
    i = close + 2;
  }
}

function sqlDestructive(text) {
  // Comments go first. A "-- " comment needs the space: --command=... and --eval are options, not comments.
  const t = stripBlockComments(text.slice(0, 1000000)).replace(/--(?:[ \t][^\n]*)?$/gm, " ");
  if (/\bDROP\s+(?:DATABASE|SCHEMA|TABLE)\b/i.test(t)) return true;
  if (/\bTRUNCATE\s+(?:TABLE\s+)?(?!\()["`[\w]/i.test(t)) return true;
  if (t.split(";").some((stmt) => /\bDELETE\s+FROM\b/i.test(stmt) && !/\bWHERE\b/i.test(stmt))) return true;
  return /\.dropDatabase\s*\(|\.dropCollection\s*\(|\.drop\s*\(\s*\)|\.(?:deleteMany|remove)\s*\(\s*\{\s*\}\s*\)|\bFLUSH(?:ALL|DB)\b/i.test(t);
}

// SQL given on the command line, in a here-document or here-string, or piped in.
function checkSql(c) {
  const { a, seg, words, k, segments } = c;
  const at = words.findIndex((w) => SQL_CLIENTS.has(commandName(w.value)));
  if (at < 0) return;
  const parts = [...vals(words.slice(at + 1)), ...seg.heredocs, ...seg.herestrings];
  if (isPipe(seg.op)) {
    for (const s of pipelineOf(segments, k)) {
      if (s === seg) break;
      parts.push(...vals(s.words), ...s.heredocs, ...s.herestrings); // all words: a PowerShell string is the first word
    }
  }
  if (sqlDestructive(parts.join("\n"))) a.add("sql-destructive", commandName(words[at].value), seg.text);
}

// ---------------------------------------------------------------------------------------------
// Publishing and infrastructure
// ---------------------------------------------------------------------------------------------

const hasPos = (pos, ...names) => names.some((n) => pos.some((w) => w.value === n));
// --dry-run, --dry-run=client, --dryrun: but --dry-run=false (or =none) is the real thing
const isDryRun = (flags) => flags.some((f) => /^--dry-?run(?:=(?!false$|none$|0$|no$).*)?$/.test(f));

export function checkPublish(c) {
  const { a, name, args, seg } = c;
  const { flags, pos } = parseArgs(args, new Set(["--filter", "-F", "--tag", "--registry"]));
  const first = (n) => pos.slice(0, n).map((w) => w.value);
  let hit = false;
  switch (name) {
    case "npm": case "pnpm": case "bun": case "lerna": case "changeset": case "changesets":
      hit = first(3).includes("publish") && !isDryRun(flags); break;
    case "yarn": hit = (first(1)[0] === "publish" || (first(1)[0] === "npm" && first(2)[1] === "publish")) && !isDryRun(flags); break;
    case "cargo": hit = first(1)[0] === "publish" && !isDryRun(flags); break;
    case "dotnet": hit = first(1)[0] === "nuget" && first(2)[1] === "push"; break;
    case "nuget": hit = first(1)[0] === "push"; break;
    case "twine": hit = first(1)[0] === "upload"; break;
    case "python": case "python3": case "py": {
      const v = vals(args);
      hit = v.includes("twine") && v[v.indexOf("twine") - 1] === "-m" && v.includes("upload");
      break;
    }
    case "poetry": case "uv": case "flit": case "hatch": case "vsce": case "ovsx": hit = first(1)[0] === "publish" && !isDryRun(flags); break;
    case "gem": hit = first(1)[0] === "push"; break;
    case "gh": hit = first(1)[0] === "release" && first(2)[1] === "create"; break;
    case "docker": case "podman": case "docker-compose":
      hit = first(1)[0] === "push" || (first(1)[0] === "image" && first(2)[1] === "push") || (first(2).includes("compose") && first(3).includes("push"))
        || (longIs(flags, "--push") && hasPos(pos, "build", "buildx"));
      break;
    default:
  }
  if (hit) a.add("publish", name, seg.text);
}

const TF_NAMES = new Set(["terraform", "tofu", "terragrunt", "pulumi", "cdk"]);
const KUBECTL_VALUE = new Set(["-n", "--namespace", "--context", "--cluster", "--user", "--kubeconfig", "-s", "--server", "--token", "--as", "--as-group", "--request-timeout", "-v", "--v", "--certificate-authority", "--client-certificate", "--client-key", "--cache-dir", "--tls-server-name", "--username", "--password"]);
const HELM_VALUE = new Set(["-n", "--namespace", "--kube-context", "--kubeconfig", "--kube-apiserver", "--kube-token", "--registry-config", "--repository-config", "--repository-cache"]);
const AWS_VALUE = new Set(["--profile", "--region", "--output", "--endpoint-url", "--query", "--cli-read-timeout", "--cli-connect-timeout", "--ca-bundle", "--color"]);
const AWS_DESTRUCTIVE = /^(?:terminate-instances|delete-(?:db-instance|db-cluster|stack|table|bucket|cluster|hosted-zone|vpc|user|role|policy|distribution|stack-set))$/;

export function checkInfra(c) {
  const { a, name, args, seg } = c;
  const subject = seg.text;
  const dry = isDryRun;
  if (TF_NAMES.has(name)) {
    const { flags, pos } = parseArgs(args);
    const auto = longIs(flags, "-auto-approve", "--auto-approve");
    if (hasPos(pos, "destroy") || (hasPos(pos, "apply") && longIs(flags, "-destroy", "--destroy"))) a.add("terraform-destroy", name, subject);
    else if (auto && hasPos(pos, "apply") && name !== "pulumi") a.add("terraform-auto-approve", name, subject);
    return;
  }
  if (name === "kubectl" || name === "oc") {
    const { flags, pos } = parseArgs(args, KUBECTL_VALUE);
    if (pos[0] && pos[0].value === "delete" && !dry(flags)) a.add("kubectl-delete", name, subject);
    return;
  }
  if (name === "helm") {
    const { flags, pos } = parseArgs(args, HELM_VALUE);
    if (pos[0] && (pos[0].value === "uninstall" || pos[0].value === "delete" || pos[0].value === "un") && !dry(flags)) a.add("helm-uninstall", name, subject);
    return;
  }
  if (name === "docker" || name === "podman" || name === "docker-compose") {
    const { flags, pos } = parseArgs(args);
    const p = vals(pos);
    const all = shortHas(flags, "a") || longIs(flags, "--all", "--volumes");
    if ((p[0] === "system" && p[1] === "prune" && all) || (p[0] === "image" && p[1] === "prune" && all) || (p[0] === "volume" && p[1] === "prune")
      || ((p[0] === "compose" || name === "docker-compose") && p.includes("down") && (shortHas(flags, "v") || longIs(flags, "--volumes")))) a.add("docker-prune", name, subject);
    return;
  }
  if (name === "aws") {
    const { flags, pos } = parseArgs(args, AWS_VALUE);
    const p = vals(pos);
    if (dry(flags)) return;
    if ((p[0] === "s3" && p[1] === "rm" && longIs(flags, "--recursive")) || (p[0] === "s3" && p[1] === "rb") || AWS_DESTRUCTIVE.test(p[1] || "")) a.add("aws-destroy", shorten(p.slice(0, 2).join(" ")), subject);
    return;
  }
  if (name === "gcloud" || name === "az") {
    const { pos } = parseArgs(args);
    if (hasPos(pos, "delete")) a.add(name === "gcloud" ? "gcloud-delete" : "az-delete", shorten(vals(pos).slice(0, 3).join(" ")), subject);
    return;
  }
  if (name === "gsutil") {
    const { flags, pos } = parseArgs(args);
    if (hasPos(pos, "rm") && shortHas(flags, "rR")) a.add("gcloud-delete", "gsutil rm -r", subject);
  }
}

// ---------------------------------------------------------------------------------------------
// The machine: disks, power, permissions
// ---------------------------------------------------------------------------------------------

const DISK_TOOLS = new Set(["mke2fs", "mkswap", "wipefs", "fdisk", "sfdisk", "parted", "sgdisk", "gdisk", "cfdisk", "diskpart", "format", "format-volume", "clear-disk", "remove-partition", "initialize-disk", "diskutil", "dd", "shred", "blkdiscard"]);
export const DISK_NAMES = [...DISK_TOOLS];
const isMkfs = (name) => name === "mkfs" || name.startsWith("mkfs.");
export const isDiskCommand = (name) => DISK_TOOLS.has(name) || isMkfs(name);

export function checkDisk(c) {
  const { a, name, args, seg } = c;
  const subject = seg.text;
  const flag = (detail) => a.add("disk-wipe", detail || name, subject);
  const { flags, pos } = parseArgs(args);
  if (isMkfs(name)) return flag();
  switch (name) {
    case "dd": {
      for (const w of args) {
        if (!w.value.startsWith("of=")) continue;
        const kind = targetKind(w.value.slice(3));
        if (kind === "disk") flag(shorten(w.value.slice(3)));
        else if (kind === "file") checkFile(a, w.value.slice(3), "write", subject);
      }
      return;
    }
    case "shred": {
      for (const w of pos) {
        if (targetKind(w.value) === "disk") flag(shorten(w.value));
        else checkFile(a, w.value, "delete", subject);
      }
      return;
    }
    case "wipefs": if (shortHas(flags, "afo") || longIs(flags, "--all", "--force", "--offset")) flag(); return;
    case "fdisk": case "sfdisk": case "gdisk": case "cfdisk": case "sgdisk": case "parted":
      if (shortHas(flags, "l") || longIs(flags, "--list", "--print") || (name === "parted" && hasPos(pos, "print", "p")) || (name === "sgdisk" && shortHas(flags, "p"))) return;
      return flag();
    case "format": if (pos[0] && /^[a-z]:$/i.test(pos[0].value)) flag(pos[0].value); return;
    case "diskutil": {
      const p = vals(pos).map((x) => x.toLowerCase());
      if (/^(?:erase|zerodisk|partitiondisk|secureerase|reformat|repartition)/.test(p[0] || "") || (p[0] === "apfs" && /^delete/.test(p[1] || ""))) flag();
      return;
    }
    case "format-volume": case "clear-disk": case "remove-partition": case "initialize-disk": {
      const sw = parsePs(args, [], ["whatif"]).switches;
      if (![...sw].some(isPsWhatIf)) flag();
      return;
    }
    default: return flag(); // diskpart, blkdiscard
  }
}

export function checkPower(c) {
  const { a, name, args, seg } = c;
  const { flags, pos } = parseArgs(args);
  const p = vals(pos);
  const cancel = shortHas(flags, "c") || args.some((w) => /^\/a$/i.test(w.value)); // shutdown -c, shutdown /a
  switch (name) {
    case "shutdown": if (!cancel) a.add("shutdown", name, seg.text); return;
    case "init": case "telinit": if (p[0] === "0" || p[0] === "6") a.add("shutdown", `${name} ${p[0]}`, seg.text); return;
    case "systemctl": case "loginctl": if (p.some((x) => /^(?:poweroff|reboot|halt|kexec)$/.test(x))) a.add("shutdown", `${name} ${p[0]}`, seg.text); return;
    case "stop-computer": case "restart-computer": {
      const sw = parsePs(args, [], ["whatif"]).switches;
      if (![...sw].some(isPsWhatIf)) a.add("shutdown", name, seg.text);
      return;
    }
    default: a.add("shutdown", name, seg.text); // reboot, halt, poweroff
  }
}

export function checkChmod(c) {
  const { a, name, args, seg } = c;
  const { flags, pos, values } = parseArgs(args, new Set(["--reference", "--from"]));
  if (!(shortHas(flags, "R") || longIs(flags, "--recursive"))) return;
  const targets = values.has("--reference") ? pos : pos.slice(1); // the first operand is the mode or the owner
  for (const w of targets) {
    const r = a.paths.resolve(w.value, a.cwdKey);
    if (!r.unknown && (!r.glob || r.globAll) && a.paths.systemFolder(r.key)) { a.add("chmod-root", `${name} ${shorten(w.value)}`, seg.text); return; }
  }
}

// ---------------------------------------------------------------------------------------------
// Shell writes and reads of files: the file rules, for commands that touch files
// ---------------------------------------------------------------------------------------------

/** A file a shell command writes: a redirect target, tee, cp ... */
export function writeTarget(c, value, opts = {}) {
  const kind = targetKind(value);
  if (kind === "null") return;
  if (kind === "disk") { c.a.add("disk-wipe", shorten(value), c.seg.text); return; }
  checkFile(c.a, value, "write", c.seg.text, opts);
}

const CP_VALUE = new Set(["-t", "-S", "--target-directory", "--suffix", "-m", "-o", "-g", "--mode", "--owner", "--group"]);
const SED_VALUE = new Set(["-e", "-f", "-l", "--expression", "--file", "--line-length"]);
const PERL_VALUE = new Set(["-e", "-E", "-I", "-M", "-m", "-F", "-l", "-0"]);
const PS_WRITE_VALUE = ["path", "literalpath", "filepath", "destination", "value", "encoding", "itemtype", "name", "newname", "stream", "include", "exclude", "filter", "credential", "erroraction", "inputobject", "width", "delimiter"];
const PS_WRITE_SWITCH = ["force", "recurse", "whatif", "confirm", "passthru", "append", "noclobber", "nonewline", "verbose", "debug", "container"];

/** The names of the commands that write files, for the registry in analyze.mjs. */
export const WRITER_NAMES = ["tee", "cp", "mv", "install", "ln", "sed", "perl", "ruby", "truncate", "touch", "curl", "wget",
  "set-content", "sc", "add-content", "ac", "clear-content", "clc", "new-item", "ni", "out-file", "tee-object", "export-csv", "export-clixml",
  "copy-item", "cpi", "copy", "move-item", "mi", "move", "rename-item", "ren", "rni", "xcopy", "invoke-webrequest", "iwr", "invoke-restmethod", "irm"];

export function checkWriters(c) {
  const { a, name, args, dialect, seg } = c;
  const subject = seg.text;
  const destroy = (value) => checkFile(a, value, "delete", subject);
  const psMode = dialect === "powershell";

  if (psMode && /^(set-content|sc|add-content|ac|clear-content|clc|new-item|ni|out-file|tee-object|tee|export-csv|export-clixml)$/.test(name)) {
    const p = parsePs(args, PS_WRITE_VALUE, PS_WRITE_SWITCH);
    const targets = [...(p.named.get("path") || []), ...(p.named.get("literalpath") || []), ...(p.named.get("filepath") || [])];
    if (!targets.length && p.pos[0]) targets.push(p.pos[0]);
    for (const t of targets) {
      writeTarget(c, t.value);
      for (const n of p.named.get("name") || []) writeTarget(c, joinName(t.value, n.value), { nameOnly: true });
    }
    return;
  }
  if (psMode && /^(copy-item|cpi|copy|cp|move-item|mi|move|mv)$/.test(name)) {
    const p = parsePs(args, PS_WRITE_VALUE, PS_WRITE_SWITCH);
    const dest = (p.named.get("destination") || [])[0] || p.pos[p.named.has("path") || p.named.has("literalpath") ? 0 : 1];
    const sources = [...(p.named.get("path") || []), ...(p.named.get("literalpath") || []), ...(p.named.has("path") || p.named.has("literalpath") ? [] : p.pos.slice(0, 1))];
    if (dest) {
      writeTarget(c, dest.value);
      for (const s of sources) writeTarget(c, joinName(dest.value, baseOf(s.value)), { nameOnly: true });
    }
    if (/^(move-item|mi|move|mv)$/.test(name)) for (const s of sources) destroy(s.value);
    return;
  }
  if (psMode && /^(invoke-webrequest|iwr|invoke-restmethod|irm|curl|wget)$/.test(name)) {
    const p = parsePs(args, ["uri", "outfile", "method", "headers", "body", "contenttype", "credential", "useragent", "timeoutsec", "maximumredirection", "proxy", "infile", "erroraction", "outvariable", "sessionvariable", "websession", "form", "token"], ["usebasicparsing", "useb", "passthru", "skipcertificatecheck", "allowunencryptedauthentication"]);
    for (const w of p.named.get("outfile") || []) writeTarget(c, w.value);
    return;
  }
  if (psMode && /^(rename-item|ren|rni)$/.test(name)) {
    const p = parsePs(args, PS_WRITE_VALUE, PS_WRITE_SWITCH);
    const from = (p.named.get("path") || p.named.get("literalpath") || [])[0] || p.pos[0];
    const to = (p.named.get("newname") || [])[0] || p.pos[1];
    if (from) destroy(from.value);
    if (from && to) writeTarget(c, joinName(from.value.replace(/[^\\/]*$/, ""), to.value), { nameOnly: true });
    return;
  }

  switch (name) {
    case "tee": for (const w of parseArgs(args).pos) if (w.value !== "-") writeTarget(c, w.value); return;
    case "cp": case "mv": case "install": case "ln": case "copy": case "move": case "xcopy": {
      const isSwitch = (w) => dialect === "cmd" && /^\/[a-zA-Z?](:.*)?$/.test(w.value);
      const p = dialect === "cmd" ? { pos: args.filter((w) => !isSwitch(w)), values: new Map(), flags: [] } : parseArgs(args, CP_VALUE);
      const tdir = (p.values.get("-t") || p.values.get("--target-directory") || [])[0];
      let sources = p.pos;
      let dest = tdir;
      if (!dest && p.pos.length >= 2) { dest = p.pos[p.pos.length - 1]; sources = p.pos.slice(0, -1); }
      if (name === "install" && shortHas(p.flags, "d")) { for (const w of p.pos) writeTarget(c, w.value); return; }
      if (dest) {
        writeTarget(c, dest.value);
        // The destination may be a folder (cp .env backup/): then the file lands inside it under its own name.
        const maybeFolder = !!tdir || /[\\/]$/.test(dest.value) || !baseOf(dest.value).slice(1).includes(".");
        if (name !== "ln" && maybeFolder) for (const s of sources) writeTarget(c, joinName(dest.value, baseOf(s.value)), { nameOnly: true });
      }
      if ((name === "mv" || name === "move") && dest) for (const s of sources) destroy(s.value);
      return;
    }
    case "sed": case "perl": case "ruby": {
      const { flags, pos } = parseArgs(args, name === "sed" ? SED_VALUE : PERL_VALUE);
      const inPlace = name === "sed" ? shortHas(flags, "i") || longIs(flags, "--in-place") : shortHas(flags, "i");
      if (!inPlace) return;
      const scriptGiven = name === "sed" ? flags.some((f) => /^-[a-zA-Z]*[ef]$/.test(f) || /^--(expression|file)/.test(f)) : flags.some((f) => /^-[a-zA-Z]*[eE]$/.test(f));
      for (const w of scriptGiven ? pos : pos.slice(1)) writeTarget(c, w.value);
      return;
    }
    case "truncate": case "touch": {
      const valueOpts = name === "truncate" ? new Set(["-s", "-r", "--size", "--reference"]) : new Set(["-t", "-d", "-r", "--date", "--reference", "--time"]);
      for (const w of parseArgs(args, valueOpts).pos) writeTarget(c, w.value);
      return;
    }
    case "curl": {
      const { values } = parseArgs(args, new Set(["-o", "--output"]));
      for (const w of [...(values.get("-o") || []), ...(values.get("--output") || [])]) writeTarget(c, w.value);
      return;
    }
    case "wget": {
      const { values } = parseArgs(args, new Set(["-O", "--output-document", "-P", "--directory-prefix"]));
      for (const k of ["-O", "--output-document", "-P", "--directory-prefix"]) for (const w of values.get(k) || []) writeTarget(c, w.value);
      return;
    }
    default:
  }
}

const READER_ALL = new Set(["cat", "bat", "batcat", "less", "more", "most", "head", "tail", "nl", "tac", "type", "strings", "xxd", "od", "hexdump", "base64", "cut", "sort", "uniq", "diff", "cmp", "comm", "paste", "fold", "rev"]);
const READER_PATTERN = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "sed", "awk", "gawk", "mawk", "jq", "yq"]);
const PS_READ = new Set(["get-content", "gc", "cat", "type", "select-string", "sls"]);
export const READER_NAMES = [...READER_ALL, ...READER_PATTERN, ...PS_READ];
// Options that take a value, for the commands whose first plain argument is a pattern or a script.
const GREP_VALUE = new Set(["-e", "-f", "-m", "-A", "-B", "-C", "-g", "-t", "--include", "--exclude", "--exclude-dir", "--regexp", "--file", "--max-count", "--glob", "--type"]);
const PATTERN_VALUE = { sed: new Set(["-e", "-f", "-l"]), awk: new Set(["-f", "-F", "-v"]), gawk: new Set(["-f", "-F", "-v"]), mawk: new Set(["-f", "-F", "-v"]), jq: new Set(["-f", "--arg", "--argjson", "--slurpfile", "--rawfile"]), yq: new Set(["-f", "--arg"]) };

/** Commands that print files: a secrets file would land in the conversation. */
export function checkReaders(c) {
  const { a, name, args, dialect, seg } = c;
  const read = (value) => { if (value !== "-") checkFile(a, value, "read", seg.text); };
  if (dialect === "powershell" && PS_READ.has(name)) {
    const isSelect = name === "select-string" || name === "sls";
    const p = parsePs(args, ["path", "literalpath", "pattern", "totalcount", "tail", "head", "first", "last", "encoding", "delimiter", "include", "exclude", "filter", "context", "stream", "erroraction"], ["raw", "wait", "force", "asbytestream", "simplematch", "casesensitive", "list", "quiet", "notmatch"]);
    const files = [...(p.named.get("path") || []), ...(p.named.get("literalpath") || [])];
    const rest = isSelect && !p.named.has("pattern") ? p.pos.slice(1) : p.pos;
    for (const w of [...files, ...rest]) read(w.value);
    return;
  }
  if (READER_ALL.has(name)) {
    // No option values are skipped on purpose: a stray value (head -n 5 .env) is a name that matches nothing.
    for (const w of parseArgs(args).pos) read(w.value);
    return;
  }
  if (READER_PATTERN.has(name)) {
    const { flags, pos } = parseArgs(args, PATTERN_VALUE[name] || GREP_VALUE);
    if (name === "sed" && (shortHas(flags, "i") || longIs(flags, "--in-place"))) return; // an edit: the writer check handles it
    const scripted = flags.some((f) => /^-[a-zA-Z]*[ef]$/.test(f) || /^--(regexp|file|expression)/.test(f));
    for (const w of scripted ? pos : pos.slice(1)) read(w.value);
  }
}

// ---------------------------------------------------------------------------------------------
// Checks that apply to every command
// ---------------------------------------------------------------------------------------------

/** The command name: no folders, lower case, no .exe. */
export function commandName(value) {
  return String(value).replace(/\\/g, "/").split("/").pop().toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, "");
}

// claude-guardrails init | uninstall | allow | preset, however it is started
const BIN_WORD = /(?:^|[\\/:])(?:claude-guardrails(?:\.mjs)?|claude-code-guardrails)$/;
const MUTATING = new Set(["init", "uninstall", "allow", "preset"]);
function checkTamperCli(c) {
  const at = c.words.findIndex((w) => BIN_WORD.test(w.value));
  if (at >= 0 && c.words.slice(at + 1).some((w) => MUTATING.has(w.value))) c.a.add("guardrails-tamper", "claude-guardrails command", c.seg.text);
}

// Scripts piped or substituted into an interpreter: curl | sh, bash <(curl ...), iex (irm ...)
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh", "pwsh", "powershell"]);
const SCRIPT_LANGS = new Set(["python", "python2", "python3", "py", "perl", "ruby", "node", "deno", "bun", "php", "lua", "osascript"]);
const EVAL_LIKE = new Set(["eval", "source", ".", "iex", "invoke-expression"]);
const DOWNLOADERS = new Set(["curl", "wget", "iwr", "irm", "invoke-webrequest", "invoke-restmethod", "fetch", "aria2c", "xh", "lwp-request"]);
const DOWNLOAD_TEXT = /(?:^|[\s(|;&$`])(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|aria2c)(?:\.exe)?(?=[\s)'"]|$)|downloadstring|downloaddata|net\.webclient/i;
export const INTERPRETER_NAMES = [...SHELLS, ...SCRIPT_LANGS, ...EVAL_LIKE];

function checkRemoteScript(c) {
  const { a, name, args, seg, k, segments } = c;
  const isShell = SHELLS.has(name);
  const isLang = SCRIPT_LANGS.has(name);
  const evalLike = EVAL_LIKE.has(name);
  if (!isShell && !isLang && !evalLike) return;
  const { flags, pos } = parseArgs(args);

  // piped in: reads the script from stdin
  if (isPipe(seg.op)) {
    const readsStdin = evalLike || shortHas(flags, "s") || pos.length === 0 || pos[0].value === "-"; // bash, bash -s, bash -
    const line = pipelineOf(segments, k);
    const before = line.slice(0, line.indexOf(seg));
    if (readsStdin && before.some((s) => DOWNLOADERS.has(c.nameOf(s)))) { a.add("remote-script", `${name} reading a download`, seg.text); return; }
  }
  // substituted in: the downloaded text is the script
  let code = [];
  if (evalLike) code = args;
  else {
    code = args.filter((w) => w.raw.startsWith("<("));
    const at = args.findIndex((w) => /^-[a-zA-Z]*[ce]$/.test(w.value));
    if (at >= 0 && args[at + 1]) code.push(args[at + 1]);
  }
  if (code.some((w) => DOWNLOAD_TEXT.test(w.raw))) a.add("remote-script", `${name} running a download`, seg.text);
}

function checkForkBombWords(c) {
  const { name, args, a, seg } = c;
  if (name === "perl" || name === "ruby") {
    if (args.some((w) => /\bfork\s+while\s+fork\b/.test(w.value))) a.add("fork-bomb", name, seg.text);
  } else if (name === "python" || name === "python3") {
    if (args.some((w) => /while\s+(?:1|True)\s*:\s*os\.fork\(\)/.test(w.value))) a.add("fork-bomb", name, seg.text);
  }
}

/** Checks that look at every command, whatever its name. */
export function genericChecks(c) {
  checkTamperCli(c);
  checkSql(c);
  checkRemoteScript(c);
  checkForkBombWords(c);
}

export const POWER_NAMES = ["shutdown", "reboot", "halt", "poweroff", "stop-computer", "restart-computer", "init", "telinit", "systemctl", "loginctl"];
export const CHMOD_NAMES = ["chmod", "chown", "chgrp"];
export const PUBLISH_NAMES = ["npm", "pnpm", "bun", "lerna", "changeset", "changesets", "yarn", "cargo", "dotnet", "nuget", "twine", "python", "python3", "py", "poetry", "uv", "flit", "hatch", "vsce", "ovsx", "gem", "gh", "docker", "podman", "docker-compose"];
export const INFRA_NAMES = [...TF_NAMES, "kubectl", "oc", "helm", "docker", "podman", "docker-compose", "aws", "gcloud", "az", "gsutil"];
