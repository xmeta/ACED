import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../../src/cli.js";
import { readEvidence } from "../../src/core/contracts.js";
import { makeTempRepo, sampleEvidence, sampleTask, writeJson, writeScwbsProject, writeText, writeYaml } from "../helpers.js";

function captureCli(args: string[], root: string): { code: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalWrite = process.stdout.write;
  const originalError = console.error;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  console.error = (...items: unknown[]) => stderr.push(items.map(String).join(" "));
  try {
    return { code: main(args, root), stdout: stdout.join(""), stderr: stderr.join("\n") };
  } finally {
    process.stdout.write = originalWrite;
    console.error = originalError;
  }
}

function prepareCliRepo(): { root: string; artifact: string; digest: string; subject: string } {
  const root = makeTempRepo();
  writeScwbsProject(root);
  writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: [] }) as unknown as Record<string, unknown>);
  const content = "integration release artifact\n";
  writeText(root, "release.tar.gz", content);
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const subject = "1111111111111111111111111111111111111111";
  writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
    subjectHeadCommit: subject,
    git: { branch: "refs/heads/main", subjectHeadCommit: subject }
  }) as unknown as Record<string, unknown>);
  writeJson(root, "verified.json", [{
    verificationResult: "PASSED",
    repository: "xmeta/ACED",
    workflow: "xmeta/ACED/.github/workflows/release.yml@refs/heads/main",
    predicateType: "https://slsa.dev/provenance/v1",
    sourceRepositoryDigest: subject,
    sourceRepositoryRef: "refs/heads/main",
    subject: [{ digest: { sha256: digest.slice("sha256:".length) } }]
  }]);
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeText(root, "bin/gh", "#!/bin/sh\ncat \"$GH_FIXTURE\"\nexit \"${GH_EXIT:-0}\"\n");
  chmodSync(path.join(bin, "gh"), 0o755);
  return { root, artifact: "release.tar.gz", digest, subject };
}

describe("evidence verify-attestation CLI", () => {
  test("records only the bounded verification summary in Evidence", () => {
    const prepared = prepareCliRepo();
    const previousPath = process.env.PATH;
    const previousFixture = process.env.GH_FIXTURE;
    const previousExit = process.env.GH_EXIT;
    process.env.PATH = `${path.join(prepared.root, "bin")}:${previousPath ?? ""}`;
    process.env.GH_FIXTURE = path.join(prepared.root, "verified.json");
    process.env.GH_EXIT = "0";
    try {
      const result = captureCli([
        "evidence", "verify-attestation", "--task", "WBS-001-004", "--artifact", prepared.artifact,
        "--repository", "xmeta/ACED", "--signer-workflow", ".github/workflows/release.yml",
        "--source-commit", prepared.subject, "--source-ref", "refs/heads/main", "--json"
      ], prepared.root);
      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout) as { status: string; artifact: { digest: string } };
      expect(output.status).toBe("verified");
      expect(output.artifact.digest).toBe(prepared.digest);
      const evidence = readEvidence(prepared.root, "WBS-001-004").evidence!;
      expect(evidence.attestationVerification?.status).toBe("verified");
      expect(JSON.stringify(evidence.attestationVerification)).not.toContain("verificationResult");
      expect(JSON.stringify(evidence.attestationVerification)).not.toContain("certificate");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousFixture === undefined) delete process.env.GH_FIXTURE;
      else process.env.GH_FIXTURE = previousFixture;
      if (previousExit === undefined) delete process.env.GH_EXIT;
      else process.env.GH_EXIT = previousExit;
    }
  });

  test("returns bounded JSON and nonzero for missing attestation", () => {
    const prepared = prepareCliRepo();
    const missing = path.join(prepared.root, "missing.stderr");
    writeText(prepared.root, "missing.stderr", "no attestation found\n");
    const previousPath = process.env.PATH;
    const previousFixture = process.env.GH_FIXTURE;
    const previousExit = process.env.GH_EXIT;
    process.env.PATH = `${path.join(prepared.root, "bin")}:${previousPath ?? ""}`;
    process.env.GH_FIXTURE = missing;
    process.env.GH_EXIT = "1";
    try {
      const result = captureCli([
        "evidence", "verify-attestation", "--task", "WBS-001-004", "--artifact", prepared.artifact,
        "--repository", "xmeta/ACED", "--signer-workflow", ".github/workflows/release.yml",
        "--source-commit", prepared.subject, "--source-ref", "refs/heads/main", "--json"
      ], prepared.root);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: "scwbs.attestation-verification.v1", status: "missing" });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousFixture === undefined) delete process.env.GH_FIXTURE;
      else process.env.GH_FIXTURE = previousFixture;
      if (previousExit === undefined) delete process.env.GH_EXIT;
      else process.env.GH_EXIT = previousExit;
    }
  });
});
