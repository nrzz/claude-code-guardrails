// The decision: run the analysis for the tool that is about to run, apply the preset and the
// configuration to each finding, and report the strictest outcome.
//
//   decide(input, { env, config }) -> { decision: "allow" | "ask" | "deny", rule, reason, findings }
//
// `input` is the PreToolUse hook input ({ tool_name, tool_input, cwd }). Nothing is printed here.

import { analyzeShell, createAnalysis } from "./analyze.mjs";
import { checkFile } from "./files.mjs";
import { decisionFor, rank, ruleOf } from "./rules.mjs";

const FILE_TOOLS = { Read: ["file_path", "read"], Write: ["file_path", "write"], Edit: ["file_path", "write"], MultiEdit: ["file_path", "write"], NotebookEdit: ["notebook_path", "write"] };
const SHELL_TOOLS = { Bash: "posix", PowerShell: "powershell" };

export const TOOLS = [...Object.keys(SHELL_TOOLS), ...Object.keys(FILE_TOOLS)];
const slashes = (p) => String(p).replace(/\\/g, "/");
const shorten = (s, n = 60) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// Is the entry (a rule id or a regular expression) a match for this finding?
const matches = (list, f) => list.ids.has(f.rule) || list.res.some((re) => f.subjects.some((s) => re.test(s)));

/** What one finding comes to, after the preset and the user's allow, deny and ask entries. */
export function resolveFinding(f, config) {
  const rule = ruleOf(f.rule);
  const base = decisionFor(f.rule, config.preset);
  if (matches(config.deny, f)) return "deny";
  if (config.allow.ids.has(f.rule)) return "allow"; // the exact rule id always counts
  if (!rule.floor && config.allow.res.some((re) => f.subjects.some((s) => re.test(s)))) return "allow";
  if (matches(config.ask, f)) return rank(base) >= rank("ask") ? base : "ask";
  return base;
}

/** The message Claude (deny) or the person (ask) sees. */
export function reasonText(f, decision) {
  const rule = ruleOf(f.rule);
  const text = `guardrails: ${rule.reason}${f.detail ? ` [${shorten(String(f.detail).replace(/\s+/g, " "), 120)}]` : ""} (rule ${rule.id})`; // a safety net: the checks keep details short themselves
  if (decision !== "deny") return text;
  const how = rule.id.startsWith("custom-") ? "ask the user to change the pattern in guardrails.json" : `ask the user to allow it: claude-guardrails allow ${rule.id}`;
  return `${text}. If this is intended, ${how}`;
}

export function decide(input, { env, config }) {
  const tool = input && typeof input.tool_name === "string" ? input.tool_name : "";
  const ti = input && input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const cwd = input && typeof input.cwd === "string" && input.cwd ? input.cwd : env.cwd;
  const a = createAnalysis({
    env: { ...env, cwd },
    preset: config.preset,
    protectedBranches: config.protectedBranches,
    // Could this rule's outcome differ from "allow"? Decides whether a git call is worth making.
    mayFire: (rule) => decisionFor(rule, config.preset) !== "allow" || config.ask.ids.has(rule) || config.deny.ids.has(rule),
  });

  let whole = []; // what a custom deny or ask pattern is tested against, besides each command segment
  if (SHELL_TOOLS[tool]) {
    const command = typeof ti.command === "string" ? ti.command : "";
    analyzeShell(command, SHELL_TOOLS[tool], a);
    whole = [command, ...a.segmentTexts];
  } else if (FILE_TOOLS[tool]) {
    const [field, op] = FILE_TOOLS[tool];
    const p = typeof ti[field] === "string" ? ti[field] : "";
    if (p) {
      checkFile(a, p, op, slashes(p));
      const r = a.paths.resolve(p, a.cwdKey);
      whole = r.unknown ? [slashes(p)] : [slashes(p), a.paths.relative(r.key)];
    }
  } else return { decision: "allow", rule: null, reason: "", findings: [] };

  const findings = a.findings.map((f) => ({ ...f, subjects: [f.subject, ...(FILE_TOOLS[tool] ? whole.slice(1) : [])] }));
  // The user's own patterns work on any command or path, with or without a built-in rule.
  for (const [list, rule] of [[config.deny, "custom-deny"], [config.ask, "custom-ask"]]) {
    for (const re of list.res) {
      const hit = whole.find((s) => s && re.test(s));
      if (hit !== undefined) findings.push({ rule, detail: shorten(re.source, 40), subject: hit, subjects: [hit] });
    }
  }

  let best = null;
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const decision = resolveFinding(f, config);
    const id = `${f.rule}|${f.detail}|${decision}`;
    if (!seen.has(id)) { seen.add(id); out.push({ rule: f.rule, detail: f.detail, decision }); }
    // The strictest wins; among equals, a floor rule, then the first one found.
    const better = !best || rank(decision) > rank(best.decision) || (rank(decision) === rank(best.decision) && !ruleOf(best.f.rule).floor && ruleOf(f.rule).floor);
    if (better) best = { f, decision };
  }
  if (!best || best.decision === "allow") return { decision: "allow", rule: null, reason: "", findings: out };
  return { decision: best.decision, rule: best.f.rule, reason: reasonText(best.f, best.decision), findings: out };
}

/** The text a PreToolUse hook prints: nothing for allow (so Claude Code's own prompts stay in charge). */
export function hookOutput(result) {
  if (!result || result.decision === "allow") return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: result.decision, permissionDecisionReason: result.reason } });
}
