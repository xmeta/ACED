export type MergeStatusCheck = {
  name?: string;
  status?: string;
  conclusion?: string;
  workflowName?: string;
  detailsUrl?: string;
};

export type MergePullRequestView = {
  number?: number;
  state?: string;
  isDraft?: boolean;
  baseRefName?: string;
  headRefOid?: string;
  mergeStateStatus?: string;
  statusCheckRollup?: MergeStatusCheck[];
};

export type MergePreflightViolation = {
  code: string;
  message: string;
};

export type MergePreflightReport = {
  schemaVersion: "1.0.0";
  status: "pass" | "blocked";
  repository: string | null;
  pullRequest: number;
  base: string | null;
  headCommit: string | null;
  mergeState: string | null;
  validate: {
    status: "success" | "missing" | "pending" | "failure";
    conclusion: string | null;
    workflow: string | null;
    url: string | null;
  };
  violations: MergePreflightViolation[];
  enforcement: {
    mode: "local-command";
    githubBranchProtection: "not-enforced";
    headBinding: "match-head-commit";
    adminBypass: false;
  };
  execution: {
    requested: boolean;
    executed: boolean;
    command: string | null;
  };
};

export type MergeReadinessSummary = {
  status: "ready" | "blocked";
  reasonCodes: string[];
  validate: MergePreflightReport["validate"];
};

export function summarizeMergeReadiness(report: MergePreflightReport): MergeReadinessSummary {
  return {
    status: report.status === "pass" ? "ready" : "blocked",
    reasonCodes: report.violations.map((violation) => violation.code),
    validate: report.validate
  };
}

const SHA = /^[a-f0-9]{40}$/;

export function unavailableMergeReport(
  pullRequest: number,
  message: string,
  repository: string | null = null
): MergePreflightReport {
  return {
    schemaVersion: "1.0.0",
    status: "blocked",
    repository,
    pullRequest,
    base: null,
    headCommit: null,
    mergeState: null,
    validate: { status: "missing", conclusion: null, workflow: null, url: null },
    violations: [{ code: "merge.github.unavailable", message }],
    enforcement: {
      mode: "local-command",
      githubBranchProtection: "not-enforced",
      headBinding: "match-head-commit",
      adminBypass: false
    },
    execution: { requested: false, executed: false, command: null }
  };
}

export function evaluateMergePreflight(
  pullRequest: number,
  view: MergePullRequestView,
  repository: string | null = null
): MergePreflightReport {
  const violations: MergePreflightViolation[] = [];
  if (view.number !== pullRequest) {
    violations.push({ code: "merge.pr.number", message: `Expected PR #${pullRequest}, received #${view.number ?? "unknown"}` });
  }
  if (view.state !== "OPEN") {
    violations.push({ code: "merge.pr.state", message: `PR #${pullRequest} must be OPEN, received ${view.state ?? "unknown"}` });
  }
  if (view.isDraft !== false) {
    violations.push({ code: "merge.pr.draft", message: `PR #${pullRequest} must not be a draft` });
  }
  if (view.baseRefName !== "main") {
    violations.push({ code: "merge.pr.base", message: `PR #${pullRequest} must target main, received ${view.baseRefName ?? "unknown"}` });
  }
  if (!view.headRefOid || !SHA.test(view.headRefOid)) {
    violations.push({ code: "merge.pr.head", message: `PR #${pullRequest} has no valid 40-character head commit` });
  }
  if (view.mergeStateStatus !== "CLEAN") {
    violations.push({
      code: "merge.pr.mergeable",
      message: `PR #${pullRequest} merge state must be CLEAN, received ${view.mergeStateStatus ?? "unknown"}`
    });
  }

  const validateChecks = (view.statusCheckRollup ?? []).filter((check) => check.name === "validate");
  if (validateChecks.length !== 1) {
    violations.push({
      code: "merge.validate.count",
      message: `PR #${pullRequest} requires exactly one aggregate validate check, received ${validateChecks.length}`
    });
  }
  const validate = validateChecks[0];
  let validateStatus: MergePreflightReport["validate"]["status"] = "missing";
  if (validate) {
    if (validate.workflowName !== "scwbs") {
      violations.push({
        code: "merge.validate.workflow",
        message: `validate must come from the scwbs workflow, received ${validate.workflowName ?? "unknown"}`
      });
    }
    if (repository && !validate.detailsUrl?.startsWith(`https://github.com/${repository}/actions/runs/`)) {
      violations.push({
        code: "merge.validate.repository",
        message: `validate details URL is not an Actions run for ${repository}`
      });
    }
    if (validate.status !== "COMPLETED") {
      validateStatus = "pending";
      violations.push({
        code: "merge.validate.pending",
        message: `aggregate validate is ${validate.status ?? "pending"}`
      });
    } else if (validate.conclusion !== "SUCCESS") {
      validateStatus = "failure";
      violations.push({
        code: "merge.validate.conclusion",
        message: `aggregate validate conclusion must be SUCCESS, received ${validate.conclusion ?? "unknown"}`
      });
    } else {
      validateStatus = "success";
    }
  }

  return {
    schemaVersion: "1.0.0",
    status: violations.length === 0 ? "pass" : "blocked",
    repository,
    pullRequest,
    base: view.baseRefName ?? null,
    headCommit: view.headRefOid ?? null,
    mergeState: view.mergeStateStatus ?? null,
    validate: {
      status: validateStatus,
      conclusion: validate?.conclusion ?? null,
      workflow: validate?.workflowName ?? null,
      url: validate?.detailsUrl ?? null
    },
    violations,
    enforcement: {
      mode: "local-command",
      githubBranchProtection: "not-enforced",
      headBinding: "match-head-commit",
      adminBypass: false
    },
    execution: { requested: false, executed: false, command: null }
  };
}
