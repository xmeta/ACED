import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export const REQUIRED_RELEASE_CHECKS = Object.freeze(["core", "integration", "wjs", "distribution", "validate"]);

export const RELEASE_WORKFLOW_PATH = ".github/workflows/scwbs.yml";

export const REQUIRED_RELEASE_ASSETS = Object.freeze(["release-manifest.json", "scwbs-bootstrap.mjs"]);

const REQUIRED_PACKED_FILES = Object.freeze([
  "dist/cli.js",
  "dist/wjs-runtime/tools/validate.mjs",
  "dist/wjs-runtime/tools/apply.mjs",
  "dist/wjs-runtime/schema/wbs-json.schema.json",
  "dist/wjs-runtime/schema/wbs-operations.schema.json"
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function expectedReleaseTag(packageVersion) {
  if (typeof packageVersion !== "string" || packageVersion.length === 0 || packageVersion.includes("\n")) {
    throw new Error("package.json version must be a non-empty single-line string");
  }
  return `v${packageVersion}`;
}

export function assertReleaseSubject({
  releaseTag,
  packageVersion,
  tagExists,
  tagCommit,
  releaseCommit,
  checkoutCommit
}) {
  const expectedTag = expectedReleaseTag(packageVersion);
  if (releaseTag !== expectedTag) {
    throw new Error(
      `release tag ${releaseTag} does not match package version ${packageVersion}; expected ${expectedTag}`
    );
  }
  if (!releaseCommit || checkoutCommit !== releaseCommit) {
    throw new Error("release checkout is not the exact release subject commit");
  }
  if (tagExists && (!tagCommit || tagCommit !== releaseCommit)) {
    throw new Error("existing release tag does not resolve to the checked-out release subject");
  }
}

export function assertChangelogVersion(changelog, packageVersion) {
  const heading = new RegExp(`^## \\[${escapeRegExp(packageVersion)}\\](?:\\s|$)`, "m");
  if (!heading.test(changelog)) {
    throw new Error(`CHANGELOG.md is missing a versioned section for ${packageVersion}`);
  }
}

/**
 * Decide whether automated release publication is a new publication, an
 * idempotent verification, or a fail-closed duplicate/collision.
 *
 * The workflow-run path is intentionally idempotent because every successful
 * main validation can observe the already-published package version. Push and
 * manual-dispatch paths remain strict duplicate attempts.
 */
export function classifyAutomatedRelease({ eventName, releaseTag, releaseCommit, tagExists, tagCommit, release }) {
  if (!["push", "workflow_dispatch", "workflow_run"].includes(eventName)) {
    throw new Error(`unsupported release event ${eventName}`);
  }
  if (release && release.tag_name !== releaseTag) {
    throw new Error("existing GitHub Release tag does not match the requested release tag");
  }
  if (release && (release.draft === true || release.prerelease === true)) {
    throw new Error("existing GitHub Release is not a stable published release");
  }
  if (release) {
    const assets = new Set((release.assets ?? []).map((asset) => asset?.name));
    const requiredAssets = [...REQUIRED_RELEASE_ASSETS, `scwbs-${releaseTag.replace(/^v/, "")}.tgz`];
    for (const required of requiredAssets) {
      if (!assets.has(required)) throw new Error(`existing GitHub Release is missing ${required}`);
    }
    if (!tagExists) throw new Error("existing GitHub Release has no matching Git tag");
    if (eventName === "workflow_run") return { action: "skip", createTag: false };
    throw new Error("stable GitHub Release already exists; refusing duplicate publication");
  }
  if (tagExists && tagCommit !== releaseCommit) {
    throw new Error("existing release tag does not resolve to the exact release subject");
  }
  return { action: "publish", createTag: !tagExists };
}

export function assertCliVersion(actualVersion, packageVersion) {
  if (actualVersion !== packageVersion) {
    throw new Error(`scwbs --version returned ${actualVersion}; expected ${packageVersion}`);
  }
}

function runIdFromCheck(check) {
  if (Number.isInteger(check?.run_id)) return check.run_id;
  if (Number.isInteger(check?.workflow_run?.id)) return check.workflow_run.id;
  return Number(/\/actions\/runs\/(\d+)/.exec(check?.details_url ?? "")?.[1] ?? 0) || null;
}

export function findTrustedValidationRun({
  checkRuns,
  workflowRuns,
  subjectCommit,
  requiredChecks = REQUIRED_RELEASE_CHECKS,
  workflowPath = RELEASE_WORKFLOW_PATH
}) {
  const trustedRuns = workflowRuns
    .filter((run) => run?.head_sha === subjectCommit)
    .filter((run) => run?.path === workflowPath)
    .filter((run) => run?.status === "completed" && run?.conclusion === "success")
    .sort((left, right) => Number(right.id ?? 0) - Number(left.id ?? 0));

  for (const workflowRun of trustedRuns) {
    const byName = new Map(
      checkRuns
        .filter((check) => runIdFromCheck(check) === workflowRun.id)
        .filter((check) => check?.app?.slug === "github-actions")
        .filter((check) => check?.status === "completed" && check?.conclusion === "success")
        .map((check) => [check.name, check])
    );
    if (!requiredChecks.every((name) => byName.has(name))) continue;
    return {
      workflowRunId: workflowRun.id,
      checks: requiredChecks.map((name) => {
        const check = byName.get(name);
        return {
          id: check.id,
          name: check.name,
          conclusion: check.conclusion,
          detailsUrl: check.details_url ?? null
        };
      })
    };
  }
  return null;
}

export function createReleaseManifest({
  packageVersion,
  releaseTag,
  commit,
  tarballPath,
  packMetadata,
  validationWorkflowRunId,
  validationChecks
}) {
  const tarball = path.basename(tarballPath);
  const expectedTarball = `scwbs-${packageVersion}.tgz`;
  if (releaseTag !== expectedReleaseTag(packageVersion)) {
    throw new Error(`manifest tag ${releaseTag} does not match package version ${packageVersion}`);
  }
  if (tarball !== expectedTarball) {
    throw new Error(`tarball ${tarball} does not match expected filename ${expectedTarball}`);
  }
  const packageEntry = Array.isArray(packMetadata) ? packMetadata[0] : packMetadata;
  if (!packageEntry || packageEntry.name !== "scwbs" || packageEntry.version !== packageVersion) {
    throw new Error("npm pack metadata does not match the release package version");
  }
  if (!Number.isInteger(validationWorkflowRunId) || validationWorkflowRunId <= 0) {
    throw new Error("release manifest is missing a trusted validation workflow run id");
  }
  const packedFiles = new Set((packageEntry.files ?? []).map((file) => file.path));
  for (const required of REQUIRED_PACKED_FILES) {
    if (!packedFiles.has(required)) throw new Error(`release artifact is missing ${required}`);
  }
  const sha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
  return {
    schemaVersion: "1.0.0",
    packageVersion,
    tag: releaseTag,
    commit,
    tarball,
    sha256,
    validation: {
      workflow: RELEASE_WORKFLOW_PATH,
      workflowRunId: validationWorkflowRunId,
      checks: validationChecks
    }
  };
}
