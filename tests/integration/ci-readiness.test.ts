import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { buildCiReadinessArtifact, sha256Bytes, verifyCiReadinessArtifact } from "../../src/commands/evidence-collect.js";
import { makeTempRepo, writeText } from "../helpers.js";

function commitSubject(root: string): string {
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "subject"], { cwd: root, stdio: "ignore" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function fixture() {
  const root = makeTempRepo();
  execFileSync("git", ["remote", "add", "origin", "https://github.com/xmeta/ACED.git"], { cwd: root });
  writeText(root, "src/subject.ts", "export const subject = true;\n");
  const headCommit = commitSubject(root);
  const ciReceiptBytes = Buffer.from("verified-ci-receipt\n", "utf8");
  const artifact = buildCiReadinessArtifact({
    repository: "xmeta/ACED",
    pullRequest: "42",
    taskId: "SCWBS-DRAFT-READINESS",
    headCommit,
    baseRef: "origin/main",
    baseCommit: "a".repeat(40),
    diffHash: `sha256:${"b".repeat(64)}`,
    authorityFingerprint: `sha256:${"c".repeat(64)}`,
    workflowPath: ".github/workflows/scwbs.yml",
    workflowRunId: "123",
    workflowRunUrl: "https://github.com/xmeta/ACED/actions/runs/123",
    artifactName: "scwbs-ci-receipt-123",
    artifactDigest: sha256Bytes(ciReceiptBytes),
    validateStatus: "success",
    nextAction: { owner: "human", kind: "guidance", message: "Review Evidence and merge readiness." },
    mergeReadiness: { status: "ready", reasonCodes: [] },
    generatedAt: "2026-08-11T00:00:00.000Z"
  });
  return { root, artifact, ciReceiptBytes, headCommit };
}

describe("PR readiness artifact provenance", () => {
  test("accepts a complete artifact bound to the current subject and receipt digest", () => {
    const { root, artifact, ciReceiptBytes, headCommit } = fixture();
    expect(verifyCiReadinessArtifact(root, artifact, {
      taskId: artifact.taskId,
      pullRequest: artifact.pullRequest,
      headCommit,
      workflowRunId: artifact.workflowRunId
    }, ciReceiptBytes)).toEqual(artifact);
  });

  test("rejects stale heads and tampered receipt bytes", () => {
    const { root, artifact, ciReceiptBytes } = fixture();
    expect(() => verifyCiReadinessArtifact(root, artifact, {
      taskId: artifact.taskId,
      pullRequest: artifact.pullRequest,
      headCommit: "d".repeat(40),
      workflowRunId: artifact.workflowRunId
    }, ciReceiptBytes)).toThrow(/headCommit/);
    expect(() => verifyCiReadinessArtifact(root, artifact, {
      taskId: artifact.taskId,
      pullRequest: artifact.pullRequest,
      headCommit: artifact.headCommit,
      workflowRunId: artifact.workflowRunId
    }, Buffer.from("tampered\n", "utf8"))).toThrow(/artifactDigest/);
  });
});
