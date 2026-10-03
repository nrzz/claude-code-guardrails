#!/usr/bin/env node
// claude-guardrails: safety presets for Claude Code. All the work lives in src/cli.mjs;
// run `claude-guardrails --help` for the commands.
import { main } from "../src/cli.mjs";

process.exitCode = await main(process.argv.slice(2));
