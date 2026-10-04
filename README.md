# Claude Code guardrails

[![test](https://github.com/nrzz/claude-code-guardrails/actions/workflows/test.yml/badge.svg)](https://github.com/nrzz/claude-code-guardrails/actions/workflows/test.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![node >= 18](https://img.shields.io/badge/node-%3E%3D18-339933.svg) ![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg) [![part of the Claude Code toolkit](https://img.shields.io/badge/Claude%20Code-toolkit-d97757.svg)](https://github.com/nrzz/claude-code-toolkit)

Safety presets for Claude Code, run as a `PreToolUse` hook: risky shell commands and file edits are denied (Claude reads a one-line reason and takes another route) or turned into a permission prompt, and everything else passes without a word. Three presets, `strict`, `balanced` (the default) and `relaxed`, decide how much is stopped, and nothing it checks costs a token unless it stops something.

It guards against accidents, not against an adversary: the `rm -rf` on the wrong folder, the force push to `main`, the `.env` that ends up in a commit. [What it does not catch](#what-it-does-not-catch) says where its reading of a command ends.

## What it costs in tokens

Nothing, unless it stops something, and then only the reason:

| Part | Tokens | |
| --- | --- | --- |
| Every allowed call (almost all of them) | 0 | The hook prints nothing at all: Claude sees nothing, you see nothing, and Claude Code's own permission prompts stay in charge |
| A denied call | about 45 | The reason Claude reads: one line of about 150 to 250 characters (up to about 300 for a very long file name). It usually saves a failed or destructive turn |
| An `ask` | 0 extra | Claude Code shows its normal permission prompt with the reason, to you. Claude only learns your answer |
| Skills in Claude's skill list | 0 | The two skills (`/guardrails:allow`, `/guardrails:status`) are user-only (`disable-model-invocation`), so Claude Code leaves them out of the list it gives the model. One short turn when you use one |
| `claude-guardrails ...` in a terminal | 0 | |
| Time per call | about 70 ms | Starting Node is almost all of it; the checks themselves take about 25 microseconds. 1000 checks run in about 25 ms |

## Install

**As a Claude Code plugin.** In Claude Code:

```text
/plugin marketplace add nrzz/claude-code-guardrails
/plugin install guardrails@claude-code-guardrails
```

Start a new session and the hook is active with the `balanced` preset. To allow a rule, use `/guardrails:allow <rule-id>`; to change the preset, run `claude-guardrails preset <name>` in a terminal or write a `guardrails.json` (see [Settings](#settings)).

**From a terminal**, with Node 18 or newer:

```bash
npx -y github:nrzz/claude-code-guardrails init
```

That copies the scripts to `~/.claude/claude-code-guardrails/` (or `$CLAUDE_CONFIG_DIR/...`), adds one `PreToolUse` entry to `~/.claude/settings.json`, and runs the installed hook once against `rm -rf /` to prove it works. `settings.json` is backed up first and only the one entry is added; a file that is not valid JSON is left alone, with the snippet to add by hand.

```bash
npx -y github:nrzz/claude-code-guardrails init --preset strict
npx -y github:nrzz/claude-code-guardrails init --scope project     # for the whole team
```

`--scope project` copies the scripts into `.claude/guardrails/` and registers them in `.claude/settings.json` with `${CLAUDE_PROJECT_DIR}`, so teammates get the same guard from a plain `git pull`. Commit `.claude/guardrails/` and `.claude/settings.json`. Use one route or the other: with both, the hook simply runs twice.

`claude-guardrails` in this document means `npx -y github:nrzz/claude-code-guardrails`, or `npm i -g github:nrzz/claude-code-guardrails` once, or after `init` `node ~/.claude/claude-code-guardrails/bin/claude-guardrails.mjs`.

## Use

You do not run anything. Claude Code asks the hook before every `Bash`, `PowerShell`, `Read`, `Write`, `Edit`, `MultiEdit` and `NotebookEdit` call, and the hook answers one of three ways:

- **allow** (nothing printed): the call goes on exactly as it would without the hook.
- **ask**: Claude Code shows its permission prompt with the reason, for you to decide.
- **deny**: the call does not run. Claude gets the reason as the result and can take another route:

```text
guardrails: force push to, or deletion of, a protected branch [main] (rule git-force-push-protected). If this is intended, ask the user to allow it: claude-guardrails allow git-force-push-protected
```

If it was intended, you run that command (in your terminal, or `/guardrails:allow git-force-push-protected` in Claude Code) and the rule is off for the project. Claude cannot do it for you: running `claude-guardrails allow` or editing the guard's own files is itself a rule (`guardrails-tamper`) that asks you first (in `strict` it denies).

Try a command without running it:

```text
$ claude-guardrails check git push --force origin main
deny  git-force-push-protected  (preset balanced)
  guardrails: force push to, or deletion of, a protected branch [main] (rule git-force-push-protected). ...

$ claude-guardrails check --preset relaxed "git reset --hard"
allow  (nothing matched; preset relaxed)

$ claude-guardrails check --tool Write --file .env
deny  secret-file-write  (preset balanced)
  guardrails: writes or deletes a secrets file (...) [env file: .env] (rule secret-file-write). ...
```

### The presets

| Preset | For | Compared with `balanced` |
| --- | --- | --- |
| `strict` | An agent nobody watches, or a team that wants every risky step to be a decision | Denies what balanced asks about: deleting outside the project or a `.git` folder, SQL drops, infrastructure destroys, lockfile edits, reads of secrets files, writes outside the project and changes to the guard itself. Asks before a direct push to a protected branch and before editing a CI workflow |
| `balanced` (default) | Working with Claude at the keyboard | Asks before the risky things that are sometimes wanted (`git reset --hard`, deleting outside the project, publishing, `curl \| sh`, destroying infrastructure) and denies the ones that never are |
| `relaxed` | You want a net under the disasters and no more prompts than that | Allows resets, cleans, stash drops, branch deletes, force pushes to unprotected branches, publishes, `curl \| sh`, deletes outside the project, lockfile edits and reads of secrets files. Still asks for SQL drops, infrastructure destroys, writes outside the project and deleting a `.git` folder |

### Every rule

`claude-guardrails rules` prints the same table in a terminal. A rule's decision is what the preset gives it; your own `allow`, `deny` and `ask` entries change it (see [Settings](#settings)). When one command trips several rules, the strictest decision wins.

#### Always blocked

Denied in every preset. No pattern in `guardrails.json` can switch these off; only the exact rule id can.

| Rule | strict | balanced | relaxed | Stops |
| --- | --- | --- | --- | --- |
| `rm-root` | deny | deny | deny | recursive delete of a filesystem root, home folder, system folder or the whole project |
| `disk-wipe` | deny | deny | deny | formats, partitions or overwrites a disk or block device |
| `shutdown` | deny | deny | deny | shuts down or reboots the machine |
| `chmod-root` | deny | deny | deny | recursive chmod or chown on a filesystem root or system folder |
| `fork-bomb` | deny | deny | deny | fork bomb: a function that pipes into itself in the background |
| `secret-file-write` | deny | deny | deny | writes or deletes a secrets file (.env, private key, credentials, .npmrc ...) |
| `commit-secret` | deny | deny | deny | staged changes contain a secret or a secrets file |

`rm-root` covers every spelling (`rm -rf`, `-fr`, `-r -f`, `--recursive --force`, `rimraf`, PowerShell `Remove-Item -Recurse -Force`, `rd /s /q`, `del /s`, `find ... -delete`) aimed at `/`, `/*`, `~`, `$HOME`, `.`, `..`, `*`, a drive root such as `C:\`, a system folder (`/etc`, `/usr`, `C:\Windows` ...), the project folder or anything above it. `shutdown` also covers `reboot`, `halt`, `poweroff`, `init 0`, `systemctl poweroff`, `Stop-Computer` and `Restart-Computer`; `disk-wipe` covers `mkfs*`, `dd of=/dev/...`, `format X:`, `diskpart`, `fdisk`, `parted`, `wipefs -a`, `diskutil erase*` and `Format-Volume`. `shutdown -c`, `fdisk -l`, `dd of=/dev/null` and `-WhatIf` are left alone.

#### git

Branches `main`, `master`, `release/*` and `production` are protected (configurable). `git-force-push-protected` and `git-dir-write` are denied in every preset, but a pattern in `allow` can still lift them.

| Rule | strict | balanced | relaxed | Stops |
| --- | --- | --- | --- | --- |
| `git-force-push-protected` | deny | deny | deny | force push to, or deletion of, a protected branch |
| `git-force-push` | ask | ask | allow | force push rewrites history on the remote |
| `git-push-protected` | ask | allow | allow | direct push to a protected branch |
| `git-reset-hard` | ask | ask | allow | git reset --hard throws away uncommitted work |
| `git-clean` | ask | ask | allow | git clean -f deletes untracked files for good |
| `git-discard` | ask | ask | allow | throws away all uncommitted changes in the working tree |
| `git-stash-drop` | ask | ask | allow | drops stashed work for good (git stash drop or clear) |
| `git-branch-delete` | ask | ask | allow | git branch -D deletes a branch even when it is not merged |
| `git-dir-write` | deny | deny | deny | writes inside .git/ and can corrupt the repository |

A force push is `--force`, `-f`, `--force-with-lease`, `--force-if-includes`, `+refspec`, `--mirror` or a branch deletion (`--delete`, `:branch`). The branch comes from the command (`git push -f origin main`, `HEAD:main`, `refs/heads/main`); when none is named, from `git rev-parse --abbrev-ref HEAD`. `--dry-run` is never a problem. `git commit` scans what it is about to commit (see [How it works](#how-it-works)).

#### Deleting

| Rule | strict | balanced | relaxed | Stops |
| --- | --- | --- | --- | --- |
| `rm-outside-project` | deny | ask | allow | recursive delete outside the project and the temp folder, or of a path that cannot be checked |
| `rm-git-dir` | deny | ask | ask | deletes a .git folder, which holds the whole repository history |

Inside the project (`rm -rf node_modules dist ./out`) and under the OS temp folder, recursive deletes are allowed. A path that cannot be resolved (`rm -rf "$DIR"`, paths from `xargs` or a PowerShell pipeline) counts as outside, because nobody can tell where it points. `cd` is followed, so `cd /tmp && rm -rf build` is a delete in `/tmp`.

#### Databases

Only when the SQL is handed to a database client (`psql`, `mysql`, `sqlite3`, `sqlcmd`, `mongosh`, `redis-cli` ...): in `-c`, `-e`, `--command`, `--eval`, a here-document, a here-string or a pipe.

| Rule | strict | balanced | relaxed | Stops |
| --- | --- | --- | --- | --- |
| `sql-destructive` | deny | ask | ask | destructive SQL: DROP DATABASE, SCHEMA or TABLE, TRUNCATE, or DELETE without WHERE |

#### Publishing

| Rule | strict | balanced | relaxed | Stops |
| --- | --- | --- | --- | --- |
| `publish` | ask | ask | allow | publishes a package, release or image (npm, cargo, twine, gh release, docker push ...) |

`npm`, `pnpm`, `yarn npm`, `bun`, `lerna`, `changeset publish`, `cargo`, `dotnet nuget push`, `twine upload`, `poetry`, `uv`, `flit`, `hatch`, `vsce`, `ovsx`, `gem push`, `gh release create`, `docker push`, `podman push`, `docker compose push` and `docker buildx build --push`. `--dry-run` is allowed for the tools that have one (npm, pnpm, yarn, bun, lerna, cargo, poetry, uv, flit, hatch, vsce, ovsx).

#### Infrastructure

| Rule | strict | balanced | relaxed | Stops |
| --- | --- | --- | --- | --- |
| `terraform-destroy` | deny | ask | ask | destroys infrastructure (terraform, tofu, terragrunt, pulumi or cdk destroy) |
| `terraform-auto-approve` | deny | ask | ask | terraform apply -auto-approve changes infrastructure without a review |
| `kubectl-delete` | deny | ask | ask | deletes Kubernetes resources |
| `helm-uninstall` | deny | ask | ask | uninstalls a Helm release |
| `docker-prune` | deny | ask | ask | removes Docker volumes or every unused image (prune -a or --volumes, volume prune, compose down -v) |
| `aws-destroy` | deny | ask | ask | deletes AWS resources (s3 rm --recursive, s3 rb, terminate-instances, delete-stack, delete-db-instance ...) |
| `gcloud-delete` | deny | ask | ask | deletes Google Cloud resources |
| `az-delete` | deny | ask | ask | deletes Azure resources |

`docker-prune` covers `system prune` or `image prune` with `-a`, `--all` or `--volumes`, `volume prune` and `compose down -v`. A plain `docker system prune` or `container prune`, which removes only stopped containers and dangling images, is allowed. `aws-destroy` covers `s3 rm --recursive`, `s3 rb`, `terminate-instances`, and `delete-` calls for stacks, stack sets, DB instances and clusters, tables, buckets, clusters, hosted zones, VPCs, IAM users, roles and policies, and CloudFront distributions; other `delete-` calls are not checked.

#### Remote scripts

| Rule | strict | balanced | relaxed | Stops |
| --- | --- | --- | --- | --- |
| `remote-script` | ask | ask | allow | runs a script downloaded from the network without reading it (curl \| sh, iex) |

`curl ... | sh`, `wget -qO- ... | sudo bash -`, `bash <(curl ...)`, `bash -c "$(curl ...)"`, `eval "$(curl ...)"`, `iwr ... | iex`, `iex (irm ...)`. Downloading to a file is allowed.

#### Files

Apply to the Write, Edit, MultiEdit, NotebookEdit and Read tools, and to what a shell command does to files (redirects, `tee`, `cp`, `mv`, `sed -i`, `curl -o`, `rm`, PowerShell `Set-Content`, `Out-File`, `Copy-Item` ...).

| Rule | strict | balanced | relaxed | Stops |
| --- | --- | --- | --- | --- |
| `secret-file-read` | deny | ask | allow | reads a secrets file (.env, private key, credentials) into the conversation |
| `lockfile-edit` | deny | ask | allow | edits a lockfile by hand; let the package manager change it |
| `workflow-edit` | ask | allow | allow | edits a CI workflow in .github/workflows |
| `write-outside-project` | deny | ask | ask | writes outside the project and the temp folder |

Secrets files: `.env` and `.env.*`, `*.env`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, `id_rsa*`, `id_ed25519*` (also `id_ecdsa*`, `id_dsa*`), `credentials.json`, `secrets.*`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, and files under `.ssh/`, `.gnupg/`, `~/.aws/credentials`, `~/.docker/config.json`, `~/.kube/config`. Templates are not secrets: `.env.example`, `.env.sample`, `.env.template`, `.env.dist` (and `secrets.example.yaml`), and neither is a public key (`*.pub`) or `.ssh/known_hosts`. Lockfiles: `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `Cargo.lock`, `poetry.lock`, `Pipfile.lock`, `uv.lock`, `composer.lock`, `go.sum`, `packages.lock.json`, `Gemfile.lock`. Claude's own config folder (`~/.claude`: memory, plans, skills) is not "outside the project".

#### Self-protection

So that Claude cannot quietly switch the guard off.

| Rule | strict | balanced | relaxed | Stops |
| --- | --- | --- | --- | --- |
| `guardrails-tamper` | deny | ask | ask | changes the guardrails config or script, or Claude Code's settings |

`.claude/guardrails.json`, `.claude/guardrails/`, `.claude/settings.json`, `.claude/settings.local.json` (in the project and in `~/.claude`), and the commands `claude-guardrails init`, `uninstall`, `allow` and `preset`.

## Settings

Two optional files, both JSON:

| File | Who it is for |
| --- | --- |
| `<project>/.claude/guardrails.json` | The project; committed, so it applies to everyone who works on it |
| `<config folder>/guardrails.json` | You, for every project. The config folder is `$CLAUDE_CONFIG_DIR`, or `~/.claude` |

```json
{
  "preset": "balanced",
  "protectedBranches": ["main", "release/*", "develop"],
  "allow": ["git-clean", "^npm publish --dry-run", "^/home/me/other-repo/"],
  "deny": ["^docker compose down", "^make deploy"],
  "ask": ["^kubectl apply"]
}
```

| Key | Meaning |
| --- | --- |
| `preset` | `strict`, `balanced` or `relaxed`. The project's wins over yours, yours over the default (`balanced`) |
| `protectedBranches` | Names or globs (`release/*`). Replaces the default list (`main`, `master`, `release/*`, `production`); the two files' lists are joined |
| `allow` | Rules to let through |
| `deny` | Rules, or commands and paths, to block |
| `ask` | Rules, or commands and paths, to prompt for |

The `allow`, `deny` and `ask` lists of both files are joined. Each entry is a **rule id** (`git-reset-hard`) or a **regular expression** (case-sensitive, no flags; invalid ones are reported by `claude-guardrails status` and skipped):

- For a command, `deny` and `ask` patterns are tested against the whole command line and against each command segment (the text between `&&`, `;`, `|` and newlines, nested shells and substitutions included); `allow` only against a segment, as the next point says. For a file tool, a pattern is tested against the path with forward slashes, and against the path relative to the project.
- `allow` is tested against the segment that tripped the rule, not the whole line. Allowing `git status` never unlocks `git status && git push --force origin main`.
- `deny` and `ask` entries also stop commands that no built-in rule knows (`"deny": ["^make deploy"]` reports the rule `custom-deny`).
- Order: a matching `deny` wins; else a matching `allow` lets the call through; else a matching `ask` raises the call to at least a prompt; else the preset decides.
- Only the exact rule id can allow a rule from [Always blocked](#always-blocked). A pattern such as `".*"` cannot.
- `allow` for one rule: `claude-guardrails allow <rule-id>` (project file by default, `--scope user` for yours). `claude-guardrails preset strict` sets the preset (yours by default, `--scope project` for the team).

Folders you added to a session with `--add-dir` are outside the project for these rules. Let one through with a pattern, for example `"allow": ["^/home/me/other-repo/"]` for writes there, and `"^rm -rf /home/me/other-repo/build"` for a delete.

A project's `.claude/guardrails.json` is as trusted as the rest of its `.claude/` folder (it can add hooks too): read it before you work in a repository you do not know.

Environment: `CLAUDE_CONFIG_DIR` moves everything above, as it does for Claude Code. `CLAUDE_PROJECT_DIR`, which Claude Code sets for hooks, names the project; without it the project is the nearest folder with a `.git` or `.claude` above the working folder.

### Commands

```text
claude-guardrails init [--preset strict|balanced|relaxed] [--scope user|project]
claude-guardrails uninstall [--scope user|project] [--purge]
claude-guardrails check "<command>" [--tool Bash|PowerShell] [--preset <p>] [--cwd <dir>] [--json]
claude-guardrails check --tool Write|Edit|MultiEdit|NotebookEdit|Read --file <path> [--preset <p>]
claude-guardrails rules [--preset <p>]
claude-guardrails preset [<name>] [--scope user|project]
claude-guardrails allow <rule-id> [--scope project|user]
claude-guardrails status
```

`uninstall` removes the hook entry and our copy of the scripts, after a backup of `settings.json`. Your `guardrails.json` stays unless you add `--purge`. In Claude Code with the plugin: `/guardrails:allow <rule-id>` and `/guardrails:status`; remove the plugin with `/plugin uninstall guardrails@claude-code-guardrails`.

## How it works

- **The hook.** `guard.mjs` reads the event Claude Code sends on stdin (`tool_name`, `tool_input`, `cwd`), decides, and prints either nothing or `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"|"ask","permissionDecisionReason":"..."}}`. It never prints `allow`, because that would skip Claude Code's own permission prompts. The hook is registered in exec form (`node <path>`), so no shell runs and nothing needs quoting.
- **A tokenizer, not a regular expression.** A command line is split at `&&`, `||`, `;`, `|`, `&` and newlines with quotes, escapes, comments, here-documents, redirections and `$( )` substitutions handled for Bash, PowerShell and `cmd.exe` separately. That is why `echo "rm -rf /"` and `git commit -m "never run rm -rf /"` pass: quoted text is data. `sudo`, `doas`, `env A=B`, `nohup`, `time`, `command`, `exec`, `nice`, `timeout`, `npx` and friends are stripped; `bash -c`, `sh -c`, `zsh -c`, `su -c`, `eval`, `ssh host "..."`, `wsl`, `cmd /c`, `powershell -Command` (and `-EncodedCommand`), `xargs`, `find -exec` and `find -delete`, scripts given to a shell on its stdin, and substitutions are read too, up to five levels deep.
- **Paths are resolved, not matched.** `~`, `$HOME`, `%USERPROFILE%`, `$env:TEMP`, `.`, `..`, `/c/Users` (Git Bash), globs and brace lists are expanded where their value is known, then compared with the project folder, the temp folders, the home folder and the system folders, case-insensitively on Windows. The check is pure string work and never touches the file system.
- **When git is started.** Only for `git commit` (the scan below), for a force push that names no branch (`git rev-parse --abbrev-ref HEAD`, 2 second limit) and, in `strict`, for a plain `git push` that names none. Nothing else, however many commands go by. A git that is missing or slow means "no answer": the protected-branch check is skipped, though a force push that names no branch is still asked about in `strict` and `balanced`.
- **The commit scan.** `git commit` reads `git diff --cached --no-color -U0` (5 second limit; 7 seconds for the whole scan) and looks at the added lines for the secret patterns of [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync) (Anthropic, OpenAI, GitHub, GitLab, Slack, AWS, Google, Stripe, npm, Hugging Face and SendGrid keys, JWTs, private keys, bearer tokens, passwords in URLs and connection strings, `*_SECRET=` style lines), without matching placeholders such as `changeme`, a `${VARIABLE}` reference or `<your-token>`, and for staged secrets files by name (except `.npmrc`, which projects often commit with registry settings: there only a token in it that matches a known pattern blocks the commit). In the same command line it also looks at what `git commit -a`, `git commit <paths>` and a preceding `git add -A`, `git add .` or `git add <paths>` are about to add, including untracked files. A block names the kind and the file, never the secret.
- **Errors.** A hook never gets in the way of a session. Anything unexpected ends with no output and exit code 0, and one line (message and stack, never the command) in `<config folder>/claude-code-guardrails/errors.log`. `claude-guardrails status` shows the last one.

### What it does not catch

It reads commands the way a careful person would; it does not run them and it is not a sandbox. It misses:

- Commands it cannot see into: a script file (`bash cleanup.sh`, `make clean`, an npm script), `python -c` and `node -e` code, a variable or substitution used as the command name (`$CMD -rf /`), base64 or other computed commands, aliases and shell functions, a command a tool runs on another machine or in a container (`docker exec`, `kubectl exec`), and nesting deeper than five levels.
- Two-step downloads (`curl -o x.sh ...; sh x.sh`).
- File changes that go through a program other than the ones listed under Files.
- Anything that is not one of the seven tools in the matcher: other tools and MCP servers, and symbolic links that lead into a protected place.
- A project folder that is a whole home folder or drive: only paths two levels down count as inside it.

If the hook itself fails, the call goes through; that is the price of never getting in the way.

### Privacy

Guardrails runs only on your machine. It has no network code, no telemetry and no account, and it sends nothing anywhere. The hook reads the tool call Claude Code hands it (the command, or the file path of an edit) and, for `git commit`, the staged changes, decides, and keeps none of it. It writes only its own files: `guardrails.json` when you change a setting, the copy of its scripts and its entry in `settings.json` when you run `claude-guardrails init`, and `errors.log` (an error's message and stack, never the command) if the hook ever fails. Questions go to [the issues](https://github.com/nrzz/claude-code-guardrails/issues).

## What was verified, and how

Checked on 2026-10-04 on Windows 11 with Node 24 and git 2.55, and in CI on Windows, macOS and Linux with Node 20, 22 and 24 and on Linux with Node 18, all green:

- **985 automated tests** (`npm test`, Node's own runner, no dependencies). A table of 669 commands with the expected decision in each preset covers every rule and the tricky spellings: quoted text, `rm -rf ./build` and `node_modules`, nested `bash -c`, `sudo`/`env`/`nohup` prefixes, PowerShell and `cmd /c` spellings, `git push origin +main`, SQL in here-documents, `curl | sudo bash -`, here-strings, where a `cd` lasts, and command substitution inside unquoted here-documents. A second table does the same for about 150 file paths, Linux, macOS and Windows style (the checks are pure functions of a described machine, so every platform's paths are tested everywhere). A deterministic fuzz test makes 18,000 checks of random command lines and 16,000 of random paths: the engine must never throw and must always answer in the same short form.
- **Real git.** Force pushes are judged by the branch a throwaway repository is really on (main, a feature branch, a detached head, no repository); the commit scan runs against staged fake keys of every kind, staged `.env` files, `commit -a`, `git add -A && git commit`, untracked files, deleted `.env`, placeholders and large or binary files, and the tests count the git processes that get started (none for anything but those cases).
- **The hook as Claude Code runs it.** `node guard.mjs` is started with the event on stdin and the exact JSON for a deny and an ask is compared byte for byte; an allowed call produces empty stdout, empty stderr and exit code 0; malformed, empty or unrelated input is ignored; a forced internal failure ends silently with one log line that does not contain the command; a 3 MB event is fine.
- **Install and uninstall** in throwaway config folders and projects: backup byte for byte, the file's own indentation kept, other settings and other hooks untouched, a second `init` changes nothing and makes no backup, a stale entry of ours is replaced, invalid or oddly shaped `settings.json` is left alone with the snippet printed, `uninstall` restores exactly the settings that were there before, project scope vendors and removes the scripts.
- **Not crying wolf.** 277 ordinary development commands (git, npm, docker, kubectl, psql, curl, tar, find, heredoc commit messages ...) pass in silence in every preset.
- **Speed.** 1000 mixed command checks take about 25 ms and start no git process; the hook process starts in about 70 ms.
- **Hostile input.** Deeply nested substitutions, 500 KB here-documents, 50,000 chained commands and brace bombs are read in milliseconds. Stress testing found one case that took 16 seconds (a long line that made a fork-bomb pattern quadratic); it is fixed, and the comment stripping for SQL was made linear at the same time.
- **The manifests.** `claude plugin validate` passes (also with `--strict`) for `.claude-plugin/plugin.json`, for the marketplace (`.`) and for the skills folder, with Claude Code 2.1.286 and 2.1.289, and the plugin installs from GitHub with `/plugin marketplace add nrzz/claude-code-guardrails` and `/plugin install guardrails@claude-code-guardrails` (checked on 2026-10-04).
- **A slip of mine, and its fix.** While developing, a manual `status` run with a throwaway home folder searched for the project upwards, passed the temp folder and looked at the real `~/.claude` (it only checked for this tool's hook and printed nothing). The search now stops at the home and temp folders, that has a test, and every later run used `CLAUDE_PROJECT_DIR` and throwaway folders.

Since then, the [toolkit's end-to-end test](https://github.com/nrzz/claude-code-toolkit#tested-together) installs it with `npx -y github:nrzz/claude-code-guardrails init` on Windows, macOS and Linux and runs the hook the way Claude Code runs it, and the whole suite also passes on Node 18.

Not verified: a live Claude Code session with the hook or the plugin loaded. What Claude Code does with the `ask` and `deny` output is taken from its documented hook format and from `claude plugin validate`, not observed.

## Files

| Path | What it is |
| --- | --- |
| `guard.mjs` | The hook. Tiny: it calls `src/hook.mjs` |
| `src/` | `shell.mjs` the tokenizer; `analyze.mjs` and `checks.mjs` the command analysis; `args.mjs`, `paths.mjs`, `files.mjs`, `secrets.mjs`, `gitutil.mjs`, `fsutil.mjs`; `rules.mjs` the catalog; `config.mjs`, `decide.mjs`, `hook.mjs`; `meta.mjs` the name and version; `install.mjs` and `cli.mjs` for the command line (the hook does not load these two) |
| `bin/claude-guardrails.mjs` | The command line |
| `.claude-plugin/` | The plugin manifest and the marketplace that lists `guardrails` |
| `hooks/hooks.json` | The plugin's hook registration |
| `skills/` | `/guardrails:allow` and `/guardrails:status` |
| `test/` | `npm test` |

After `init`, a user has `~/.claude/claude-code-guardrails/` (the scripts, and `errors.log` once the hook has ever failed) and one entry in `~/.claude/settings.json`; a project has `.claude/guardrails/` and one entry in `.claude/settings.json`.

Related: [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync) shares sessions and context with your coworkers, [claude-code-handover](https://github.com/nrzz/claude-code-handover) keeps your own sessions short, and [claude-code-glow](https://github.com/nrzz/claude-code-glow) themes the interface.

## Contributing

Issues and pull requests are welcome: start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [good first issues](https://github.com/nrzz/claude-code-guardrails/issues?q=is%3Aopen+label%3A%22good+first+issue%22). Questions go to [Discussions](https://github.com/nrzz/claude-code-guardrails/discussions); security reports go through [SECURITY.md](SECURITY.md).

## Part of the Claude Code toolkit

Small, dependency-free tools that make Claude Code cheaper, safer and easier to share, all in the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit):

- [claude-code-handover](https://github.com/nrzz/claude-code-handover): short sessions with a handover file every new session loads by itself
- [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync): share sessions, notes and team context with coworkers
- [claude-code-glow](https://github.com/nrzz/claude-code-glow): themes for the whole interface, a status line and a live HUD
- [claude-code-notify](https://github.com/nrzz/claude-code-notify): a ping when Claude needs you or finishes
- [claude-md-doctor](https://github.com/nrzz/claude-md-doctor): what your CLAUDE.md costs every session, and how to slim it
- [claude-code-starter-kits](https://github.com/nrzz/claude-code-starter-kits): a lean, safe .claude/ for your stack in one command
- [claude-cost-guard](https://github.com/nrzz/claude-cost-guard): daily and weekly token budgets with zero-token warnings
- [claude-session-replay](https://github.com/nrzz/claude-session-replay): search past sessions and export one as an HTML replay

Set up any of them, or all of them, from one page: `npx -y github:nrzz/claude-code-toolkit` opens it with the recommended tools switched on.

## License

MIT
