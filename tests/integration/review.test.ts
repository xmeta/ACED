import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { buildReviewQueue, runReviewQueue } from "../../src/commands/review-queue.js";
import { buildNextAction } from "../../src/commands/next.js";
import { buildReviewRequestYaml, buildReviewRouteReport, runReviewApprove, runReviewChangesRequested, runReviewClose, runReviewRequest } from "../../src/commands/review-request.js";
import { buildTrace } from "../../src/commands/trace.js";
import { runAiBlock, runHumanBlockResolve } from "../../src/commands/ai-queue.js";
import {
  makeTempRepo,
  sampleTask,
  sampleWbs,
  sampleEvidence,
  sampleApproval,
  writeScwbsProject,
  writeJson,
  writeYaml
} from "../helpers.js";

function captureReviewQueue(root: string, options: { verbose?: boolean; json?: boolean; limit?: number } = {}): { result: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWrite = process.stdout.write;
  console.log = (...args: unknown[]) => stdout.push(`${args.map(String).join(" ")}\n`);
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { result: runReviewQueue(root, options), stdout: stdout.join(""), stderr: stderr.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalWrite;
  }
}

function prepareLargeReviewQueue(count = 120): string {
  const root = makeTempRepo();
  writeScwbsProject(root, "ready");
  for (let index = 0; index < count; index += 1) {
    const taskId = `WBS-QUEUE-${String(index).padStart(3, "0")}`;
    writeYaml(root, `contracts/tasks/${taskId}.yaml`, sampleTask({
      id: taskId,
      branchName: `task/${taskId.toLowerCase()}`,
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeYaml(root, `contracts/evidence/${taskId}.yaml`, sampleEvidence({
      id: `EVD-${taskId}`,
      taskId,
      git: { branch: `task/${taskId.toLowerCase()}`, base: "main", headCommit: `head-${index}` }
    }) as unknown as Record<string, unknown>);
  }
  return root;
}

describe("review queue + review request", () => {
  test("review queue default output stays bounded for more than 100 candidates", () => {
    const root = prepareLargeReviewQueue();
    const output = captureReviewQueue(root, { limit: 5 });

    expect(output).toMatchObject({ result: 0, stderr: "" });
    expect(output.stdout).toContain("120 review candidates");
    expect(output.stdout).toContain("115 additional candidates omitted");
    expect(output.stdout).toContain("scwbs review-queue --verbose");
    expect(output.stdout.split("\n").length).toBeLessThanOrEqual(80);
    expect(Buffer.byteLength(output.stdout, "utf8")).toBeLessThanOrEqual(8192);
  }, 30000);

  test("review queue supports verbose and versioned JSON output", () => {
    const root = prepareLargeReviewQueue(12);
    const bounded = captureReviewQueue(root, { limit: 3 });
    const verbose = captureReviewQueue(root, { verbose: true });
    expect(verbose.result).toBe(0);
    expect(verbose.stdout).toContain("WBS-QUEUE-011");
    expect(verbose.stdout.length).toBeGreaterThan(bounded.stdout.length);

    const jsonOutput = captureReviewQueue(root, { json: true, limit: 3 });
    const json = JSON.parse(jsonOutput.stdout);
    expect(json).toMatchObject({
      schemaVersion: "1.0.0",
      health: { candidates: 12, missingPullRequest: 12, blocked: 12, ready: 0 },
      omitted: 9,
      limit: 3
    });
    expect(json.candidates).toHaveLength(3);
    const schema = JSON.parse(readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/review-queue-summary.schema.json"), "utf8"));
    expect(new Ajv2020({ strict: false }).compile(schema)(json)).toBe(true);
  });

  test("review queue rejects conflicting modes and invalid limits", () => {
    const root = prepareLargeReviewQueue(1);
    expect(captureReviewQueue(root, { json: true, verbose: true })).toMatchObject({
      result: 2,
      stderr: "Choose one of --json or --verbose"
    });
    expect(captureReviewQueue(root, { limit: 0 })).toMatchObject({
      result: 2,
      stderr: "--limit must be a positive integer"
    });
  });

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

  test("review queue shows submodule merge order and blocks unreachable heads", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      submodules: [{
        path: "vendor/dependency",
        repository: "example/dependency",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        changedFiles: ["version.txt"],
        pullRequest: "#4",
        upstreamRef: "refs/remotes/origin/main",
        upstreamReachable: false,
        checks: [{ name: "upstream-ci", status: "passed" }]
      }]
    }) as unknown as Record<string, unknown>);
    const queue = buildReviewQueue(root);
    expect(queue).toContain("merge dependent PR #4 before parent PR");
    expect(queue).toContain("completionBlockedBy: submodule vendor/dependency head is not upstream-reachable");
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

  test("review queue blocks on active Blocks and ignores resolved Blocks", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);

    expect(runAiBlock(root, "WBS-001-004", "Human Gate required")).toBe(0);
    expect(buildReviewQueue(root)).toContain("completionBlockedBy: active Block: Human Gate required");
    expect(runHumanBlockResolve(root, "WBS-001-004", "Decision recorded")).toBe(0);
    expect(buildReviewQueue(root)).not.toContain("completionBlockedBy: active Block");
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

  test("review approve transitions a requested review to approved", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: { branch: "task/WBS-001-004-api-implementation", base: "main", headCommit: "abc1234", pullRequest: "#42" }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });
    expect(runReviewApprove(root, "WBS-001-004", { reviewedBy: "human", findings: "looks good", force: false })).toBe(0);
    const review = readFileSync(path.join(root, "contracts/reviews/WBS-001-004.yaml"), "utf8");
    expect(review).toContain("status: approved");
    expect(review).toContain("reviewedBy: human");
    expect(review).toContain("reviewedAt:");
    expect(review).toContain("findings:");
  });

  test("review changes-requested transitions a requested review to changes-requested", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: { branch: "task/WBS-001-004-api-implementation", base: "main", headCommit: "abc1234", pullRequest: "#42" }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });
    expect(runReviewChangesRequested(root, "WBS-001-004", { reviewedBy: "human", findings: "fix typo", force: false })).toBe(0);
    const review = readFileSync(path.join(root, "contracts/reviews/WBS-001-004.yaml"), "utf8");
    expect(review).toContain("status: changes-requested");
    expect(review).toContain("reviewedBy: human");
    expect(review).toContain("reviewedAt:");
  });

  test("review close transitions a requested review to closed", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: { branch: "task/WBS-001-004-api-implementation", base: "main", headCommit: "abc1234", pullRequest: "#42" }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });
    expect(runReviewClose(root, "WBS-001-004", { reviewedBy: "human", force: false })).toBe(0);
    const review = readFileSync(path.join(root, "contracts/reviews/WBS-001-004.yaml"), "utf8");
    expect(review).toContain("status: closed");
    expect(review).toContain("reviewedBy: human");
    expect(review).toContain("reviewedAt:");
  });

  test("review approve rejects AI actors and missing actors", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: { branch: "task/WBS-001-004-api-implementation", base: "main", headCommit: "abc1234", pullRequest: "#42" }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });

    expect(runReviewApprove(root, "WBS-001-004", { reviewedBy: "ai", force: false })).toBe(1);

    const savedMode = process.env.SCWBS_AGENT_MODE;
    delete process.env.SCWBS_AGENT_MODE;
    try {
      expect(runReviewApprove(root, "WBS-001-004", { force: false })).toBe(1);
    } finally {
      if (savedMode === undefined) {
        delete process.env.SCWBS_AGENT_MODE;
      } else {
        process.env.SCWBS_AGENT_MODE = savedMode;
      }
    }
  });

  test("review changes-requested rejects AI actors and missing actors", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: { branch: "task/WBS-001-004-api-implementation", base: "main", headCommit: "abc1234", pullRequest: "#42" }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });

    expect(runReviewChangesRequested(root, "WBS-001-004", { reviewedBy: "ai", force: false })).toBe(1);

    const savedMode = process.env.SCWBS_AGENT_MODE;
    delete process.env.SCWBS_AGENT_MODE;
    try {
      expect(runReviewChangesRequested(root, "WBS-001-004", { force: false })).toBe(1);
    } finally {
      if (savedMode === undefined) {
        delete process.env.SCWBS_AGENT_MODE;
      } else {
        process.env.SCWBS_AGENT_MODE = savedMode;
      }
    }
  });

  test("review close rejects AI actors and missing actors", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: { branch: "task/WBS-001-004-api-implementation", base: "main", headCommit: "abc1234", pullRequest: "#42" }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });

    expect(runReviewClose(root, "WBS-001-004", { reviewedBy: "ai", force: false })).toBe(1);

    const savedMode = process.env.SCWBS_AGENT_MODE;
    delete process.env.SCWBS_AGENT_MODE;
    try {
      expect(runReviewClose(root, "WBS-001-004", { force: false })).toBe(1);
    } finally {
      if (savedMode === undefined) {
        delete process.env.SCWBS_AGENT_MODE;
      } else {
        process.env.SCWBS_AGENT_MODE = savedMode;
      }
    }
  });

  test("terminal-state reviews are excluded from the active review queue", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: { branch: "task/WBS-001-004-api-implementation", base: "main", headCommit: "abc1234", pullRequest: "#42" }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "approved",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });
    const queue = buildReviewQueue(root);
    expect(queue).not.toContain("WBS-001-004");
    expect(queue).toBe("Review Queue:\n- None\n");
  });

  test("next suggests review approve for ready reviews in requested status", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: { branch: "task/WBS-001-004-api-implementation", base: "main", headCommit: "abc1234", pullRequest: "#42" }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });
    const next = buildNextAction(root);
    expect(next).toContain("scwbs review approve --task WBS-001-004 --actor human");
  });

  test("next does not suggest review approve for terminal-state reviews", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: { branch: "task/WBS-001-004-api-implementation", base: "main", headCommit: "abc1234", pullRequest: "#42" }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "approved",
      reviewProfile: "independent-ai-review",
      reviewedBy: "human",
      reviewedAt: "2026-01-01T00:00:00Z",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });
    const next = buildNextAction(root);
    expect(next).not.toContain("scwbs review approve");
  });

  test("next falls through to planned tasks when blocked reviews exist", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({
      id: "WBS-001-005",
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: { branch: "task/WBS-001-004-api-implementation", base: "main", headCommit: "abc1234", pullRequest: "#42" }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });
    const next = buildNextAction(root);
    expect(next).not.toContain("scwbs review-queue");
    expect(next).toContain("Planned task candidates:");
    expect(next).toContain("WBS-001-005");
  });

  test("force overwrite allows transitioning from a terminal review state", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: { branch: "task/WBS-001-004-api-implementation", base: "main", headCommit: "abc1234", pullRequest: "#42" }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "approved",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });
    expect(runReviewClose(root, "WBS-001-004", { reviewedBy: "human", force: false })).toBe(1);
    expect(runReviewClose(root, "WBS-001-004", { reviewedBy: "human", force: true })).toBe(0);
    const review = readFileSync(path.join(root, "contracts/reviews/WBS-001-004.yaml"), "utf8");
    expect(review).toContain("status: closed");
  });

  test("review changes-requested rejects approved review without force", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: { branch: "task/WBS-001-004-api-implementation", base: "main", headCommit: "abc1234", pullRequest: "#42" }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "approved",
      reviewProfile: "independent-ai-review",
      reviewedBy: "human",
      reviewedAt: "2026-01-01T00:00:00Z",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });
    expect(runReviewChangesRequested(root, "WBS-001-004", { reviewedBy: "human", force: false })).toBe(1);
    expect(runReviewChangesRequested(root, "WBS-001-004", { reviewedBy: "human", force: true })).toBe(0);
    const review = readFileSync(path.join(root, "contracts/reviews/WBS-001-004.yaml"), "utf8");
    expect(review).toContain("status: changes-requested");
  });

  test("approve on non-existent review fails", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    expect(runReviewApprove(root, "WBS-001-004", { reviewedBy: "human", force: false })).toBe(1);
  });

  test("approve on already-closed review fails without force", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "closed",
      reviewProfile: "independent-ai-review",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml"]
    });
    expect(runReviewApprove(root, "WBS-001-004", { reviewedBy: "human", force: false })).toBe(1);
    expect(runReviewApprove(root, "WBS-001-004", { reviewedBy: "human", force: true })).toBe(0);
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
