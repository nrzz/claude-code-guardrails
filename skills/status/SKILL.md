---
name: status
description: Show the guardrails preset and where it is installed.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/claude-guardrails.mjs" *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/claude-guardrails.mjs *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/claude-guardrails.mjs" status`

Summarise the block above in at most three lines: the preset in force, whether the hook is installed, and any warning.
