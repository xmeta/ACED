import { describe, expect, test } from "vitest";
import {
  buildUpgradeDryRunOutput,
  buildVersionCheckOutput,
  installedPackageFromJson,
  validateReleaseManifest
} from "../../src/core/distribution.js";

const manifest = {
  schemaVersion: "1.0.0",
  packageVersion: "0.1.1",
  tag: "v0.1.1",
  commit: "0123456789abcdef0123456789abcdef01234567",
  tarball: "scwbs-0.1.1.tgz",
  sha256: "a".repeat(64),
  validation: { workflow: ".github/workflows/scwbs.yml", workflowRunId: 42, checks: [] }
};

describe("distribution lifecycle", () => {
  test("validates the release subject and digest shape", () => {
    expect(validateReleaseManifest(manifest)).toMatchObject({ status: "pass", packageVersion: "0.1.1", tag: "v0.1.1" });
    expect(validateReleaseManifest({ ...manifest, tag: "latest" }).reasons).toContainEqual(expect.objectContaining({ code: "release.subject.tag-mismatch" }));
  });

  test("reports current and upgrade-available states without mutating anything", () => {
    const installed = installedPackageFromJson({ version: "0.1.0" });
    expect(buildVersionCheckOutput(installed, { ...manifest, packageVersion: "0.1.0", tag: "v0.1.0", tarball: "scwbs-0.1.0.tgz" })).toMatchObject({
      status: "pass",
      support: "current"
    });
    const proposal = buildUpgradeDryRunOutput(
      { name: "consumer", devDependencies: { scwbs: "https://old.example/scwbs-0.1.0.tgz" } },
      installed,
      manifest
    );
    expect(proposal).toMatchObject({
      version: "scwbs.upgrade-dry-run.v1",
      status: "pass",
      dryRun: true,
      unattendedUpgrade: "disabled",
      proposed: { packageVersion: "0.1.1", releaseTag: "v0.1.1" },
      mutations: []
    });
  });
});
