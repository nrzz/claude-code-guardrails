// Names and the version in one place. A test keeps VERSION equal to package.json, so the copy
// that init vendors into a project (which has no package.json next to it) can still report it.
export const NAME = "claude-code-guardrails";
export const BIN = "claude-guardrails";
export const VERSION = "1.0.0";
export const REPO_URL = "https://github.com/nrzz/claude-code-guardrails";

// The tools the PreToolUse hook is registered for.
export const HOOK_MATCHER = "Bash|PowerShell|Read|Write|Edit|MultiEdit|NotebookEdit";
export const HOOK_TIMEOUT = 10; // seconds; the slowest thing the hook does is a 5 s staged-diff scan
