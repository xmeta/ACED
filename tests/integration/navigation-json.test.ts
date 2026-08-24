import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { main } from "../../src/cli.js";
import { buildNextAction, buildNextJsonOutput } from "../../src/commands/next.js";
import { buildReviewQueueSummary, reviewQueueNextAction, type ReviewQueueEntry } from "../../src/commands/review-queue.js";
import { sampleEvidence, sampleTask, makeTempRepo, writeScwbsProject, writeYaml } from "../helpers.js";

function captureStdout(run: () => number): { code: number; output: string } {
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => {
    output += `${args.map(String).join(" ")}\n`;
  };
  try {
    return { code: run(), output };
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
  }
}

function validateSchema(file: string, value: unknown): void {
  const schema = JSON.parse(readFileSync(path.join(process.cwd(), file), "utf8"));
  const ajv = new Ajv2020({ strict: false });
  if (file.endsWith("ui.schema.json")) {
    ajv.addSchema(JSON.parse(readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/next.schema.json"), "utf8")));
  }
  const valid = ajv.compile(schema)(value);
  expect(valid, JSON.stringify(value)).toBe(true);
}

describe("versioned navigation JSON", () => {
  test("next --json returns a machine-readable action and reason code", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    const result = captureStdout(() => main(["next", "--json"], root));
    expect(result.code).toBe(0);
    const output = JSON.parse(result.output);
    expect(output).toMatchObject({
      version: "scwbs.next.v1",
      status: "actionable",
      action: { kind: "collect-evidence", owner: "ai", taskId: "WBS-001-004" },
      reasons: [{ code: "evidence.remediation.required" }]
    });
    validateSchema("docs/scwbs/schemas/next.schema.json", output);
  });

  test("next --json makes Human Gate ownership and AI stop explicit", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    const task = sampleTask({ humanGateRequiredPaths: ["src/security/**"] });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", task as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      changedFiles: ["src/security/policy.ts"],
      diffHash: "diff1234",
      git: { ...sampleEvidence().git, pullRequest: "#42" }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      pullRequest: "#42",
      headCommit: "abc1234",
      diffHash: "diff1234",
      reviewProfile: "independent-ai-review",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });

    const output = buildNextJsonOutput(root);
    expect(output).toMatchObject({
      version: "scwbs.next.v1",
      status: "waiting",
      action: { owner: "human", kind: "human-review", taskId: "WBS-001-004", command: "scwbs review approve --task WBS-001-004 --actor human", aiStop: true },
      reasons: [{ code: "review.human_decision_required" }]
    });
  });

  test("next text and JSON share the structured Review refresh action", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: { ...sampleEvidence().git, pullRequest: "#42", headCommit: "current-head" },
      diffHash: "current-diff"
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      headCommit: "stale-head",
      diffHash: "current-diff",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });

    const summary = buildReviewQueueSummary(root);
    const candidate = summary.candidates.find((item) => item.taskId === "WBS-001-004");
    expect(candidate?.actionStage).toBe("review-refresh");
    expect(buildNextJsonOutput(root).action?.command).toBe("scwbs review request --task WBS-001-004 --force");
    expect(buildNextAction(root)).toContain("scwbs review request --task WBS-001-004 --force");
  });

  test("incomplete Evidence subject routes force collection before Review refresh", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      diffHash: undefined,
      git: { branch: "task/WBS-001-004-api-implementation", base: "main", pullRequest: "#42", headCommit: undefined }
    }) as unknown as Record<string, unknown>);

    const next = buildNextAction(root);
    expect(next).toContain("scwbs evidence collect --task WBS-001-004 --force");
    expect(next).not.toContain("scwbs review request");
  });

  test("queue actions use executable force commands for existing remediation artifacts", () => {
    const entry = (actionStage: ReviewQueueEntry["actionStage"], blockers: ReviewQueueEntry["blockers"], reasons: string[] = []): ReviewQueueEntry => ({
      taskId: "WBS-001-007", nodeCode: "1.1", nodeName: "API", reasons, warnings: [], completionBlockedBy: [],
      suggestedAction: "remediate", actionStage, completionReady: false, blockers, omittedBlockerCount: 0
    });
    const evidenceBlocker = { code: "evidence.subject-head-missing", rootTaskId: "WBS-001-006", taskId: "WBS-001-007", phase: "evidence", message: "Evidence does not record a subjectHeadCommit" } as const;
    expect(reviewQueueNextAction(entry("evidence-remediation", [evidenceBlocker], ["evidence exists"])).command)
      .toBe("scwbs evidence collect --task WBS-001-007 --force");

    const staleApproval = { code: "approval.head-mismatch", rootTaskId: "WBS-001-006", taskId: "WBS-001-007", phase: "approval", scope: "post-finish", message: "post-finish Approval headCommit does not match Evidence" } as const;
    expect(reviewQueueNextAction(entry("scoped-approval", [staleApproval])).command)
      .toBe("scwbs request-approval --task WBS-001-007 --scope post-finish --force");
    const missingApproval = { code: "approval.post-finish-missing", rootTaskId: "WBS-001-006", taskId: "WBS-001-007", phase: "approval", scope: "post-finish", message: "post-finish Approval unavailable (approval.missing)" } as const;
    expect(reviewQueueNextAction(entry("scoped-approval", [missingApproval])).command)
      .toBe("scwbs request-approval --task WBS-001-007 --scope post-finish");
  });

  test("ui --json aggregates versioned status, next, review, and doctor sections", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    const result = captureStdout(() => main(["ui", "--json"], root));
    expect(result.code).toBe(0);
    const output = JSON.parse(result.output);
    expect(output).toMatchObject({
      version: "scwbs.ui.v1",
      statusReport: { version: "scwbs.status.v1" },
      next: { version: "scwbs.next.v1" },
      review: { schemaVersion: "1.0.0" },
      doctor: { status: expect.any(String) }
    });
    validateSchema("docs/scwbs/schemas/ui.schema.json", output);
  });

  test("trace --json returns stable graph nodes and edges", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    const result = captureStdout(() => main(["trace", "--task", "WBS-001-004", "--json"], root));
    expect(result.code).toBe(0);
    const output = JSON.parse(result.output);
    expect(output).toMatchObject({ version: "scwbs.trace.v1", taskId: "WBS-001-004" });
    expect(output.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "spec" }),
      expect.objectContaining({ kind: "wbs" }),
      expect.objectContaining({ kind: "task" })
    ]));
    expect(output.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "specifies" }),
      expect.objectContaining({ kind: "assigns" })
    ]));
    validateSchema("docs/scwbs/schemas/trace.schema.json", output);
  });
});
