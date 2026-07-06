const commandRiskRules = [
  {
    code: "recursive_delete",
    severity: "high",
    reason: "recursive or forced deletion",
    pattern: /\b(?:rm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)|Remove-Item\b[\s\S]*(?:-Recurse|-Force)|(?:rd|rmdir)\b[\s\S]*\/s\b)/i
  },
  {
    code: "disk_or_system_mutation",
    severity: "high",
    reason: "system, disk, service, registry, or account mutation",
    pattern: /\b(?:format|diskpart|bcdedit|reg\s+delete|sc\s+delete|schtasks\b[\s\S]*\/create|net\s+user|New-LocalUser|Set-ExecutionPolicy)\b/i
  },
  {
    code: "git_history_rewrite",
    severity: "high",
    reason: "Git history or workspace destructive operation",
    pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*(?:f|d)|push\s+[^\n]*(?:--force|-f\b)|checkout\s+--\s+|restore\s+[^\n]*(?:--worktree|--staged))\b/i
  },
  {
    code: "download_execute",
    severity: "high",
    reason: "downloaded content is piped into a shell or interpreter",
    pattern: /\b(?:curl|wget|Invoke-WebRequest|iwr)\b[\s\S]*(?:\||;|&&)\s*(?:sh|bash|zsh|fish|powershell|pwsh|cmd|python|node)\b/i
  },
  {
    code: "privilege_escalation",
    severity: "medium",
    reason: "privilege escalation or broad permission change",
    pattern: /\b(?:sudo|runas|chmod\s+(?:-R\s+)?777|icacls\b[\s\S]*\/grant)\b/i
  },
  {
    code: "inline_interpreter",
    severity: "medium",
    reason: "inline shell or interpreter execution",
    pattern: /(?:^|[;&|]\s*)(?:python|python3|node|deno|ruby|perl|php|bash|sh|zsh|fish|powershell|pwsh|cmd)\b\s+(?:-e|-c|\/c|-Command)\b/i
  },
  {
    code: "network_install",
    severity: "medium",
    reason: "network package install or remote code acquisition",
    pattern: /\b(?:npm\s+install|npm\s+i|pnpm\s+(?:add|install)|yarn\s+(?:add|install)|bun\s+add|pip\s+install|uv\s+pip\s+install|cargo\s+install|go\s+install)\b/i
  }
];

const networkCommandRules = [
  {
    code: "http_client",
    severity: "medium",
    reason: "network command while network access is disabled",
    pattern: /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer)\b/i
  },
  {
    code: "package_network",
    severity: "medium",
    reason: "package manager may access the network while network access is disabled",
    pattern: /\b(?:npm\s+(?:install|i|ci|exec|dlx)|npx\b|pnpm\s+(?:add|install|i|dlx|exec)|yarn\s+(?:add|install|dlx|exec)|bun\s+(?:add|install|x)|pip\s+install|python(?:3)?\s+-m\s+pip\s+install|uv\s+(?:add|sync|pip\s+install)|cargo\s+(?:install|update)|go\s+(?:install|get)|dotnet\s+(?:restore|add\s+package)|composer\s+(?:install|update|require)|gem\s+install)\b/i
  },
  {
    code: "git_network",
    severity: "medium",
    reason: "Git remote operation may access the network while network access is disabled",
    pattern: /\bgit\s+(?:clone|fetch|pull|push|ls-remote|submodule\s+update)\b/i
  },
  {
    code: "remote_shell_or_copy",
    severity: "medium",
    reason: "remote shell or file transfer while network access is disabled",
    pattern: /\b(?:ssh|scp|sftp|rsync)\b/i
  },
  {
    code: "network_probe",
    severity: "low",
    reason: "network diagnostic command while network access is disabled",
    pattern: /\b(?:ping|Test-NetConnection|tnc|nslookup|dig|tracert|traceroute)\b/i
  },
  {
    code: "container_network",
    severity: "medium",
    reason: "container registry operation may access the network while network access is disabled",
    pattern: /\b(?:docker|podman)\s+(?:pull|push|build|compose\s+(?:pull|build|up))\b/i
  }
];

const writeCommandRules = [
  {
    code: "file_write",
    severity: "medium",
    reason: "workspace write command",
    pattern: /\b(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Remove-Item|mkdir|touch|cp|mv|rm|tee|sed\s+-i)\b/i
  },
  {
    code: "git_workspace_write",
    severity: "medium",
    reason: "Git command may modify workspace state",
    pattern: /\bgit\s+(?:add|commit|merge|rebase|checkout|switch|restore|reset|clean|stash|apply|cherry-pick|pull)\b/i
  },
  {
    code: "package_workspace_write",
    severity: "medium",
    reason: "package manager may modify workspace files",
    pattern: /\b(?:npm\s+(?:install|i|ci|update|dedupe)|pnpm\s+(?:add|install|i|update)|yarn\s+(?:add|install|upgrade)|bun\s+(?:add|install)|pip\s+install|uv\s+(?:add|sync|pip\s+install)|cargo\s+(?:add|update)|dotnet\s+(?:restore|add\s+package)|composer\s+(?:install|update|require)|gem\s+install)\b/i
  },
  {
    code: "shell_redirect_write",
    severity: "medium",
    reason: "shell redirection may write files",
    pattern: /(^|[^>])>\s*[^&\s]|>>\s*[^&\s]/i
  }
];

const privilegedCommandRules = [
  {
    code: "elevation",
    severity: "high",
    reason: "privileged command",
    pattern: /\b(?:sudo|runas|Start-Process\b[\s\S]*-Verb\s+RunAs|Set-ExecutionPolicy|icacls\b|takeown\b|chown\b|chmod\s+(?:-R\s+)?777)\b/i
  },
  {
    code: "service_or_registry",
    severity: "high",
    reason: "service, registry, account, or boot configuration change",
    pattern: /\b(?:sc\s+(?:create|delete|config|stop|start)|New-Service|Set-Service|reg\s+(?:add|delete|import)|net\s+user|New-LocalUser|bcdedit|schtasks\b[\s\S]*\/create)\b/i
  }
];

function normalizeCommand(command = "") {
  return String(command || "").replace(/`\r?\n/g, " ").replace(/\\\r?\n/g, " ").trim();
}

function matchingRules(command = "", rules = []) {
  const normalized = normalizeCommand(command);
  if (!normalized) return [];

  const matches = [];
  for (const rule of rules) {
    if (rule.pattern.test(normalized)) {
      matches.push({ code: rule.code, severity: rule.severity, reason: rule.reason });
    }
  }
  return matches;
}

export function analyzeCommandRisk(command = "") {
  const matches = matchingRules(command, commandRiskRules);

  return {
    risky: matches.length > 0,
    reasons: [...new Set(matches.map((match) => match.reason))],
    matches
  };
}

export function analyzeCommandNetworkUse(command = "") {
  const matches = matchingRules(command, networkCommandRules);
  return {
    usesNetwork: matches.length > 0,
    reasons: [...new Set(matches.map((match) => match.reason))],
    matches
  };
}

export function classifyCommandPermissions(command = "") {
  const destructive = analyzeCommandRisk(command);
  const network = analyzeCommandNetworkUse(command);
  const writes = matchingRules(command, writeCommandRules);
  const privileged = matchingRules(command, privilegedCommandRules);
  const domains = ["read-only"];
  if (writes.length) domains.push("workspace-write");
  if (network.usesNetwork) domains.push("network");
  if (destructive.risky) domains.push("destructive");
  if (privileged.length) domains.push("privileged");
  return {
    domains: [...new Set(domains)],
    writesWorkspace: writes.length > 0,
    usesNetwork: network.usesNetwork,
    destructive: destructive.risky,
    privileged: privileged.length > 0,
    matches: [
      ...writes,
      ...network.matches,
      ...destructive.matches,
      ...privileged
    ],
    reasons: [...new Set([
      ...writes.map((match) => match.reason),
      ...network.reasons,
      ...destructive.reasons,
      ...privileged.map((match) => match.reason)
    ])]
  };
}

export function evaluateCommandPolicy(command = "", policy = {}) {
  const permissions = classifyCommandPermissions(command);
  const reasons = [];
  const matches = [];
  const sandboxMode = policy.sandboxMode || "workspace-write";

  if (sandboxMode === "read-only" && permissions.writesWorkspace) {
    reasons.push("read-only sandbox blocks workspace writes");
    matches.push({ code: "read_only_workspace_write", severity: "high", reason: "read-only sandbox blocks workspace writes", policy: "sandboxMode=read-only" });
  }

  if (sandboxMode !== "danger-full-access" && permissions.privileged) {
    reasons.push("privileged command needs elevated sandbox");
    matches.push({ code: "privileged_command", severity: "high", reason: "privileged command needs elevated sandbox", policy: `sandboxMode=${sandboxMode}` });
  }

  if (sandboxMode === "workspace-write" && permissions.destructive) {
    reasons.push("destructive command needs explicit approval");
    matches.push({ code: "destructive_command", severity: "high", reason: "destructive command needs explicit approval", policy: "sandboxMode=workspace-write" });
  }

  if (policy.networkAccess === false && permissions.usesNetwork) {
    reasons.push("network command while network access is disabled");
    matches.push({ code: "network_disabled", severity: "medium", reason: "network command while network access is disabled", policy: "networkAccess=false" });
  }

  return {
    permissions,
    sandboxMode,
    approvalPolicy: policy.approvalPolicy || "",
    networkAccess: policy.networkAccess !== false,
    required: matches.length > 0,
    risky: matches.length > 0 || permissions.destructive || permissions.privileged,
    reasons: [...new Set(reasons)],
    matches
  };
}

export function commandApprovalRequired(command = "", policy = {}) {
  const risk = analyzeCommandRisk(command);
  const network = analyzeCommandNetworkUse(command);
  const policyRisk = evaluateCommandPolicy(command, policy);
  const networkBlocked = Boolean(policy.networkAccess === false && network.usesNetwork);
  const matches = [
    ...risk.matches,
    ...network.matches.map((match) => ({ ...match, policy: "networkAccess=false" })),
    ...policyRisk.matches
  ];
  const reasons = [
    ...risk.reasons,
    ...(networkBlocked ? network.reasons : []),
    ...policyRisk.reasons
  ];
  return {
    ...risk,
    network,
    policy: policyRisk,
    risky: Boolean(risk.risky || networkBlocked || policyRisk.risky),
    reasons: [...new Set(reasons)],
    matches,
    required: Boolean((policy.requireDangerousCommandApproval !== false && risk.risky) || networkBlocked || policyRisk.required)
  };
}
