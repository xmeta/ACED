import { describe, expect, test } from "vitest";
import {
  buildHumanApprovalCommand,
  finishLifecycleStepOrder,
  pullRequestNextAction
} from "../../src/commands/finish.js";
import { sampleEvidence } from "../helpers.js";

describe("finish lifecycle decisions", () => {
  test("keeps the lifecycle steps in their fixed-point order", () => {
    expect(finishLifecycleStepOrder()).toEqual([
      "preflight",
      "required-checks",
      "validation",
      "checkpoint",
      "readiness",
      "complete"
    ]);
  });

  test("maps pull request state to the next lifecycle action", () => {
    expect(pullRequestNextAction("TASK-A", undefined)).toEqual({
      label: "Open a pull request:",
      command: 'gh pr create --base main --title "feat: TASK-A" --body ""'
    });
    expect(pullRequestNextAction("TASK-A", 42, "draft")).toEqual({
      label: "Mark pull request #42 ready for review:",
      command: "gh pr ready 42"
    });
    expect(pullRequestNextAction("TASK-A", 42, "checks-success")).toEqual({
      label: "Merge pull request #42 through the validate preflight:",
      command: "npm run scwbs -- merge --pr 42"
    });
    expect(pullRequestNextAction("TASK-A", 42, "merged")).toEqual({
      label: "Synchronize main after merged pull request #42:",
      command: "git switch main && git pull --ff-only origin main"
    });
  });

  test("builds human approval commands without changing ownership", () => {
    const evidence = sampleEvidence({ subjectHeadCommit: "HEAD", diffHash: "sha256:DIFF" });
    expect(buildHumanApprovalCommand("TASK-A")).toBe(
      "npm run scwbs -- evidence collect --task TASK-A --force"
    );
    expect(buildHumanApprovalCommand("TASK-A", evidence)).toBe(
      'npm run scwbs -- approval approve --task TASK-A --actor human --reason "CONFIRM TTY APPROVAL TASK-A HEAD sha256:DIFF"'
    );
    expect(buildHumanApprovalCommand("TASK-A", evidence, "approved")).toContain("--force");
    expect(buildHumanApprovalCommand("TASK-A", evidence, "rejected")).toContain("--force");
  });
});
