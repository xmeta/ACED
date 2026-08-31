import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  evaluateMergePreflight,
  unavailableMergeReport,
  noWorkflowTrust,
  type MergePreflightViolation,
  type MergePreflightReport,
  type MergePullRequestView,
  type WorkflowTrustResult
} from "../core/merge-preflight.js";
import { doctorGithubHint } from "../core/github-actions.js";
import { listTasks, readApproval, readEvidence } from "../core/contracts.js";
import { evidenceDiffHash, evidenceSubjectHead, validateHumanGateApproval } from "../core/human-gate.js";
import {
  changedFilesBetween,
  diffBinary,
  gitObject,
  hashDiffBinary,
  isCommitAncestor,
  mergeBase,
  resolveCommit
} from "../core/git.js";
import { taskLifecycleMetadataPaths } from "../core/managed-contract-paths.js";

const VIEW_FIELDS = "number,state,isDraft,baseRefName,baseRefOid,headRefOid,mergeStateStatus,statusCheckRollup";
const CONTROL_SURFACE = [
  { kind: "workflow", pattern: ".github/workflows/**" },
  { kind: "local-action", pattern: ".github/actions/**" },
  { kind: "ci-runner", pattern: "scripts/**" },
  { kind: "package-config", pattern: "package.json" },
  { kind: "package-config", pattern: "package-lock.json" },
  { kind: "package-config", pattern: "tsconfig.json" },
  { kind: "package-config", pattern: "vitest.config.ts" },
  { kind: "merge-enforcement", pattern: "src/core/merge-preflight.ts" },
  { kind: "merge-enforcement", pattern: "src/commands/merge.ts" },
  { kind: "merge-enforcement", pattern: "src/commands/finish.ts" },
  { kind: "merge-enforcement", pattern: "src/cli.ts" }
];
const SHA = /^[a-f0-9]{40}$/;

function githubRepository(root: string): string | undefined {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.trim().match(/(?:github\.com[/:])([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
}

function emit(report: MergePreflightReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report));
    return;
  }
  console.log(`${report.status === "pass" ? "PASS" : "BLOCKED"} merge preflight PR #${report.pullRequest}`);
  console.log(`repository: ${report.repository ?? "unknown"}`);
  console.log(`base: ${report.base ?? "unknown"}`);
  console.log(`head: ${report.headCommit ?? "unknown"}`);
  console.log(`mergeState: ${report.mergeState ?? "unknown"}`);
  console.log(`validate: ${report.validate.status}`);
  for (const violation of report.violations) console.log(`- ${violation.code}: ${violation.message}`);
  if (report.execution.executed) console.log(`merged: PR #${report.pullRequest}`);
}

function readPullRequest(
  root: string,
  repository: string,
  pullRequest: number
): {
  view?: MergePullRequestView;
  report?: MergePreflightReport;
} {
  const result = spawnSync("gh", ["pr", "view", String(pullRequest), "--repo", repository, "--json", VIEW_FIELDS], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return {
      report: unavailableMergeReport(pullRequest, doctorGithubHint("GitHub PR metadata could not be read"), repository)
    };
  }
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("expected an object");
    }
    return { view: value as MergePullRequestView };
  } catch {
    return {
      report: unavailableMergeReport(
        pullRequest,
        doctorGithubHint("GitHub PR metadata returned invalid JSON"),
        repository
      )
    };
  }
}

function api(root: string, endpoint: string): unknown {
  const result = spawnSync("gh", ["api", endpoint], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr || "GitHub API request failed").trim());
  return JSON.parse(result.stdout) as unknown;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub API returned invalid JSON");
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function sha256Base64(value: unknown): string | undefined {
  const encoded = text(value);
  if (!encoded) return undefined;
  try {
    return `sha256:${createHash("sha256").update(Buffer.from(encoded, "base64")).digest("hex")}`;
  } catch {
    return undefined;
  }
}
function matchesControl(file: string, pattern: string): boolean {
  return pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : file === pattern;
}
function violation(code: string, message: string): MergePreflightViolation {
  return { code, message };
}

function metadataMatchesHead(root: string, head: string, taskId: string): boolean {
  const files = taskLifecycleMetadataPaths(taskId);
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ...files], {
    cwd: root,
    encoding: "utf8"
  });
  if (status.status !== 0 || status.stdout.trim().length > 0) return false;
  for (const file of [
    `contracts/tasks/${taskId}.yaml`,
    `contracts/evidence/${taskId}.yaml`,
    `contracts/approvals/${taskId}.yaml`
  ]) {
    const committed = gitObject(root, head, file);
    const localPath = path.join(root, file);
    if (committed === undefined || readFileSync(localPath, "utf8") !== committed) return false;
  }
  return true;
}

function resolveApproval(
  root: string,
  pullRequest: number,
  base: string,
  head: string,
  files: string[]
): MergePreflightViolation[] {
  if (resolveCommit(root, "HEAD") !== head) {
    return [violation("merge.workflowTrust.approval.head", `local metadata was not read from current PR head ${head}`)];
  }
  const candidateStatus = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", "contracts/tasks", "contracts/evidence"],
    { cwd: root, encoding: "utf8" }
  );
  if (candidateStatus.status !== 0 || candidateStatus.stdout.trim().length > 0) {
    return [
      violation("merge.workflowTrust.approval.metadata", "Task and Evidence candidates contain uncommitted metadata")
    ];
  }
  const matches = listTasks(root).flatMap((entry) => {
    if (!entry.task) return [];
    const evidence = readEvidence(root, entry.task.id).evidence;
    const evidencePr = evidence?.git?.pullRequest?.replace(/^#/, "");
    return evidencePr === String(pullRequest) ? [{ task: entry.task, evidence }] : [];
  });
  if (matches.length !== 1)
    return [
      violation(
        "merge.workflowTrust.approval.task",
        `workflow control PR requires exactly one Task Evidence for PR #${pullRequest}`
      )
    ];
  const { task, evidence } = matches[0]!;
  const subject = evidenceSubjectHead(evidence);
  const diffHash = evidenceDiffHash(evidence);
  if (!evidence || !subject || !diffHash || !metadataMatchesHead(root, head, task.id))
    return [
      violation(
        "merge.workflowTrust.approval.evidence",
        `${task.id} Evidence/Approval metadata is not committed and bound to the current PR head`
      )
    ];
  if (!isCommitAncestor(root, subject, head)) {
    return [
      violation(
        "merge.workflowTrust.approval.evidence",
        `${task.id} Evidence subject head is not an ancestor of PR head`
      )
    ];
  }
  const lifecycleFiles = taskLifecycleMetadataPaths(task.id);
  let intervening: string[];
  try {
    intervening = changedFilesBetween(root, subject, head);
  } catch {
    return [
      violation("merge.workflowTrust.approval.evidence", `${task.id} Evidence subject-to-head history is unavailable`)
    ];
  }
  if (!intervening.every((file) => lifecycleFiles.includes(file.replace(/\\/g, "/")))) {
    return [
      violation(
        "merge.workflowTrust.approval.evidence",
        `${task.id} Evidence subject-to-head includes non-lifecycle files`
      )
    ];
  }
  const commonBase = mergeBase(root, base, subject);
  if (!commonBase)
    return [violation("merge.workflowTrust.approval.evidence", `${task.id} Evidence diff base cannot be resolved`)];
  let actualDiffHash: string;
  try {
    actualDiffHash = hashDiffBinary(diffBinary(root, commonBase, subject, lifecycleFiles));
  } catch {
    return [violation("merge.workflowTrust.approval.evidence", `${task.id} Evidence diff cannot be recomputed`)];
  }
  if (actualDiffHash !== diffHash) {
    return [
      violation(
        "merge.workflowTrust.approval.evidence",
        `${task.id} Evidence diffHash does not match the bounded git diff`
      )
    ];
  }
  const approval = readApproval(root, task.id).approval;
  const scopedApproval = approval?.version === "scwbs.approval.v2" ? approval.scopeApprovals?.["human-gate"] : approval;
  const approvalPullRequest = scopedApproval?.pullRequest?.replace(/^#/, "");
  if (
    !scopedApproval ||
    scopedApproval.status !== "approved" ||
    approvalPullRequest !== String(pullRequest) ||
    !scopedApproval.headCommit ||
    !scopedApproval.diffHash
  ) {
    return [
      violation(
        "merge.workflowTrust.approval.scope",
        `${task.id} Human Approval must be an approved, PR/head/diff-bound human-gate record`
      )
    ];
  }
  // validateHumanGateApproval intentionally allows an empty Task gate. The
  // merge command must still gate every control-surface observation.
  // Use the audited manifest patterns, not observed filenames. A filename can
  // contain glob metacharacters (for example `[audit].yml`) and must never be
  // able to make validateHumanGateApproval silently see an empty required set.
  const gateTask = { ...task, humanGateRequiredPaths: CONTROL_SURFACE.map((entry) => entry.pattern) };
  const gate = validateHumanGateApproval(gateTask, evidence, approval, files, root);
  if (!gate.required)
    return [
      violation(
        "merge.workflowTrust.approval.required",
        `${task.id} control surface did not produce a Human Gate requirement`
      )
    ];
  return gate.approved ? [] : gate.issues.map((issue) => violation(`merge.workflowTrust.${issue.code}`, issue.message));
}

function sha256Digest(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function pagedObjects(root: string, endpoint: string, field: string, bound: number): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  let total: number | undefined;
  for (let page = 1; page <= Math.ceil(bound / 100) + 1; page += 1) {
    const raw = api(root, `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    if (Array.isArray(raw)) throw new Error(`${field} response has no total_count`);
    const payload = object(raw);
    const count = payload.total_count;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > bound) {
      throw new Error(`${field} total_count is invalid or exceeds the bound`);
    }
    if (total === undefined) total = count;
    else if (total !== count) throw new Error(`${field} total_count changed during pagination`);
    const pageItems = payload[field];
    if (!Array.isArray(pageItems) || pageItems.length > 100) throw new Error(`${field} page is invalid`);
    items.push(...pageItems.map(object));
    if (items.length > bound || items.length > total) throw new Error(`${field} pagination exceeds total_count`);
    // Fetch one empty page after an exact 100-item boundary. This detects an
    // API that silently returns more items than its advertised total_count.
    if (pageItems.length < 100) {
      if (items.length !== total) throw new Error(`${field} pagination is incomplete`);
      return items;
    }
  }
  throw new Error(`${field} pagination exceeded the page bound`);
}

function pagedFiles(root: string, endpoint: string, expected: number): Array<Record<string, unknown>> {
  const files: Array<Record<string, unknown>> = [];
  for (let page = 1; page <= 4; page += 1) {
    const raw = api(root, `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    if (!Array.isArray(raw) || raw.length > 100) throw new Error("PR changed-files response is invalid");
    files.push(...raw.map(object));
    if (files.length > 256 || files.length > expected) throw new Error("PR changed-file response exceeds its bound");
    if (raw.length < 100) {
      if (files.length !== expected) throw new Error("PR changed-file pagination is incomplete");
      return files;
    }
  }
  throw new Error("PR changed-file pagination exceeded the page bound");
}

function apiBuffer(root: string, endpoint: string): Buffer {
  const result = spawnSync("gh", ["api", endpoint], { cwd: root, encoding: "buffer", maxBuffer: 64 * 1024 });
  if (result.status !== 0) throw new Error((result.stderr?.toString("utf8") || "GitHub API request failed").trim());
  return result.stdout;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function extractReceiptZip(archive: Buffer): Buffer {
  if (archive.length === 0 || archive.length > 64 * 1024)
    throw new Error("workflow-integrity artifact archive exceeds the bound");
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 22 - 0xffff); offset -= 1) {
    if (offset >= 0 && archive.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > archive.length) throw new Error("workflow-integrity artifact is not a ZIP archive");
  const disk = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const entriesOnDisk = archive.readUInt16LE(eocd + 8);
  const entries = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  const commentLength = archive.readUInt16LE(eocd + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== 1 ||
    entries !== 1 ||
    commentLength !== archive.length - eocd - 22 ||
    centralOffset + centralSize !== eocd ||
    centralSize < 46 ||
    centralOffset + 46 > archive.length
  )
    throw new Error("workflow-integrity artifact ZIP has unsupported bounds");
  if (archive.readUInt32LE(centralOffset) !== 0x02014b50)
    throw new Error("workflow-integrity artifact ZIP central header is invalid");
  const madeBy = archive.readUInt16LE(centralOffset + 4);
  const flags = archive.readUInt16LE(centralOffset + 8);
  const method = archive.readUInt16LE(centralOffset + 10);
  const expectedCrc = archive.readUInt32LE(centralOffset + 16);
  const compressedSize = archive.readUInt32LE(centralOffset + 20);
  const uncompressedSize = archive.readUInt32LE(centralOffset + 24);
  const nameLength = archive.readUInt16LE(centralOffset + 28);
  const extraLength = archive.readUInt16LE(centralOffset + 30);
  const commentLengthCentral = archive.readUInt16LE(centralOffset + 32);
  const externalAttributes = archive.readUInt32LE(centralOffset + 38);
  const localOffset = archive.readUInt32LE(centralOffset + 42);
  const centralEnd = centralOffset + 46 + nameLength + extraLength + commentLengthCentral;
  const name = archive.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString("utf8");
  const unixMode = madeBy >> 8 === 3 ? (externalAttributes >>> 16) & 0xf000 : 0;
  if (
    centralEnd !== eocd ||
    name !== "workflow-integrity-receipt.json" ||
    (flags & 0x1) !== 0 ||
    ![0, 8].includes(method) ||
    unixMode === 0xa000 ||
    (externalAttributes & 0x10) !== 0 ||
    compressedSize === 0xffffffff ||
    uncompressedSize === 0xffffffff ||
    localOffset === 0xffffffff
  )
    throw new Error("workflow-integrity artifact ZIP entry is unsafe");
  if (localOffset + 30 > centralOffset || archive.readUInt32LE(localOffset) !== 0x04034b50)
    throw new Error("workflow-integrity artifact ZIP local header is invalid");
  const localFlags = archive.readUInt16LE(localOffset + 6);
  const localMethod = archive.readUInt16LE(localOffset + 8);
  const localCrc = archive.readUInt32LE(localOffset + 14);
  const localCompressedSize = archive.readUInt32LE(localOffset + 18);
  const localUncompressedSize = archive.readUInt32LE(localOffset + 22);
  const localNameLength = archive.readUInt16LE(localOffset + 26);
  const localExtraLength = archive.readUInt16LE(localOffset + 28);
  const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
  const dataStart = localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + compressedSize;
  if (
    localFlags !== flags ||
    localMethod !== method ||
    localName !== name ||
    dataStart < 0 ||
    dataEnd > centralOffset ||
    ((flags & 0x8) === 0 &&
      (localCrc !== expectedCrc ||
        localCompressedSize !== compressedSize ||
        localUncompressedSize !== uncompressedSize))
  )
    throw new Error("workflow-integrity artifact ZIP local/central entry mismatch");
  if ((flags & 0x8) !== 0) {
    if (dataEnd + 12 > centralOffset) throw new Error("workflow-integrity artifact ZIP data descriptor is missing");
    const descriptor = archive.readUInt32LE(dataEnd) === 0x08074b50 ? dataEnd + 4 : dataEnd;
    if (
      descriptor + 12 !== centralOffset ||
      archive.readUInt32LE(descriptor) !== expectedCrc ||
      archive.readUInt32LE(descriptor + 4) !== compressedSize ||
      archive.readUInt32LE(descriptor + 8) !== uncompressedSize
    )
      throw new Error("workflow-integrity artifact ZIP data descriptor is invalid");
  }
  const compressed = archive.subarray(dataStart, dataEnd);
  let receipt: Buffer;
  try {
    receipt = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: 32 * 1024 });
  } catch {
    throw new Error("workflow-integrity artifact ZIP decompression failed");
  }
  if (receipt.length !== uncompressedSize || receipt.length > 32 * 1024 || crc32(receipt) !== expectedCrc)
    throw new Error("workflow-integrity artifact ZIP receipt integrity is invalid");
  return receipt;
}

function downloadReceipt(
  root: string,
  repository: string,
  artifactId: number,
  artifactName: string,
  artifactDigest: string,
  artifactSize: number
): Buffer {
  if (!Number.isInteger(artifactId) || artifactId <= 0 || !artifactName)
    throw new Error("workflow-integrity artifact identity is invalid");
  const archive = apiBuffer(root, `repos/${repository}/actions/artifacts/${artifactId}/zip`);
  if (archive.length !== artifactSize || sha256Digest(archive) !== artifactDigest)
    throw new Error("workflow-integrity artifact digest or size does not match");
  return extractReceiptZip(archive);
}

type PullSnapshot = {
  number: number;
  id: number;
  state: string;
  baseRef: string;
  baseRepo: string;
  baseSha: string;
  headRepo: string;
  headRef: string;
  headSha: string;
  changed: number;
};

function pullSnapshot(value: unknown): PullSnapshot {
  const pr = object(value);
  const base = object(pr.base);
  const head = object(pr.head);
  const snapshot: PullSnapshot = {
    number: Number.isInteger(Number(pr.number)) ? Number(pr.number) : 0,
    id: Number.isInteger(Number(pr.id)) ? Number(pr.id) : 0,
    state: text(pr.state) ?? "",
    baseRef: text(base.ref) ?? "",
    baseRepo:
      base.repo && typeof base.repo === "object" ? (text((base.repo as Record<string, unknown>).full_name) ?? "") : "",
    baseSha: text(base.sha) ?? "",
    headRepo:
      head.repo && typeof head.repo === "object" ? (text((head.repo as Record<string, unknown>).full_name) ?? "") : "",
    headRef: text(head.ref) ?? "",
    headSha: text(head.sha) ?? "",
    changed: Number(pr.changed_files)
  };
  if (
    !Number.isInteger(snapshot.id) ||
    snapshot.id < 0 ||
    !SHA.test(snapshot.baseSha) ||
    !SHA.test(snapshot.headSha) ||
    !Number.isInteger(snapshot.changed) ||
    snapshot.changed < 0 ||
    snapshot.changed > 256
  ) {
    throw new Error("PR metadata is invalid or exceeds the changed-file bound");
  }
  return snapshot;
}

function workflowTrust(
  root: string,
  repository: string,
  pullRequest: number,
  view: MergePullRequestView
): WorkflowTrustResult {
  const trust = noWorkflowTrust();
  try {
    if (!view.headRefOid || !SHA.test(view.headRefOid) || !view.baseRefOid || !SHA.test(view.baseRefOid))
      throw new Error("PR base/head SHA is unavailable");
    const before = pullSnapshot(api(root, `repos/${repository}/pulls/${pullRequest}`));
    if (
      (before.number && before.number !== pullRequest) ||
      (before.state && before.state !== "open") ||
      (before.baseRef && before.baseRef !== "main") ||
      before.baseSha !== view.baseRefOid ||
      before.headSha !== view.headRefOid
    )
      throw new Error("PR base/head provenance is invalid");
    const files = pagedFiles(root, `repos/${repository}/pulls/${pullRequest}/files`, before.changed);
    const names = files.map((file) => text(file.filename));
    if (names.some((name) => !name) || new Set(names).size !== names.length)
      throw new Error("PR changed-file names are duplicated or invalid");
    const after = pullSnapshot(api(root, `repos/${repository}/pulls/${pullRequest}`));
    if (JSON.stringify(before) !== JSON.stringify(after) || files.length !== after.changed)
      throw new Error("PR changed while files were enumerated");
    const observations = files
      .flatMap((file) => {
        const filename = text(file.filename)!;
        const status = text(file.status);
        if (!status || !["added", "modified", "removed", "renamed"].includes(status))
          throw new Error("PR changed-file metadata is invalid");
        const renamed = status === "renamed";
        const previous = text(file.previous_filename);
        if (renamed && !previous) throw new Error("PR renamed-file metadata is invalid");
        if (!renamed && file.previous_filename !== undefined) throw new Error("PR changed-file metadata is invalid");
        const blob = text(file.sha);
        const validBlob = blob && SHA.test(blob) ? blob : null;
        const classify = (
          name: string,
          role: "current" | "previous",
          counterpart: string | null,
          headBlobSha: string | null,
          previousBlobSha: string | null
        ) =>
          CONTROL_SURFACE.filter((entry) => matchesControl(name, entry.pattern)).map((entry) => ({
            file: name,
            kind: entry.kind,
            role,
            counterpart,
            status,
            headBlobSha,
            previousBlobSha
          }));
        if (CONTROL_SURFACE.some((entry) => matchesControl(filename, entry.pattern)) && !validBlob)
          throw new Error("PR control file blob SHA is invalid");
        if (status === "removed") return classify(filename, "previous", null, null, validBlob);
        const current = classify(filename, "current", renamed ? previous! : null, validBlob, null);
        return renamed ? [...current, ...classify(previous!, "previous", filename, null, null)] : current;
      })
      .sort((left, right) => left.file.localeCompare(right.file) || left.kind.localeCompare(right.kind));
    const controlFiles = observations.map((item) => item.file);
    if (controlFiles.length === 0) return trust;
    trust.status = "blocked";
    trust.controlFiles = controlFiles;
    trust.trustedBaseCommit = view.baseRefOid;
    trust.nextAction = "Wait for workflow-integrity and obtain current Human Approval.";
    if (
      before.number !== pullRequest ||
      before.id <= 0 ||
      before.state !== "open" ||
      before.baseRef !== "main" ||
      before.baseRepo !== repository ||
      before.headRepo.length === 0 ||
      before.headRef.length === 0
    )
      throw new Error("PR repository/ref provenance is unavailable");
    const checks = pagedObjects(
      root,
      `repos/${repository}/commits/${view.headRefOid}/check-runs?check_name=workflow-integrity&filter=all`,
      "check_runs",
      256
    );
    const matches = checks.filter((check) => check.name === "workflow-integrity");
    if (matches.length !== 1) throw new Error("workflow-integrity check is missing or ambiguous");
    const check = matches[0]!;
    const summary = text(object(check.output).summary);
    if (!summary || Buffer.byteLength(summary, "utf8") > 32 * 1024)
      throw new Error("workflow-integrity check summary is missing or oversized");
    const locator = object(JSON.parse(summary));
    const verifierLocator = object(locator.verifier);
    const triggeringLocator = object(locator.triggeringRun);
    const verifierRunId = Number(verifierLocator.runId);
    const triggeringRunId = Number(triggeringLocator.id);
    if (
      !Number.isInteger(verifierRunId) ||
      verifierRunId <= 0 ||
      !Number.isInteger(triggeringRunId) ||
      triggeringRunId <= 0
    )
      throw new Error("workflow-integrity run locator is invalid");
    const verifierRun = object(api(root, `repos/${repository}/actions/runs/${verifierRunId}`));
    const verifierUrl = `https://github.com/${repository}/actions/runs/${verifierRunId}`;
    const verifierCommit = text(verifierLocator.definitionCommit);
    if (
      verifierRun.id !== verifierRunId ||
      verifierRun.path !== ".github/workflows/scwbs-workflow-integrity.yml" ||
      verifierRun.event !== "workflow_run" ||
      verifierRun.status !== "completed" ||
      verifierRun.conclusion !== "success" ||
      verifierRun.html_url !== verifierUrl ||
      text(object(verifierRun.repository).full_name) !== repository ||
      text(object(verifierRun.head_repository).full_name) !== repository ||
      verifierRun.head_branch !== "main" ||
      !verifierCommit ||
      !SHA.test(verifierCommit) ||
      verifierRun.head_sha !== verifierCommit ||
      !isCommitAncestor(root, verifierCommit, view.baseRefOid)
    )
      throw new Error("trusted verifier run provenance is invalid");
    trust.verifierRunUrl = verifierUrl;
    const artifacts = pagedObjects(
      root,
      `repos/${repository}/actions/runs/${verifierRunId}/artifacts`,
      "artifacts",
      256
    );
    const artifactName = `scwbs-workflow-integrity-v1-${triggeringRunId}`;
    const matchingArtifacts = artifacts.filter((artifact) => artifact.name === artifactName);
    if (matchingArtifacts.length !== 1) throw new Error("workflow-integrity artifact is missing or ambiguous");
    const artifact = matchingArtifacts[0]!;
    if (
      artifact.expired !== false ||
      typeof artifact.size_in_bytes !== "number" ||
      !Number.isInteger(artifact.size_in_bytes) ||
      artifact.size_in_bytes <= 0 ||
      artifact.size_in_bytes > 32 * 1024 ||
      !artifact.workflow_run ||
      Number(object(artifact.workflow_run).id) !== verifierRunId ||
      !validDigest(artifact.digest)
    )
      throw new Error("workflow-integrity artifact is expired, oversized, or untrusted");
    const artifactId = Number(artifact.id);
    if (!Number.isInteger(artifactId) || artifactId <= 0) throw new Error("workflow-integrity artifact id is invalid");
    const artifactBytes = downloadReceipt(
      root,
      repository,
      artifactId,
      artifactName,
      artifact.digest,
      artifact.size_in_bytes
    );
    if (Buffer.from(summary, "utf8").compare(artifactBytes) !== 0)
      throw new Error("workflow-integrity check summary does not match artifact bytes");
    const receipt = object(JSON.parse(artifactBytes.toString("utf8")));
    const expectedExternalId = `scwbs.workflow-integrity.v1:${triggeringRunId}:${view.baseRefOid}:${view.headRefOid}`;
    if (
      check.status !== "completed" ||
      check.conclusion !== "success" ||
      text(object(check.app).slug) !== "github-actions" ||
      (check.head_sha !== undefined && check.head_sha !== view.headRefOid) ||
      check.details_url !== verifierUrl ||
      check.external_id !== expectedExternalId ||
      receipt.type !== "scwbs.workflow-integrity.v1" ||
      receipt.repository !== repository ||
      receipt.pullRequest !== pullRequest ||
      receipt.baseCommit !== view.baseRefOid ||
      receipt.headCommit !== view.headRefOid
    )
      throw new Error("workflow-integrity check or receipt provenance is invalid");
    const observed = object(receipt.controlSurface);
    const receiptFiles = Array.isArray(observed.controlFiles) ? observed.controlFiles.map(object) : [];
    if (
      observed.version !== "1" ||
      JSON.stringify(receiptFiles) !== JSON.stringify(observations) ||
      observed.observedDigest !== sha256Digest(Buffer.from(JSON.stringify(observations))) ||
      observed.manifestDigest !== sha256Digest(Buffer.from(JSON.stringify(CONTROL_SURFACE)))
    )
      throw new Error("workflow-integrity control observation is stale or invalid");
    const trusted = object(receipt.trustedWorkflow);
    if (trusted.path !== ".github/workflows/scwbs.yml" || !validDigest(trusted.sha256))
      throw new Error("trusted workflow receipt is invalid");
    const baseContent = object(
      api(root, `repos/${repository}/contents/.github/workflows/scwbs.yml?ref=${view.baseRefOid}`)
    );
    if (
      baseContent.encoding !== "base64" ||
      typeof baseContent.content !== "string" ||
      sha256Base64(baseContent.content) !== trusted.sha256
    )
      throw new Error("trusted workflow digest is invalid");
    const verifier = object(receipt.verifier);
    if (
      verifier.workflowPath !== ".github/workflows/scwbs-workflow-integrity.yml" ||
      verifier.runId !== verifierRunId ||
      verifier.runUrl !== verifierUrl ||
      verifier.definitionCommit !== verifierCommit ||
      !validDigest(verifier.sha256)
    )
      throw new Error("verifier receipt is invalid");
    const verifierContent = object(
      api(root, `repos/${repository}/contents/.github/workflows/scwbs-workflow-integrity.yml?ref=${verifierCommit}`)
    );
    if (
      verifierContent.encoding !== "base64" ||
      typeof verifierContent.content !== "string" ||
      sha256Base64(verifierContent.content) !== verifier.sha256
    )
      throw new Error("verifier workflow digest is invalid");
    const triggering = object(receipt.triggeringRun);
    const triggeringRun = object(api(root, `repos/${repository}/actions/runs/${triggeringRunId}`));
    const triggeringUrl = `https://github.com/${repository}/actions/runs/${triggeringRunId}`;
    if (
      triggering.id !== triggeringRunId ||
      triggering.url !== triggeringUrl ||
      triggering.workflowPath !== ".github/workflows/scwbs.yml" ||
      !text(triggering.headRepository) ||
      !text(triggering.headBranch) ||
      triggeringRun.id !== triggeringRunId ||
      triggeringRun.path !== ".github/workflows/scwbs.yml" ||
      triggeringRun.event !== "pull_request" ||
      triggeringRun.status !== "completed" ||
      triggeringRun.conclusion !== "success" ||
      triggeringRun.html_url !== triggeringUrl ||
      triggeringRun.head_sha !== view.headRefOid ||
      text(object(triggeringRun.head_repository).full_name) !== triggering.headRepository ||
      triggeringRun.head_branch !== triggering.headBranch ||
      triggering.headRepository !== before.headRepo ||
      triggering.headBranch !== before.headRef
    )
      throw new Error("workflow-integrity triggering run provenance is invalid");
    const runPulls = triggeringRun.pull_requests;
    if (!Array.isArray(runPulls)) throw new Error("workflow-integrity triggering run pull request metadata is invalid");
    if (
      runPulls.length > 0 &&
      (runPulls.length !== 1 ||
        Number(object(runPulls[0]).number) !== pullRequest ||
        Number(object(runPulls[0]).id) !== before.id)
    )
      throw new Error("workflow-integrity triggering run pull request association is invalid");
    const approvalIssues = resolveApproval(root, pullRequest, view.baseRefOid, view.headRefOid, controlFiles);
    if (approvalIssues.length > 0) return { ...trust, violations: approvalIssues };
    return {
      status: "verified",
      controlFiles,
      trustedBaseCommit: view.baseRefOid,
      verifierRunUrl: verifierUrl,
      nextAction: null,
      violations: []
    };
  } catch (error) {
    return {
      ...trust,
      violations: [violation("merge.workflowTrust.unavailable", error instanceof Error ? error.message : String(error))]
    };
  }
}

export function runMerge(
  root: string,
  pullRequest: number,
  options: {
    preflightOnly?: boolean;
    json?: boolean;
  } = {}
): number {
  const repository = githubRepository(root);
  if (!repository) {
    const report = unavailableMergeReport(pullRequest, doctorGithubHint("origin is not a GitHub repository"));
    report.execution.requested = options.preflightOnly !== true;
    emit(report, options.json ?? false);
    return 1;
  }
  const lookup = readPullRequest(root, repository, pullRequest);
  const report =
    lookup.report ??
    evaluateMergePreflight(
      pullRequest,
      lookup.view!,
      repository,
      workflowTrust(root, repository, pullRequest, lookup.view!)
    );
  report.execution.requested = options.preflightOnly !== true;
  if (report.status === "blocked") {
    emit(report, options.json ?? false);
    return 1;
  }
  if (options.preflightOnly) {
    emit(report, options.json ?? false);
    return 0;
  }

  const command = [
    "gh",
    "pr",
    "merge",
    String(pullRequest),
    "--squash",
    "--delete-branch",
    "--match-head-commit",
    report.headCommit!,
    "--repo",
    repository
  ];
  report.execution.command = command.join(" ");
  const mergeResult = spawnSync(command[0]!, command.slice(1), { cwd: root, encoding: "utf8" });
  if (mergeResult.status !== 0) {
    report.status = "blocked";
    report.violations.push({
      code: "merge.command.failed",
      message: (mergeResult.stderr || "gh pr merge failed").trim()
    });
    emit(report, options.json ?? false);
    return 1;
  }
  report.execution.executed = true;
  emit(report, options.json ?? false);
  return 0;
}
