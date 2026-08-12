import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  assertChangelogVersion,
  assertCliVersion,
  assertReleaseSubject,
  createReleaseManifest,
  findTrustedValidationRun
} from "../../scripts/release-integrity.mjs";

const workflow = readFileSync(path.join(process.cwd(), ".github/workflows/release.yml"), "utf8");
const subject = "a".repeat(40);
const otherSubject = "b".repeat(40);

function validationFixtures(overrides: Record<string, unknown> = {}) {
  const workflowRun = {
    id: 5060,
    path: ".github/workflows/scwbs.yml",
    head_sha: subject,
    status: "completed",
    conclusion: "success"
  };
  const checkRuns = ["core", "integration", "wjs", "distribution", "validate"].map((name) => ({
    id: name,
    name,
    status: "completed",
    conclusion: "success",
    app: { slug: "github-actions" },
    details_url: `https://github.com/xmeta/ACED/actions/runs/${workflowRun.id}/job/1`
  }));
  return {
    workflowRuns: [workflowRun],
    checkRuns,
    subjectCommit: subject,
    ...overrides
  };
}

describe("release integrity", () => {
  test("requires the package version tag and exact checked-out subject", () => {
    expect(() => assertReleaseSubject({
      releaseTag: "v0.1.0",
      packageVersion: "0.1.0",
      tagExists: true,
      tagCommit: subject,
      releaseCommit: subject,
      checkoutCommit: subject
    })).not.toThrow();

    expect(() => assertReleaseSubject({
      releaseTag: "v0.2.0",
      packageVersion: "0.1.0",
      tagExists: false,
      tagCommit: null,
      releaseCommit: subject,
      checkoutCommit: subject
    })).toThrow(/does not match package version/);

    expect(() => assertReleaseSubject({
      releaseTag: "v0.1.0",
      packageVersion: "0.1.0",
      tagExists: true,
      tagCommit: otherSubject,
      releaseCommit: subject,
      checkoutCommit: subject
    })).toThrow(/existing release tag/);

    expect(() => assertReleaseSubject({
      releaseTag: "v0.1.0",
      packageVersion: "0.1.0",
      tagExists: false,
      tagCommit: null,
      releaseCommit: subject,
      checkoutCommit: otherSubject
    })).toThrow(/exact release subject/);
  });

  test("accepts only successful aggregate validation for the exact workflow head", () => {
    expect(findTrustedValidationRun(validationFixtures())).toMatchObject({ workflowRunId: 5060 });
    expect(findTrustedValidationRun(validationFixtures({ subjectCommit: otherSubject }))).toBeNull();
    expect(findTrustedValidationRun(validationFixtures({
      workflowRuns: [{ ...validationFixtures().workflowRuns[0], head_sha: otherSubject }]
    }))).toBeNull();
    expect(findTrustedValidationRun(validationFixtures({
      checkRuns: validationFixtures().checkRuns.filter((check) => check.name !== "validate")
    }))).toBeNull();
  });

  test("rejects an Unreleased-only changelog and accepts a versioned section", () => {
    expect(() => assertChangelogVersion("## [Unreleased]\n", "0.1.0")).toThrow(/missing a versioned section/);
    expect(() => assertChangelogVersion("## [Unreleased]\n\n## [0.1.0] - 2026-08-10\n", "0.1.0")).not.toThrow();
  });

  test("requires the packaged CLI version to equal package.json", () => {
    expect(() => assertCliVersion("0.1.0", "0.1.0")).not.toThrow();
    expect(() => assertCliVersion("0.2.0", "0.1.0")).toThrow(/expected 0.1.0/);
  });

  test("creates a manifest with the tarball checksum and validation provenance", () => {
    const root = mkdtempSync(path.join(tmpdir(), "scwbs-release-integrity-"));
    const tarballPath = path.join(root, "scwbs-0.1.0.tgz");
    const tarball = Buffer.from("release subject");
    writeFileSync(tarballPath, tarball);
    const manifest = createReleaseManifest({
      packageVersion: "0.1.0",
      releaseTag: "v0.1.0",
      commit: subject,
      tarballPath,
      packMetadata: [{
        name: "scwbs",
        version: "0.1.0",
        filename: "scwbs-0.1.0.tgz",
        files: [
          { path: "dist/cli.js" },
          { path: "dist/wjs-runtime/tools/validate.mjs" },
          { path: "dist/wjs-runtime/tools/apply.mjs" },
          { path: "dist/wjs-runtime/schema/wbs-json.schema.json" },
          { path: "dist/wjs-runtime/schema/wbs-operations.schema.json" }
        ]
      }],
      validationWorkflowRunId: 5060,
      validationChecks: [{ name: "validate", conclusion: "success" }]
    });
    expect(manifest).toMatchObject({
      packageVersion: "0.1.0",
      tag: "v0.1.0",
      commit: subject,
      tarball: "scwbs-0.1.0.tgz",
      sha256: createHash("sha256").update(tarball).digest("hex"),
      validation: { workflowRunId: 5060 }
    });
  });

  test("keeps the workflow fail-closed and target-pinned", () => {
    expect(workflow).toContain("checks: read");
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain('cp scripts/release-integrity.mjs "$integrity_script"');
    expect(workflow).toContain('git checkout --detach "$tag_commit"');
    expect(workflow).toContain('import(process.env.RELEASE_INTEGRITY_SCRIPT)');
    expect(workflow).toContain("findTrustedValidationRun");
    expect(workflow).toContain("release-manifest.json");
    expect(workflow).toContain("scwbs-bootstrap.mjs");
    expect(workflow).toContain('tags:\n      - "v*.*.*"');
    expect(workflow).toContain("github.event_name == 'push' || github.ref == 'refs/heads/main'");
    expect(workflow).toContain('--target "$RELEASE_COMMIT"');
  });
});
