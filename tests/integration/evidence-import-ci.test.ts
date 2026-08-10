import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildCiReadinessArtifact, runEvidenceImportCi, sha256Bytes } from "../../src/commands/evidence-collect.js";
import { makeTempRepo, writeJson, writeText } from "../helpers.js";

describe("evidence import-ci", () => {
  test("fails closed before Evidence writes when the readiness head is stale", () => {
    const root = makeTempRepo();
    execFileSync("git", ["remote", "add", "origin", "https://github.com/xmeta/ACED.git"], { cwd: root });
    writeText(root, "README.md", "subject\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "subject"], { cwd: root, stdio: "ignore" });
    const receiptBytes = Buffer.from("receipt\n", "utf8");
    const readiness = buildCiReadinessArtifact({
      repository: "xmeta/ACED",
      pullRequest: "42",
      taskId: "SCWBS-DRAFT-IMPORT",
      headCommit: "e".repeat(40),
      baseRef: "origin/main",
      baseCommit: "f".repeat(40),
      diffHash: `sha256:${"0".repeat(64)}`,
      authorityFingerprint: `sha256:${"1".repeat(64)}`,
      workflowPath: ".github/workflows/scwbs.yml",
      workflowRunId: "456",
      workflowRunUrl: "https://github.com/xmeta/ACED/actions/runs/456",
      artifactName: "scwbs-ci-receipt-456",
      artifactDigest: sha256Bytes(receiptBytes),
      validateStatus: "success",
      nextAction: { owner: "human", kind: "guidance", message: "Review." },
      mergeReadiness: { status: "not-ready", reasonCodes: ["pr.draft"] },
      generatedAt: "2026-08-11T00:00:00.000Z"
    });
    writeJson(root, "pr-readiness.json", readiness);
    writeText(root, "ci-receipt.json", receiptBytes.toString("utf8"));

    expect(runEvidenceImportCi(root, readiness.taskId, {
      readiness: "pr-readiness.json",
      ciReceipt: "ci-receipt.json"
    })).toBe(1);
    expect(existsSync(`${root}/contracts/evidence/${readiness.taskId}.yaml`)).toBe(false);
  });
});
