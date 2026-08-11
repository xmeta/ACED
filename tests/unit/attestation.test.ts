import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { toAttestationEvidence, verifyAttestation } from "../../src/core/attestation.js";
import { validateEvidenceSchema } from "../../src/core/schema/records.js";
import type { Evidence } from "../../src/core/types.js";
import { makeTempRepo, sampleEvidence, writeJson, writeText } from "../helpers.js";

const fixtureRoot = path.resolve("tests/fixtures/attestation");
const sourceCommit = "1111111111111111111111111111111111111111";

function withFakeGh<T>(root: string, fixture: string, status: number, action: () => T): T {
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const gh = path.join(bin, "gh");
  writeText(root, "bin/gh", `#!/bin/sh\nif [ -n "$GH_ARGS_FILE" ]; then printf '%s\\n' "$@" > "$GH_ARGS_FILE"; fi\ncat "$GH_FIXTURE"\nexit "${status}"\n`);
  chmodSync(gh, 0o755);
  const previousPath = process.env.PATH;
  const previousFixture = process.env.GH_FIXTURE;
  const previousArgs = process.env.GH_ARGS_FILE;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.GH_FIXTURE = fixture;
  delete process.env.GH_ARGS_FILE;
  try {
    return action();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousFixture === undefined) delete process.env.GH_FIXTURE;
    else process.env.GH_FIXTURE = previousFixture;
    if (previousArgs === undefined) delete process.env.GH_ARGS_FILE;
    else process.env.GH_ARGS_FILE = previousArgs;
  }
}

function prepare(root: string): { artifact: string; evidence: Evidence; digest: string } {
  const content = "release artifact\n";
  writeText(root, "release.tar.gz", content);
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const fixture = JSON.parse(readFileSync(path.join(fixtureRoot, "verified.json"), "utf8")) as Array<Record<string, unknown>>;
  const subject = fixture[0].subject as Array<{ digest: { sha256: string } }>;
  subject[0].digest.sha256 = digest.slice("sha256:".length);
  writeJson(root, "verified.json", fixture);
  const evidence = sampleEvidence({
    taskId: "WBS-001-004",
    subjectHeadCommit: sourceCommit,
    git: { branch: "refs/heads/main", subjectHeadCommit: sourceCommit }
  });
  return { artifact: "release.tar.gz", evidence, digest };
}

function context(root: string, artifact: string, evidence: Evidence) {
  return {
    root,
    taskId: evidence.taskId,
    artifact,
    evidence,
    repository: "xmeta/ACED",
    signerWorkflow: ".github/workflows/release.yml",
    sourceCommit,
    sourceRef: "refs/heads/main",
    now: "2026-08-12T00:00:00.000Z"
  };
}

describe("external attestation verifier", () => {
  test("returns a bounded verified result and matches the exact artifact digest", () => {
    const root = makeTempRepo();
    const prepared = prepare(root);
    const result = withFakeGh(root, path.join(root, "verified.json"), 0, () => verifyAttestation(root, context(root, prepared.artifact, prepared.evidence)));
    expect(result.status).toBe("verified");
    expect(result.artifact.digest).toBe(prepared.digest);
    expect(result.identity).toMatchObject({ repository: "xmeta/ACED", signerWorkflow: ".github/workflows/release.yml" });
    expect(JSON.stringify(result)).not.toContain("verificationResult");
    expect(JSON.stringify(result)).not.toContain("certificate");
    expect(validateEvidenceSchema({ ...prepared.evidence, attestationVerification: toAttestationEvidence(result) })).toEqual([]);
  });

  test.each([
    ["missing", "missing.stderr", 1],
    ["invalid", "invalid.stderr", 1]
  ] as const)("distinguishes %s verifier failures", (status, fixtureName, exitStatus) => {
    const root = makeTempRepo();
    const prepared = prepare(root);
    const result = withFakeGh(root, path.join(fixtureRoot, fixtureName), exitStatus, () => verifyAttestation(root, context(root, prepared.artifact, prepared.evidence)));
    expect(result.status).toBe(status);
    expect(result.reasonCodes.length).toBeGreaterThan(0);
  });

  test("fails closed for subject mismatch and unknown policy", () => {
    const root = makeTempRepo();
    const prepared = prepare(root);
    const mismatch = withFakeGh(root, path.join(fixtureRoot, "subject-mismatch.json"), 0, () => verifyAttestation(root, context(root, prepared.artifact, prepared.evidence)));
    expect(mismatch.status).toBe("subject-mismatch");
    const staleSubject = verifyAttestation(root, { ...context(root, prepared.artifact, prepared.evidence), sourceCommit: "2222222222222222222222222222222222222222" });
    expect(staleSubject.status).toBe("subject-mismatch");
    const unknownPolicy = verifyAttestation(root, {
      ...context(root, prepared.artifact, prepared.evidence),
      signerWorkflow: undefined,
      sourceRef: undefined,
      evidence: { ...prepared.evidence, git: undefined }
    });
    expect(unknownPolicy.status).toBe("untrusted");
    expect(unknownPolicy.reasonCodes).toEqual(expect.arrayContaining(["policy.signer-workflow.unknown", "policy.source-ref.unknown"]));
  });

  test("requires explicit offline bundle and trusted root and passes structured arguments", () => {
    const root = makeTempRepo();
    const prepared = prepare(root);
    const argsFile = path.join(root, "args.txt");
    const result = withFakeGh(root, path.join(root, "verified.json"), 0, () => {
      process.env.GH_ARGS_FILE = argsFile;
      return verifyAttestation(root, {
        ...context(root, prepared.artifact, prepared.evidence),
        bundle: "bundle.json",
        customTrustedRoot: "trusted-root.json"
      });
    });
    expect(result.status).toBe("verified");
    const args = readFileSync(argsFile, "utf8");
    expect(args).toContain("--bundle");
    expect(args).toContain("--custom-trusted-root");
    expect(verifyAttestation(root, { ...context(root, prepared.artifact, prepared.evidence), bundle: "bundle.json" }).status).toBe("untrusted");
  });
});
