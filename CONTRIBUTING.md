# Contributing to Claude Code guardrails

Thanks for helping. Claude Code guardrails is a PreToolUse hook (`guard.mjs`), a CLI and a Claude Code plugin, part of the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit). The bar for a change is the bar the code already meets: it works on Windows, macOS and Linux, it is tested, and it never wastes anyone's tokens.

## Start here

- **Good first issues:** [the issues labelled good first issue](https://github.com/nrzz/claude-code-guardrails/issues?q=is%3Aopen+label%3A%22good+first+issue%22), and the ideas in [ROADMAP.md](ROADMAP.md).
- **Questions and ideas:** [Discussions](https://github.com/nrzz/claude-code-guardrails/discussions).
- **Bugs:** [open an issue](https://github.com/nrzz/claude-code-guardrails/issues/new/choose) with the Claude Code version (`claude --version`), your OS, `node --version`, and the exact command and output.

## Set up

There is nothing to install: the project has no dependencies.

```bash
git clone https://github.com/nrzz/claude-code-guardrails
cd claude-code-guardrails
npm test
```

- `node bin/claude-guardrails.mjs check "rm -rf /"` shows a decision and its rule.
- Install into a throwaway config: `CLAUDE_CONFIG_DIR=$(mktemp -d) node bin/claude-guardrails.mjs init --scope user`, or load the plugin for one session with `claude --plugin-dir .`.

## Where things are

| Path | What it holds |
| --- | --- |
| `guard.mjs` | the hook entry |
| `src/` | the shell tokenizer (bash, PowerShell, cmd), the rules catalog, the checks and the CLI |
| `test/` | a table of commands across the three presets, fuzzing, git and secret-scan tests, a benchmark |

## House rules

1. **No dependencies.** Node built-ins only, Node 18 or newer, ES modules (`.mjs`). A pull request that adds a package to `dependencies` will not be merged.
2. **Every change comes with a test**, and `npm test` passes. CI runs the suite on Windows, macOS and Linux with Node 20, 22 and 24; a change that only works on one of them is not done.
3. **Token cost is a feature.** An allowed call prints nothing; a denied call costs only its one-line reason. Keep reasons under 120 characters. If your change puts anything new in front of Claude, say how many tokens in the pull request and update the README's "What it costs in tokens".
4. **Never touch real user data in tests.** Use a temporary folder and point `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE` at it. Tests never read `~/.claude/projects`; build synthetic transcripts instead. Build any fake secret from pieces (`"gh" + "p_" + ...`) so secret scanners do not flag the source.
5. **Settings files are the user's.** Back them up before writing, change only your own keys or hook entries, and leave a file that is not valid JSON alone.
6. **Keep the README honest.** Its "What was verified, and how" section says what was checked and what was not. If your change affects either, update it in the same pull request.

## Pull requests

- One logical change per pull request, with its test. Commit messages in the imperative mood ("Add a rule for gem push").
- Fill in the pull request template; CI must be green on all nine jobs.
- Signed commits are welcome but not required.
- Plain, specific writing in docs, messages and comments.

## Releases (maintainers)

Bump the version in `package.json` and `.claude-plugin/plugin.json`, add a section to [CHANGELOG.md](CHANGELOG.md), tag `vX.Y.Z` and publish a GitHub release with the changelog section as its notes.

## Conduct and security

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue.
