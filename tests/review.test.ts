import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildReviewQueue } from "../src/commands/review-queue.js";
import { buildReviewRequestYaml, buildReviewRouteReport, runReviewRequest } from "../src/commands/review-request.js";
import { buildTrace } from "../src/commands/trace.js";
import { buildNextAction } from "../src/commands/next.js";
import {
  makeTempRepo,
  sampleTask,
  sampleWbs,
  sampleEvidence,
  sampleApproval,
  writeScwbsProject,
  writeJson,
  writeYaml
} from "./helpers.js";

describe("review queue + review request", () => {
  test("review request writes a review record and trace shows missing links", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(buildReviewRequestYaml("WBS-001-004", { pullRequest: "#42" })).toContain("type: review");
    expect(runReviewRequest(root, "WBS-001-004", { pullRequest: "#42", force: false })).toBe(0);
    const trace = buildTrace(root, "WBS-001-004");
    expect(trace).toContain("Review: RVW-WBS-001-004 requested");
    expect(trace).toContain("Evidence: missing");
  });

  test("review route and request include requested reviewers from evidence changes", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        subjectHeadCommit: "abc1234",
        diffHash: "diff1234",
        changedFiles: [
          "src/features/api/index.ts",
          "contracts/tasks/WBS-001-004.yaml"
        ]
      }) as unknown as Record<string, unknown>
    );
    const route = buildReviewRouteReport(root, "WBS-001-004");
    expect(route).toContain("code-owner");
    expect(route).toContain("methodology-owner");

    expect(runReviewRequest(root, "WBS-001-004", { pullRequest: "#42", force: false })).toBe(0);
    const review = readFileSync(path.join(root, "contracts/reviews/WBS-001-004.yaml"), "utf8");
    expect(review).toContain("requestedReviewers:");
    expect(review).toContain("role: code-owner");
    expect(review).toContain("role: methodology-owner");
    expect(review).toContain("headCommit: abc1234");
    expect(review).toContain("diffHash: diff1234");
  });

  test("review queue lists tasks with evidence awaiting review", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    const queue = buildReviewQueue(root);
    expect(queue).toContain("Review Queue:");
    expect(queue).toContain("WBS-001-004");
    expect(queue).toContain("branch: task/WBS-001-004-api-implementation");
    expect(queue).toContain("evidence exists and the WBS node is ready for human review");
    expect(queue).toContain("suggestedAction: create or record PR, then human review for completion");
  });

  test("review queue blocks completion review when the WBS node is not ready", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "main",
          headCommit: "abc1234",
          pullRequest: "#42"
        }
      }) as unknown as Record<string, unknown>
    );
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });

    const queue = buildReviewQueue(root);
    expect(queue).toContain("completionBlockedBy: WBS node status is planned; completion requires ready");
    expect(queue).toContain("- 0 candidates ready for completion review");
    expect(queue).toContain("Ready for completion review:\n- None");
    expect(buildNextAction(root)).not.toContain("Human review for WBS-001-004");
  });

  test("review queue reports incomplete dependencies that block completion", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs("ready");
    wbs.relations = [
      ...(wbs.relations ?? []),
      {
        id: "rel-api-depends-on-root",
        type: "dependsOn",
        source: "node-api",
        target: "node-root"
      }
    ];
    writeScwbsProject(root, "planned");
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    const queue = buildReviewQueue(root);
    expect(queue).toContain("evidence exists and the WBS node is not completed");
    expect(queue).toContain("- 1 candidates blocked by completion prerequisites");
    expect(queue).toContain("warning: dependsOn node 1 Root is not completed");
    expect(queue).toContain("completionBlockedBy: 1 Root");
    expect(queue).toContain("suggestedAction: review evidence now, but defer completion until dependencies are completed");
  });

  test("review queue defers completion for shared WBS nodes", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({
      id: "WBS-001-005",
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-005.yaml", sampleEvidence({
      id: "EVD-001-005",
      taskId: "WBS-001-005"
    }) as unknown as Record<string, unknown>);

    const queue = buildReviewQueue(root);
    expect(queue).toContain("- 2 candidates blocked by completion prerequisites");
    expect(queue).toContain("completionBlockedBy: node has multiple Task Contracts; completion requires a dedicated node-level completion task");
    expect(queue).toContain("suggestedAction: review evidence now, but defer WBS completion to a dedicated node-level completion task");
    expect(queue).toContain("Ready for completion review:\n- None");
  });

  test("review queue allows a dedicated node completion task to aggregate shared-node prerequisites", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({
      id: "WBS-001-005",
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/tasks/WBS-001-006.yaml", sampleTask({
      id: "WBS-001-006",
      wbsNodeId: "node-api",
      branchName: "codex/wbs-001-006-node-completion",
      completionScope: "node",
      completionTaskIds: ["WBS-001-004", "WBS-001-005"],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      id: "EVD-001-004",
      taskId: "WBS-001-004",
      git: {
        branch: "codex/wbs-001-004-api",
        base: "main",
        headCommit: "abc1234",
        pullRequest: "#41"
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-005.yaml", sampleEvidence({
      id: "EVD-001-005",
      taskId: "WBS-001-005",
      git: {
        branch: "codex/wbs-001-005-api",
        base: "main",
        headCommit: "abc1235",
        pullRequest: "#42"
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-006.yaml", sampleEvidence({
      id: "EVD-001-006",
      taskId: "WBS-001-006",
      git: {
        branch: "codex/wbs-001-006-node-completion",
        base: "main",
        headCommit: "abc1236",
        pullRequest: "#43"
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#41",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });
    writeYaml(root, "contracts/reviews/WBS-001-005.yaml", {
      id: "RVW-WBS-001-005",
      type: "review",
      taskId: "WBS-001-005",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-005.yaml", "contracts/evidence/WBS-001-005.yaml"]
    });
    writeYaml(root, "contracts/reviews/WBS-001-006.yaml", {
      id: "RVW-WBS-001-006",
      type: "review",
      taskId: "WBS-001-006",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#43",
      groundTruth: ["contracts/tasks/WBS-001-006.yaml", "contracts/evidence/WBS-001-006.yaml"]
    });

    const queue = buildReviewQueue(root);
    expect(queue).toContain("WBS-001-006 | 1.1 | API Implementation");
    expect(queue).toContain("completionTargets:");
    expect(queue).toContain("- WBS-001-006");
    expect(queue).toContain("Ready for completion review:");
    expect(queue).toContain("- WBS-001-006");
    expect(queue).toContain("- WBS-001-004 blocked by node has multiple Task Contracts; completion requires a dedicated node-level completion task");
    expect(queue).toContain("- WBS-001-005 blocked by node has multiple Task Contracts; completion requires a dedicated node-level completion task");
  });

  test("review queue shows pull request metadata when present", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "main",
          headCommit: "abc1234",
          pullRequest: "#42"
        }
      }) as unknown as Record<string, unknown>
    );
    const queue = buildReviewQueue(root);
    expect(queue).toContain("pullRequest: #42");
  });

  test("review queue shows approval status and approval pull request metadata", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "main",
          headCommit: "abc1234"
        }
      }) as unknown as Record<string, unknown>
    );
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval() as unknown as Record<string, unknown>);
    const queue = buildReviewQueue(root);
    expect(queue).toContain("pullRequest: #42");
    expect(queue).toContain("approvalStatus: requested");
    expect(queue).toContain("warning: human review approval has been requested but is not approved yet");
  });

  test("review queue asks for review request when PR metadata exists but review is missing", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "main",
          headCommit: "abc1234",
          pullRequest: "#42"
        }
      }) as unknown as Record<string, unknown>
    );

    const queue = buildReviewQueue(root);
    expect(queue).toContain("warning: no review request is recorded for this review candidate");
    expect(queue).toContain("suggestedAction: request review for this task");
  });

  test("review queue shows review status when review metadata exists", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "main",
          headCommit: "abc1234",
          pullRequest: "#42"
        }
      }) as unknown as Record<string, unknown>
    );
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });

    const queue = buildReviewQueue(root);
    expect(queue).toContain("reviewStatus: requested");
    expect(queue).toContain("suggestedAction: human review for completion");
    expect(queue).not.toContain("warning: no review request is recorded for this review candidate");
  });

  test("review queue warns when pull request metadata is missing", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "main",
          headCommit: "abc1234"
        }
      }) as unknown as Record<string, unknown>
    );
    const queue = buildReviewQueue(root);
    expect(queue).toContain("warning: no pull request is recorded for this review candidate");
  });

  test("review queue lists missing approval for human gate changes", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        changedFiles: ["src/security/policy.ts"]
      }) as unknown as Record<string, unknown>
    );
    const queue = buildReviewQueue(root);
    expect(queue).toContain("human gate paths were changed but no approval record exists");
  });

  test("review queue is empty when there is nothing pending", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    const queue = buildReviewQueue(root);
    expect(queue).toBe("Review Queue:\n- None\n");
  });

  test("review queue includes review health summary sections", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs("ready");
    wbs.relations = [
      ...(wbs.relations ?? []),
      {
        id: "rel-api-depends-on-root",
        type: "dependsOn",
        source: "node-api",
        target: "node-root"
      }
    ];
    writeScwbsProject(root, "planned");
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);

    const queue = buildReviewQueue(root);
    expect(queue).toContain("Review Health:");
    expect(queue).toContain("- 1 review candidates");
    expect(queue).toContain("- 1 candidates missing pull request metadata");
    expect(queue).toContain("- 1 candidates blocked by completion prerequisites");
    expect(queue).toContain("- 0 candidates ready for completion review");
    expect(queue).toContain("Ready for completion review:");
    expect(queue).toContain("Blocked review candidates:");
    expect(queue).toContain("- WBS-001-004 blocked by 1 Root");
    expect(queue).toContain("Missing PR metadata:");
    expect(queue).toContain("- WBS-001-004");
  });
});
