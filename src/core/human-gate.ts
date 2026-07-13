import { matchesAny } from "./glob.js";
import type { ApprovalRecord, Evidence, Issue, TaskContract } from "./types.js";

export type HumanGateValidation = {
  required: boolean;
  requiredFiles: string[];
  approved: boolean;
  issues: Issue[];
};

function evidenceHead(evidence: Evidence): string | undefined {
  return evidence.subjectHeadCommit ?? evidence.git?.subjectHeadCommit ?? evidence.git?.headCommit ?? evidence.commit;
}

function evidenceDiffHash(evidence: Evidence): string | undefined {
  return evidence.diffHash ?? evidence.git?.diffHash;
}

export function validateHumanGateApproval(
  task: TaskContract,
  evidence: Evidence | undefined,
  approval: ApprovalRecord | undefined,
  changedFiles: string[] = evidence?.changedFiles ?? []
): HumanGateValidation {
  const requiredFiles = changedFiles.filter((file) => matchesAny(file, task.humanGateRequiredPaths));
  if (requiredFiles.length === 0) {
    return { required: false, requiredFiles, approved: true, issues: [] };
  }

  const approvalCommand = `npm run scwbs -- approval approve --task ${task.id} --reason "Evidence and diff reviewed"`;
  if (!approval) {
    return {
      required: true,
      requiredFiles,
      approved: false,
      issues: [{
        severity: "error",
        code: "approval.missing",
        message: `${task.id} changes Human Gate files but no approval record was found: ${requiredFiles.join(", ")}`,
        fixCommand: `npm run scwbs -- approval request --task ${task.id}`
      }]
    };
  }

  if (approval.status !== "approved") {
    return {
      required: true,
      requiredFiles,
      approved: false,
      issues: [{
        severity: "error",
        code: "approval.status",
        message: `${task.id} changes Human Gate files but approval status is ${approval.status}`,
        fixCommand: approvalCommand
      }]
    };
  }

  const issues: Issue[] = [];
  const subjectHead = evidence ? evidenceHead(evidence) : undefined;
  const subjectDiffHash = evidence ? evidenceDiffHash(evidence) : undefined;
  const legacyUnscoped = evidence?.git?.changedFilesBasis === "legacy-recorded" || !subjectHead || !subjectDiffHash;
  if ((!approval.headCommit || !subjectHead) && !legacyUnscoped) {
    issues.push({
      severity: "error",
      code: "approval.scope.headCommit",
      message: `${task.id} approval and Evidence must record matching headCommit scope`,
      fixCommand: approvalCommand
    });
  } else if (approval.headCommit && subjectHead && approval.headCommit !== subjectHead) {
    issues.push({
      severity: "error",
      code: "approval.scope.headCommit",
      message: `${task.id} approved headCommit does not match Evidence subjectHeadCommit`,
      fixCommand: approvalCommand
    });
  }
  if ((!approval.diffHash || !subjectDiffHash) && !legacyUnscoped) {
    issues.push({
      severity: "error",
      code: "approval.scope.diffHash",
      message: `${task.id} approval and Evidence must record matching diffHash scope`,
      fixCommand: approvalCommand
    });
  } else if (approval.diffHash && subjectDiffHash && approval.diffHash !== subjectDiffHash) {
    issues.push({
      severity: "error",
      code: "approval.scope.diffHash",
      message: `${task.id} approved diffHash does not match Evidence diffHash`,
      fixCommand: approvalCommand
    });
  }

  return {
    required: true,
    requiredFiles,
    approved: issues.length === 0,
    issues
  };
}
