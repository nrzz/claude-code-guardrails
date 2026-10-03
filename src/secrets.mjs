// Secret detection for the commit check. The patterns and the placeholder exclusions are the ones
// claude-code-team-sync uses to redact transcripts (SECRET_RULES, VALUE_RULES, PLACEHOLDER_VALUE),
// so both tools agree on what a secret looks like. Here a match is only reported (kind and file),
// never printed.

// Whole-match rules: the match is the secret.
export const SECRET_RULES = [
  ["private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai-key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g],
  ["stripe-key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g],
  ["github-token", /\bgithub_pat_[A-Za-z0-9_]{40,}/g],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["slack-webhook", /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g],
  ["teams-webhook", /https:\/\/[a-z0-9-]+\.webhook\.office\.com\/[^\s"'<>`]+/gi],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}/g],
  ["google-oauth-secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["huggingface-token", /\bhf_[A-Za-z0-9]{30,}\b/g],
  ["sendgrid-key", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
];

// A key's first line alone is enough: a diff of a half-added key has no END line.
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

// Label-and-value rules: group 1 is the label, group 2 the value.
export const VALUE_RULES = [
  ["bearer-token", /(\bBearer\s+)([A-Za-z0-9._~+/-]{20,}=*)/g],
  ["url-password", /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'`]+:)([^\s@/"'`]+)(?=@)/gi],
  ["aws-secret", /(aws_secret_access_key["']?\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})/gi],
  ["azure-key", /((?:AccountKey|SharedAccessKey)\s*=\s*)([A-Za-z0-9+/=]{20,})/gi],
  ["connection-password", /((?:^|[;"'])\s*(?:Password|Pwd)=)([^;'"\s]{2,})/gim],
  ["env-secret", /^(\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*["']?)([^\s"'#]{4,})/gm],
  ["assigned-secret", /(\b(?:password|passwd|secret|client_secret|api_?key|access_?token|auth_?token|refresh_?token)["']?\s*[:=]\s*["'])([^"'\s]{6,})(?=["'])/gi],
];
export const PLACEHOLDER_VALUE = /^(?:x+|\*+|\.+|changeme|change_me|password|secret|null|none|undefined|example[\w-]*|dummy[\w-]*|test\w{0,4}|your[\w-]*|<[^>]*>|\$\{[^}]*\}|\$[A-Z_]+|%[A-Z_]+%|\[REDACTED[^\]]*\]?)$/i;

/** The kinds of secret found in a text, each once, in the order first seen. Never the secrets. */
export function secretKinds(text) {
  const found = [];
  const add = (kind) => { if (!found.includes(kind)) found.push(kind); };
  if (typeof text !== "string" || text.length < 8) return found;
  for (const [kind, re] of SECRET_RULES) { re.lastIndex = 0; if (re.test(text)) add(kind); }
  if (PRIVATE_KEY_HEADER.test(text)) add("private-key");
  for (const [kind, re] of VALUE_RULES) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (!PLACEHOLDER_VALUE.test(m[2])) { add(kind); break; }
      if (m[0] === "") re.lastIndex++;
    }
  }
  return found;
}

// File names that hold secrets by convention; the same list the Write/Edit/Read checks use.
const TEMPLATE_NAME = /\.(?:example|sample|template|dist)(?:\.|$)/i;

/** What kind of secrets file a path is, or "" when it is not one. */
export function secretFileKind(p) {
  const parts = String(p).replace(/\\/g, "/").split("/").filter(Boolean);
  const name = (parts[parts.length - 1] || "").toLowerCase();
  if (!name || TEMPLATE_NAME.test(name)) return "";
  const dir = parts.slice(0, -1).map((x) => x.toLowerCase());
  const inDir = (d) => dir.includes(d);
  if (name === ".env" || name.startsWith(".env.") || (name.endsWith(".env") && name.length > 4)) return "env file";
  if (/^id_(?:rsa|ed25519|ecdsa|dsa)(?!.*\.pub$)/.test(name)) return "private key";
  if (/\.(?:pem|key|pfx|p12)$/.test(name)) return "private key or certificate";
  if (name === "credentials.json" || (name === "credentials" && inDir(".aws"))) return "credentials file";
  if (/^secrets\.[^/]+$/.test(name)) return "secrets file";
  if (name === ".npmrc" || name === ".pypirc" || name === ".netrc" || name === "_netrc" || name === ".git-credentials") return "credentials file";
  if (inDir(".ssh") && name !== "known_hosts" && !name.endsWith(".pub")) return "ssh file";
  if (inDir(".gnupg")) return "gpg file";
  if (name === "config.json" && inDir(".docker")) return "docker credentials";
  if (name === "config" && inDir(".kube")) return "kubernetes credentials";
  return "";
}
