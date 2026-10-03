# Security policy

## Supported versions

Security fixes go into the latest release on `main`.

## Reporting a vulnerability

Please do not report a vulnerability in a public issue. Use GitHub's private reporting: [https://github.com/nrzz/claude-code-guardrails/security/advisories/new](https://github.com/nrzz/claude-code-guardrails/security/advisories/new), or the contact in the [nrzz security policy](https://github.com/nrzz/.github/blob/master/SECURITY.md). You can expect a first answer within 72 hours, and credit in the release notes if you want it.

## What this tool can and cannot protect

Guardrails is a seatbelt, not a sandbox: pattern checks on commands can be outwitted by obfuscation, and Claude Code's own permission system remains the security boundary. Reports of commands that get past a rule are welcome, privately if they are dangerous.
