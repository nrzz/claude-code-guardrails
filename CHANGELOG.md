# Changelog

All notable changes to Claude Code guardrails are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.0.2] - 2026-10-04

- The two skills pre-approve only guardrails' own command (`node ${CLAUDE_PLUGIN_ROOT}/bin/claude-guardrails.mjs ...`) instead of any `node` command, so while one of them runs, other Node code still asks first.
- An icon for the plugin's listing in Anthropic's plugin directory.

## [1.0.1] - 2026-10-04

- `--dry-run` now passes for `poetry`, `uv`, `flit`, `hatch`, `vsce` and `ovsx` publishes too, as the README said.
- The reasons for `docker-prune` and `aws-destroy` name what they catch.
- README: what the rules and your own patterns really cover (`.npmrc` at commit, the Docker and AWS lists, `deny` and `ask` patterns on the whole command line), measured reason lengths and timings, and Node 18 in CI.

## [1.0.0] - 2026-10-04

- First release: a tokenizer for bash, PowerShell and cmd, rules for destructive deletes, force pushes, lost work, secrets in commits, SQL drops, publishing, infrastructure destroys, remote scripts, secrets files, lockfiles and writes outside the project; presets strict, balanced and relaxed; self-protection; project and user installs; a plugin.

[1.0.2]: https://github.com/nrzz/claude-code-guardrails/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/nrzz/claude-code-guardrails/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/nrzz/claude-code-guardrails/releases/tag/v1.0.0
