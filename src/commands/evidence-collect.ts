import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { listEvidence, readEvidence, readTask } from "../core/contracts.js";
import { buildPatchArtifact, changedFilesBetweenRefs, commitExists, diffBinary, hashDiffBinary, isCommitAncestor, resolveCommit, workingTreeState } from "../core/git.js";
import { evidencePayloadPath, evidencePath, resolveFrom } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import type { CiReceipt, CoverageReceipt, Evidence } from "../core/types.js";
import { taskLifecycleMetadataPaths } from "../core/managed-contract-paths.js";
import { readTaskIndex } from "../core/task-index.js";
import { printIssues } from "../core/report.js";
import { evaluateWorkingTreeGuard } from "./check-diff.js";
import { syncRegistry } from "./registry-rebuild.js";
import { buildCollectedEvidence, buildCollectedEvidenceYaml, detectOpenPullRequest } from "../core/evidence/build.js";
import type { TestQualityOptions } from "../core/evidence/build.js";
import { CI_WORKFLOW_PATH, isRecord, originRepository, validRunUrl } from "../core/evidence/ci-receipt.js";
import { toAttestationEvidence, verifyAttestation } from "../core/attestation.js";

export { buildCollectedEvidence, buildCollectedEvidenceYaml, detectOpenPullRequest };
export type { EvidenceBuildOptions, TestQualityOptions } from "../core/evidence/build.js";

export type EvidenceCollectSummary = {
  schemaVersion: "1.0.0";
  status: "pass";
  taskId: string;
  path: string;
  checks: {
    total: number;
    passed: number;
    failed: number;
  };
  changedFiles: number;
  pullRequest: string | null;
  ciReceipt?: {
    verified: true;
    workflowRunId: string;
    jobCount: number;
  };
};

export type EvidenceCollectOptions = {
  force: boolean;
  baseRef?: string;
  pullRequest?: string;
  testQuality?: TestQualityOptions;
  rerunChecks?: boolean;
  json?: boolean;
  verbose?: boolean;
  output?: string;
  quiet?: boolean;
  ciReceipt?: string;
  coverageReceipt?: string;
};

export function buildEvidenceCollectSummary(taskId: string, relativePath: string, evidence: Evidence): EvidenceCollectSummary {
  const passed = evidence.checks.filter((check) => check.status === "passed").length;
  const failed = evidence.checks.length - passed;
  return {
    schemaVersion: "1.0.0",
    status: "pass",
    taskId,
    path: relativePath,
    checks: {
      total: evidence.checks.length,
      passed,
      failed
    },
    changedFiles: evidence.changedFiles.length,
    pullRequest: evidence.git?.pullRequest ?? null,
    ...(evidence.ciReceipt ? {
      ciReceipt: { verified: true as const, workflowRunId: evidence.ciReceipt.workflowRunId, jobCount: evidence.ciReceipt.jobs.length }
    } : {})
  };
}

export function formatEvidenceCollectSummary(summary: EvidenceCollectSummary): string {
  return [
    "PASS evidence collected",
    `path: ${summary.path}`,
    `checks: ${summary.checks.passed} passed, ${summary.checks.failed} failed`,
    `changedFiles: ${summary.changedFiles}`,
    `pullRequest: ${summary.pullRequest ?? "(not recorded)"}`,
    ...(summary.ciReceipt ? [`ciReceipt: verified ${summary.ciReceipt.workflowRunId} (${summary.ciReceipt.jobCount} jobs)`] : [])
  ].join("\n") + "\n";
}

export function runEvidenceCollect(root: string, taskId: string, options: EvidenceCollectOptions): number {
  try {
    const outputModes = [options.json, options.verbose, options.output !== undefined].filter(Boolean).length;
    if (outputModes > 1) {
      console.error("Choose one of --json, --verbose, or --output -");
      return 2;
    }
    if (options.output !== undefined && options.output !== "-") {
      console.error("--output target must be -");
      return 2;
    }
    const workingTree = evaluateWorkingTreeGuard(root, taskId);
    if (workingTree.issues.length > 0) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify({
          schemaVersion: "1.0.0",
          status: "blocked",
          taskId,
          workingTree: workingTree.state,
          issues: workingTree.issues
        }, null, 2)}\n`);
      } else {
        printIssues(workingTree.issues);
      }
      return 1;
    }
    const relativePath = evidencePath(taskId);
    const fullPath = resolveFrom(root, relativePath);
    if (existsSync(fullPath) && !options.force) {
      console.error(`${relativePath} already exists`);
      return 1;
    }
    mkdirSync(path.dirname(fullPath), { recursive: true });
    const ciReceipt = options.ciReceipt
      ? JSON.parse(readFileSync(path.isAbsolute(options.ciReceipt) ? options.ciReceipt : resolveFrom(root, options.ciReceipt), "utf8")) as CiReceipt
      : undefined;
    const coverageReceipt = options.coverageReceipt
      ? JSON.parse(readFileSync(path.isAbsolute(options.coverageReceipt) ? options.coverageReceipt : resolveFrom(root, options.coverageReceipt), "utf8")) as CoverageReceipt
      : undefined;
    const evidence = buildCollectedEvidence(root, taskId, {
      baseRef: options.baseRef,
      pullRequest: options.pullRequest,
      testQuality: options.testQuality,
      rerunChecks: options.rerunChecks,
      ciReceipt,
      coverageReceipt
    });
    const baseCommit = evidence.git?.baseCommit;
    const subjectCommit = evidence.subjectHeadCommit ?? evidence.git?.subjectHeadCommit ?? evidence.commit;
    if (
      evidence.provenance?.retention.mode === "patch-artifact"
      && baseCommit
      && subjectCommit
    ) {
      const artifact = buildPatchArtifact(root, taskId, baseCommit, subjectCommit);
      const artifactPath = resolveFrom(root, artifact.relativePath);
      mkdirSync(path.dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, artifact.bytes);
    }
    const yaml = stringifySimpleYaml(evidence as unknown as Record<string, unknown>);
    writeFileSync(fullPath, yaml, "utf8");
    syncRegistry(root);
    const summary = buildEvidenceCollectSummary(taskId, relativePath, evidence);
    if (!options.quiet) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      } else if (options.output === "-") {
        process.stdout.write(yaml);
      } else {
        process.stdout.write(formatEvidenceCollectSummary(summary));
        if (options.verbose) process.stdout.write(yaml);
      }
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export const CI_READINESS_SCHEMA_VERSION = "1.0.0" as const;
export const CI_READINESS_TYPE = "scwbs.pr-readiness.v1" as const;

export type CiReadinessArtifact = {
  schemaVersion: typeof CI_READINESS_SCHEMA_VERSION;
  type: typeof CI_READINESS_TYPE;
  repository: string;
  pullRequest: string;
  taskId: string;
  headCommit: string;
  baseRef: string;
  baseCommit: string;
  diffHash: string;
  authorityFingerprint: string;
  workflowPath: typeof CI_WORKFLOW_PATH;
  workflowRunId: string;
  workflowRunUrl: string;
  artifactName: string;
  artifactDigest: string;
  validateStatus: "success" | "failure" | "cancelled" | "unknown";
  nextAction: {
    owner: "human" | "ai" | "user" | "external";
    kind: "guidance" | "wait" | "command";
    message: string;
  };
  mergeReadiness: {
    status: "ready" | "not-ready" | "unknown";
    reasonCodes: string[];
  };
  generatedAt: string;
};

export type CiReadinessExpected = {
  taskId: string;
  pullRequest: string;
  headCommit: string;
  workflowRunId?: string;
};

export function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function readinessNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readinessPullRequestNumber(value: string): string {
  return value.replace(/^#/, "");
}

export function verifyCiReadinessArtifact(
  root: string,
  value: unknown,
  expected: CiReadinessExpected,
  ciReceiptBytes: Uint8Array
): CiReadinessArtifact {
  const failures: string[] = [];
  if (!isRecord(value)) throw new Error("PR readiness artifact rejected: JSON root must be an object");
  const artifact = value as Partial<CiReadinessArtifact>;
  for (const key of [
    "repository", "pullRequest", "taskId", "headCommit", "baseRef", "baseCommit", "diffHash",
    "authorityFingerprint", "workflowPath", "workflowRunId", "workflowRunUrl", "artifactName",
    "artifactDigest", "validateStatus", "generatedAt"
  ] as const) {
    if (!readinessNonEmpty(artifact[key])) failures.push(`${key} is missing`);
  }
  if (artifact.schemaVersion !== CI_READINESS_SCHEMA_VERSION) failures.push("schemaVersion is unsupported");
  if (artifact.type !== CI_READINESS_TYPE) failures.push("type is unsupported");
  if (artifact.taskId !== expected.taskId) failures.push("taskId does not match the current Task");
  if (readinessPullRequestNumber(artifact.pullRequest ?? "") !== readinessPullRequestNumber(expected.pullRequest)) failures.push("pullRequest does not match the requested PR");
  if (artifact.headCommit !== expected.headCommit) failures.push("headCommit is stale or does not match the current subject");
  if (expected.workflowRunId && artifact.workflowRunId !== expected.workflowRunId) failures.push("workflowRunId does not match the triggering workflow");
  if (artifact.workflowPath !== CI_WORKFLOW_PATH) failures.push(`workflowPath must be ${CI_WORKFLOW_PATH}`);
  if (artifact.validateStatus !== "success") failures.push("validateStatus is not success");
  if (typeof artifact.workflowRunId === "string" && !validRunUrl(artifact.workflowRunUrl, artifact.workflowRunId)) failures.push("workflowRunUrl is invalid or does not identify workflowRunId");
  if (typeof artifact.artifactDigest === "string" && artifact.artifactDigest !== sha256Bytes(ciReceiptBytes)) failures.push("artifactDigest does not match the CI receipt bytes");
  if (!artifact.nextAction || !["human", "ai", "user", "external"].includes(artifact.nextAction.owner) || !["guidance", "wait", "command"].includes(artifact.nextAction.kind) || !readinessNonEmpty(artifact.nextAction.message)) failures.push("nextAction is incomplete");
  if (!artifact.mergeReadiness || !["ready", "not-ready", "unknown"].includes(artifact.mergeReadiness.status) || !Array.isArray(artifact.mergeReadiness.reasonCodes) || artifact.mergeReadiness.reasonCodes.some((code) => typeof code !== "string")) failures.push("mergeReadiness is incomplete");
  if (typeof artifact.generatedAt === "string" && Number.isNaN(Date.parse(artifact.generatedAt))) failures.push("generatedAt is invalid");
  try {
    if (artifact.repository !== originRepository(root)) failures.push("repository does not match origin");
  } catch (error) {
    failures.push(error instanceof Error ? error.message.replace(/^CI receipt rejected:\s*/, "") : "origin repository cannot be verified");
  }
  if (failures.length > 0) throw new Error(`PR readiness artifact rejected:\n- ${failures.join("\n- ")}`);
  return artifact as CiReadinessArtifact;
}

export function buildCiReadinessArtifact(input: Omit<CiReadinessArtifact, "schemaVersion" | "type">): CiReadinessArtifact {
  return { schemaVersion: CI_READINESS_SCHEMA_VERSION, type: CI_READINESS_TYPE, ...input };
}

export type EvidenceImportCiOptions = {
  readiness: string;
  ciReceipt: string;
  coverageReceipt?: string;
};

function readEvidenceImportJson(root: string, file: string): unknown {
  const fullPath = path.isAbsolute(file) ? file : resolveFrom(root, file);
  return JSON.parse(readFileSync(fullPath, "utf8")) as unknown;
}

function readEvidenceImportBytes(root: string, file: string): Uint8Array {
  const fullPath = path.isAbsolute(file) ? file : resolveFrom(root, file);
  return readFileSync(fullPath);
}

export function runEvidenceImportCi(root: string, taskId: string, options: EvidenceImportCiOptions): number {
  try {
    const readiness = readEvidenceImportJson(root, options.readiness) as { pullRequest?: string; taskId?: string; workflowRunId?: string; baseRef?: string };
    const headCommit = resolveCommit(root, "HEAD");
    if (!headCommit) throw new Error("CI Evidence import rejected: HEAD cannot be resolved");
    if (!readiness.pullRequest || !readiness.workflowRunId || readiness.taskId !== taskId || !readiness.baseRef) throw new Error("CI Evidence import rejected: readiness artifact is missing task, PR, run, or base provenance");
    verifyCiReadinessArtifact(root, readiness, { taskId, pullRequest: readiness.pullRequest, headCommit, workflowRunId: readiness.workflowRunId }, readEvidenceImportBytes(root, options.ciReceipt));
    return runEvidenceCollect(root, taskId, {
      force: true,
      pullRequest: readiness.pullRequest,
      baseRef: readiness.baseRef,
      ciReceipt: path.isAbsolute(options.ciReceipt) ? options.ciReceipt : resolveFrom(root, options.ciReceipt),
      coverageReceipt: options.coverageReceipt ? path.isAbsolute(options.coverageReceipt) ? options.coverageReceipt : resolveFrom(root, options.coverageReceipt) : undefined
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export type EvidenceVerifyAttestationOptions = {
  artifact: string;
  repository?: string;
  signerWorkflow?: string;
  predicateType?: string;
  sourceRef?: string;
  sourceCommit?: string;
  bundle?: string;
  customTrustedRoot?: string;
  json?: boolean;
};

export function runEvidenceVerifyAttestation(root: string, taskId: string, options: EvidenceVerifyAttestationOptions): number {
  try {
    const evidenceResult = readEvidence(root, taskId);
    let repository = options.repository;
    let origin: string | undefined;
    if (!repository) {
      try {
        origin = originRepository(root);
        repository = origin;
      } catch {
        repository = undefined;
      }
    } else {
      try {
        origin = originRepository(root);
        if (origin !== repository) repository = undefined;
      } catch {
        // A caller-provided repository is usable for an isolated/offline fixture only
        // when no origin is available; the verifier still binds it to the attestation.
      }
    }
    const result = verifyAttestation(root, {
      root,
      taskId,
      artifact: options.artifact,
      evidence: evidenceResult.evidence,
      repository,
      signerWorkflow: options.signerWorkflow,
      predicateType: options.predicateType,
      sourceRef: options.sourceRef,
      sourceCommit: options.sourceCommit,
      bundle: options.bundle,
      customTrustedRoot: options.customTrustedRoot
    });
    if (evidenceResult.evidence) {
      const updated: Evidence = {
        ...evidenceResult.evidence,
        attestationVerification: toAttestationEvidence(result)
      };
      writeFileSync(resolveFrom(root, evidencePath(taskId)), stringifySimpleYaml(updated as unknown as Record<string, unknown>), "utf8");
      syncRegistry(root);
    }
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`attestation: ${result.status}\nreasonCodes: ${result.reasonCodes.join(", ") || "none"}\n`);
    return result.status === "verified" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function retainedSubjectHead(evidence: Evidence): string | undefined {
  return evidence.subjectHeadCommit ?? evidence.git?.subjectHeadCommit ?? evidence.git?.headCommit ?? evidence.commit;
}

function retainedDiffHash(evidence: Evidence): string | undefined {
  return evidence.diffHash ?? evidence.git?.diffHash;
}

function sortedRetainedPaths(values: string[]): string[] {
  return [...new Set(values.map((value) => value.replace(/\\/g, "/")))].sort();
}

function retainedPullRequestNumber(value: string | undefined): string | undefined {
  const match = value?.trim().match(/^#?([1-9][0-9]*)$/);
  return match?.[1];
}

function fetchRecordedPullRequestHead(root: string, pullRequest: string, subject: string): void {
  const fetch = spawnSync(
    "git",
    ["fetch", "--no-tags", "origin", `refs/pull/${pullRequest}/head`],
    { cwd: root, encoding: "utf8" }
  );
  if (fetch.status !== 0) throw new Error(`Unable to fetch recorded PR #${pullRequest} head`);
  const fetchedHead = resolveCommit(root, "FETCH_HEAD");
  if (!fetchedHead || !commitExists(root, subject) || !isCommitAncestor(root, subject, fetchedHead)) {
    throw new Error(`Recorded Evidence subject is not reachable from PR #${pullRequest} head`);
  }
}

export function runEvidenceRetain(
  root: string,
  taskId: string,
  options: { fetchPrHead?: boolean } = {}
): number {
  try {
    const { task, issues: taskIssues } = readTask(root, taskId);
    if (!task) throw new Error(taskIssues.map((issue) => issue.message).join("\n"));
    const workingTree = workingTreeState(root);
    if (workingTree.changedFiles.length > 0) {
      throw new Error(`Evidence retention requires a clean working tree: ${workingTree.changedFiles.join(", ")}`);
    }
    const { evidence, issues } = readEvidence(root, taskId);
    if (!evidence) throw new Error(issues.map((issue) => issue.message).join("\n"));
    const subject = retainedSubjectHead(evidence);
    const baseCommit = evidence.git?.baseCommit;
    const recordedDiffHash = retainedDiffHash(evidence);
    if (!subject || !baseCommit || !recordedDiffHash) {
      throw new Error(`${taskId} Evidence must record subjectHeadCommit, git.baseCommit, and diffHash`);
    }
    if (!commitExists(root, subject)) {
      if (!options.fetchPrHead) {
        throw new Error(`${taskId} subject commit is unavailable; retry with --fetch-pr-head when Evidence records a GitHub PR`);
      }
      const pullRequest = retainedPullRequestNumber(evidence.git?.pullRequest);
      if (!pullRequest) throw new Error(`${taskId} Evidence does not record a valid pull request number`);
      fetchRecordedPullRequestHead(root, pullRequest, subject);
    }
    if (!commitExists(root, baseCommit)) throw new Error(`${taskId} base commit is unavailable: ${baseCommit}`);
    const metadataFiles = taskLifecycleMetadataPaths(taskId);
    const actualDiffHash = hashDiffBinary(diffBinary(root, baseCommit, subject, metadataFiles));
    if (actualDiffHash !== recordedDiffHash) {
      throw new Error(`${taskId} reconstructed implementation diffHash does not match existing Evidence`);
    }
    const actualChangedFiles = changedFilesBetweenRefs(root, baseCommit, subject, metadataFiles);
    const recordedChangedFiles = evidence.changedFiles.filter((file) => !metadataFiles.includes(file.replace(/\\/g, "/")));
    if (JSON.stringify(sortedRetainedPaths(actualChangedFiles)) !== JSON.stringify(sortedRetainedPaths(recordedChangedFiles))) {
      throw new Error(`${taskId} reconstructed changed files do not match existing Evidence`);
    }
    const artifact = buildPatchArtifact(root, taskId, baseCommit, subject);
    const artifactPath = resolveFrom(root, artifact.relativePath);
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, artifact.bytes);

    const updatedEvidence = {
      ...evidence,
      provenance: {
        schemaVersion: "1.0.0" as const,
        subject: {
          commit: subject,
          treeHash: artifact.treeHash,
          diffHash: recordedDiffHash,
          canonicalization: "git-diff-binary-v1" as const
        },
        retention: {
          mode: "patch-artifact" as const,
          locator: artifact.locator,
          manifestHash: artifact.manifestHash
        }
      }
    };
    const relativeEvidencePath = evidencePath(taskId);
    const fullEvidencePath = resolveFrom(root, relativeEvidencePath);
    if (!existsSync(fullEvidencePath)) throw new Error(`${relativeEvidencePath} does not exist`);
    writeFileSync(fullEvidencePath, stringifySimpleYaml(updatedEvidence as unknown as Record<string, unknown>), "utf8");
    syncRegistry(root);
    console.log(`retained ${taskId} provenance at ${artifact.relativePath}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export type EvidencePruneOptions = {
  json?: boolean;
  apply?: boolean;
};

export type EvidencePruneSummary = {
  schemaVersion: "scwbs.evidence-prune.v1";
  status: "plan";
  readOnly: true;
  payloads: {
    count: number;
    totalBytes: number;
    byRetentionMode: Record<string, number>;
  };
  archivedCandidates: Array<{
    taskId: string;
    payloadPath: string;
    bytes: number;
    archivedAt?: string;
    retentionMode: string;
    eligible: false;
    reason: "retention-cutoff-requires-human-decision";
  }>;
  humanDecision: {
    required: true;
    decisions: ["retention-cutoff", "archive-durability", "audit-trust-after-removal", "git-history-rewrite"];
  };
};

function prunePayloadTaskId(file: string): string | undefined {
  if (!file.endsWith(".patch")) return undefined;
  const taskId = file.slice(0, -".patch".length);
  return taskId.length > 0 ? taskId : undefined;
}

function formatEvidencePruneSummary(summary: EvidencePruneSummary): string {
  const modes = Object.entries(summary.payloads.byRetentionMode)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([mode, count]) => `${mode}=${count}`)
    .join(", ");
  return [
    "Evidence prune plan (read-only)",
    `payloads: ${summary.payloads.count}`,
    `bytes: ${summary.payloads.totalBytes}`,
    `retention modes: ${modes || "none"}`,
    `archived candidates: ${summary.archivedCandidates.length}`,
    "next: human decision required for retention cutoff, archive durability, audit trust, and Git history policy"
  ].join("\n") + "\n";
}

export function buildEvidencePruneSummary(root: string): EvidencePruneSummary {
  const indexResult = readTaskIndex(root);
  if (!indexResult.index || indexResult.issues.length > 0) {
    throw new Error(indexResult.issues.map((issue) => issue.message).join("\n") || "Task index is invalid");
  }
  const evidenceByTask = new Map(
    listEvidence(root).flatMap((entry) => entry.evidence ? [[entry.evidence.taskId, entry.evidence] as const] : [])
  );
  const payloadDir = resolveFrom(root, "contracts/evidence-payloads");
  const payloads = existsSync(payloadDir)
    ? readdirSync(payloadDir).filter((file) => file.endsWith(".patch")).sort()
    : [];
  const byRetentionMode: Record<string, number> = {};
  let totalBytes = 0;
  const archived = new Map(indexResult.index.tasks.filter((entry) => entry.status === "archived").map((entry) => [entry.id, entry]));
  const archivedCandidates: EvidencePruneSummary["archivedCandidates"] = [];

  for (const file of payloads) {
    const taskId = prunePayloadTaskId(file);
    if (!taskId) continue;
    const bytes = statSync(path.join(payloadDir, file)).size;
    totalBytes += bytes;
    const retentionMode = evidenceByTask.get(taskId)?.provenance?.retention.mode ?? "legacy";
    byRetentionMode[retentionMode] = (byRetentionMode[retentionMode] ?? 0) + 1;
    const task = archived.get(taskId);
    if (task) {
      archivedCandidates.push({
        taskId,
        payloadPath: evidencePayloadPath(taskId),
        bytes,
        ...(task.archivedAt ? { archivedAt: task.archivedAt } : {}),
        retentionMode,
        eligible: false,
        reason: "retention-cutoff-requires-human-decision"
      });
    }
  }

  archivedCandidates.sort((left, right) => left.taskId.localeCompare(right.taskId));
  return {
    schemaVersion: "scwbs.evidence-prune.v1",
    status: "plan",
    readOnly: true,
    payloads: { count: payloads.length, totalBytes, byRetentionMode },
    archivedCandidates,
    humanDecision: {
      required: true,
      decisions: ["retention-cutoff", "archive-durability", "audit-trust-after-removal", "git-history-rewrite"]
    }
  };
}

export function runEvidencePrune(root: string, options: EvidencePruneOptions = {}): number {
  try {
    if (options.apply) {
      throw new Error("Evidence prune is read-only in this Task; payload deletion, external archive, and Git history rewrite require a new human-approved Task Contract");
    }
    const summary = buildEvidencePruneSummary(root);
    process.stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : formatEvidencePruneSummary(summary));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
