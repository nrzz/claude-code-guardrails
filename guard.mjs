#!/usr/bin/env node
// The Claude Code PreToolUse hook. It prints nothing for calls it allows and a short JSON
// decision for the rest. All the work is in src/; this file stays tiny so it starts fast.
import { runHook } from "./src/hook.mjs";

await runHook();
