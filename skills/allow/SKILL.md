---
name: allow
description: Allow a rule guardrails blocked.
disable-model-invocation: true
argument-hint: <rule-id> [--scope project|user]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/claude-guardrails.mjs" *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/claude-guardrails.mjs *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/claude-guardrails.mjs" allow $ARGUMENTS`

Reply in one line with the result above. If it says the rule is unknown, list the suggestions it gave.
