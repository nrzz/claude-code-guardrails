// The rule catalog: every rule has an id, a decision per preset and a short reason.
//
// Reading the table: an unlisted preset behaves like balanced. "floor" rules are the ones that no
// pattern in guardrails.json can switch off (only the exact rule id can): deleting a root, wiping a
// disk, shutting the machine down, secrets.

export const PRESETS = ["strict", "balanced", "relaxed"];
export const DEFAULT_PRESET = "balanced";
export const DECISIONS = ["allow", "ask", "deny"]; // weakest first
export const rank = (decision) => DECISIONS.indexOf(decision);

const A = "allow";
const K = "ask";
const D = "deny";

// id, [strict, balanced, relaxed], group, reason (under 120 characters), floor
const TABLE = [
  ["rm-root", [D, D, D], "Always blocked", "recursive delete of a filesystem root, home folder, system folder or the whole project", true],
  ["disk-wipe", [D, D, D], "Always blocked", "formats, partitions or overwrites a disk or block device", true],
  ["shutdown", [D, D, D], "Always blocked", "shuts down or reboots the machine", true],
  ["chmod-root", [D, D, D], "Always blocked", "recursive chmod or chown on a filesystem root or system folder", true],
  ["fork-bomb", [D, D, D], "Always blocked", "fork bomb: a function that pipes into itself in the background", true],
  ["secret-file-write", [D, D, D], "Always blocked", "writes or deletes a secrets file (.env, private key, credentials, .npmrc ...)", true],
  ["commit-secret", [D, D, D], "Always blocked", "staged changes contain a secret or a secrets file", true],

  ["git-force-push-protected", [D, D, D], "git", "force push to, or deletion of, a protected branch"],
  ["git-force-push", [K, K, A], "git", "force push rewrites history on the remote"],
  ["git-push-protected", [K, A, A], "git", "direct push to a protected branch"],
  ["git-reset-hard", [K, K, A], "git", "git reset --hard throws away uncommitted work"],
  ["git-clean", [K, K, A], "git", "git clean -f deletes untracked files for good"],
  ["git-discard", [K, K, A], "git", "throws away all uncommitted changes in the working tree"],
  ["git-stash-drop", [K, K, A], "git", "drops stashed work for good (git stash drop or clear)"],
  ["git-branch-delete", [K, K, A], "git", "git branch -D deletes a branch even when it is not merged"],
  ["git-dir-write", [D, D, D], "git", "writes inside .git/ and can corrupt the repository"],

  ["rm-outside-project", [D, K, A], "Deleting", "recursive delete outside the project and the temp folder, or of a path that cannot be checked"],
  ["rm-git-dir", [D, K, K], "Deleting", "deletes a .git folder, which holds the whole repository history"],

  ["sql-destructive", [D, K, K], "Databases", "destructive SQL: DROP DATABASE, SCHEMA or TABLE, TRUNCATE, or DELETE without WHERE"],

  ["publish", [K, K, A], "Publishing", "publishes a package, release or image (npm, cargo, twine, gh release, docker push ...)"],

  ["terraform-destroy", [D, K, K], "Infrastructure", "destroys infrastructure (terraform, tofu, terragrunt, pulumi or cdk destroy)"],
  ["terraform-auto-approve", [D, K, K], "Infrastructure", "terraform apply -auto-approve changes infrastructure without a review"],
  ["kubectl-delete", [D, K, K], "Infrastructure", "deletes Kubernetes resources"],
  ["helm-uninstall", [D, K, K], "Infrastructure", "uninstalls a Helm release"],
  ["docker-prune", [D, K, K], "Infrastructure", "removes Docker volumes or every unused image (prune -a or --volumes, volume prune, compose down -v)"],
  ["aws-destroy", [D, K, K], "Infrastructure", "deletes AWS resources (s3 rm --recursive, s3 rb, terminate-instances, delete-stack, delete-db-instance ...)"],
  ["gcloud-delete", [D, K, K], "Infrastructure", "deletes Google Cloud resources"],
  ["az-delete", [D, K, K], "Infrastructure", "deletes Azure resources"],

  ["remote-script", [K, K, A], "Remote scripts", "runs a script downloaded from the network without reading it (curl | sh, iex)"],

  ["secret-file-read", [D, K, A], "Files", "reads a secrets file (.env, private key, credentials) into the conversation"],
  ["lockfile-edit", [D, K, A], "Files", "edits a lockfile by hand; let the package manager change it"],
  ["workflow-edit", [K, A, A], "Files", "edits a CI workflow in .github/workflows"],
  ["write-outside-project", [D, K, K], "Files", "writes outside the project and the temp folder"],

  ["guardrails-tamper", [D, K, K], "Self-protection", "changes the guardrails config or script, or Claude Code's settings"],
];

export const RULES = Object.fromEntries(TABLE.map(([id, [strict, balanced, relaxed], group, reason, floor]) => [
  id, { id, group, reason, floor: !!floor, decisions: { strict, balanced, relaxed } },
]));
export const RULE_IDS = Object.keys(RULES);

// Rules that come from the patterns in guardrails.json rather than from the catalog.
export const CUSTOM = {
  "custom-deny": { id: "custom-deny", group: "Your patterns", reason: "matches a deny pattern in guardrails.json", floor: false, decisions: { strict: D, balanced: D, relaxed: D } },
  "custom-ask": { id: "custom-ask", group: "Your patterns", reason: "matches an ask pattern in guardrails.json", floor: false, decisions: { strict: K, balanced: K, relaxed: K } },
};

export const ruleOf = (id) => RULES[id] || CUSTOM[id] || null;
export const isRuleId = (id) => Object.prototype.hasOwnProperty.call(RULES, id);

/** What a preset decides for a rule. */
export function decisionFor(id, preset) {
  const rule = ruleOf(id);
  if (!rule) return A;
  return rule.decisions[preset] || rule.decisions[DEFAULT_PRESET];
}

export const DEFAULT_PROTECTED_BRANCHES = ["main", "master", "release/*", "production"];
