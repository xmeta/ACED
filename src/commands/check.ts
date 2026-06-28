import { existsSync } from "node:fs";
import { approvalExists, evidenceExists, listApprovals, listSpecs, listTasks, matchingRegistrySpecByPath, readEvidence, readRegistry, readSpecFromRegistryContract, resolveSpecForTask } from "../core/contracts.js";
import { changedFiles } from "../core/git.js";
import { fileSha256 } from "../core/hash.js";
import { defaultWbsPath, resolveFrom } from "../core/paths.js";
import { hasErrors, printIssues } from "../core/report.js";
import type { Evidence, Issue, Registry, RegistryContract, SpecContract, TaskContract, WbsDocument } from "../core/types.js";
import { findNode, isDoneNode, readWbs, runWjsValidate, validateWbsDocument } from "../core/wbs.js";

function validateRequiredChecks(task: TaskContract, evidence?: Evidence): Issue[] {
  if (!evidence) return [];
  const evidenceChecks = new Set(evidence.checks.map((check) => check.name));
  return task.requiredChecks
    .filter((check) => !evidenceChecks.has(check))
    .map((check) => ({
      severity: "error" as const,
      code: "evidence.check.missing",
      message: `${task.id} evidence is missing required check: ${check}`
    }));
}

function validateRegistrySpecContract(contract: RegistryContract, spec: SpecContract): Issue[] {
  const issues: Issue[] = [];
  if (contract.id !== spec.id) {
    issues.push({ severity: "error", code: "registry.spec.id", message: `${contract.path} id does not match registry entry ${contract.id}` });
  }
  if (contract.featureId && contract.featureId !== spec.featureId) {
    issues.push({ severity: "error", code: "registry.spec.featureId", message: `${contract.id} featureId does not match ${contract.path}` });
  }
  if (contract.status && contract.status !== spec.status) {
    issues.push({ severity: "error", code: "registry.spec.status", message: `${contract.id} status does not match ${contract.path}` });
  }
  if (contract.version && contract.version !== spec.version) {
    issues.push({ severity: "error", code: "registry.spec.version", message: `${contract.id} version does not match ${contract.path}` });
  }
  return issues;
}

function validateContractLock(root: string, task: TaskContract, spec?: SpecContract, specPath?: string): Issue[] {
  const issues: Issue[] = [];
  if (!task.contractLock) return issues;

  if (task.contractLock.wbsNodeId && task.contractLock.wbsNodeId !== task.wbsNodeId) {
    issues.push({
      severity: "error",
      code: "task.contractLock.wbsNodeId",
      message: `${task.id} contractLock.wbsNodeId does not match wbsNodeId`
    });
  }

  const wbsRevision = fileSha256(root, defaultWbsPath);
  if (task.contractLock.wbsRevision && task.contractLock.wbsRevision !== wbsRevision) {
    issues.push({
      severity: "error",
      code: "task.contractLock.wbsRevision",
      message: `${task.id} contractLock.wbsRevision is stale: ${task.contractLock.wbsRevision} != ${wbsRevision}`
    });
  }

  if ((task.contractLock.specVersion || task.contractLock.specRevision) && (!spec || !specPath)) {
    issues.push({
      severity: "error",
      code: "task.spec.missing",
      message: `${task.id} contractLock references a spec but no matching spec contract was resolved`
    });
    return issues;
  }

  if (task.contractLock.specVersion && spec?.version && task.contractLock.specVersion !== spec.version) {
    issues.push({
      severity: "error",
      code: "task.contractLock.specVersion",
      message: `${task.id} contractLock.specVersion is stale: ${task.contractLock.specVersion} != ${spec.version}`
    });
  }
  if (task.contractLock.specRevision && specPath && task.contractLock.specRevision !== fileSha256(root, specPath)) {
    issues.push({
      severity: "error",
      code: "task.contractLock.specRevision",
      message: `${task.id} contractLock.specRevision is stale`
    });
  }

  return issues;
}

function validateTaskAgainstWbs(root: string, specIssues: Issue[], wbs: WbsDocument, task: TaskContract, spec?: SpecContract, specPath?: string): Issue[] {
  const issues: Issue[] = [];
  const node = findNode(wbs, task.wbsNodeId);
  if (!node) {
    issues.push({ severity: "error", code: "task.wbsNodeId", message: `${task.id} references missing WBS node: ${task.wbsNodeId}` });
    return issues;
  }
  issues.push(...specIssues);
  issues.push(...validateContractLock(root, task, spec, specPath));

  const done = isDoneNode(node);
  const hasEvidence = evidenceExists(root, task.id);
  if (done && !hasEvidence) {
    issues.push({ severity: "error", code: "evidence.missing", message: `${task.id} is done but evidence is missing` });
  }

  if (hasEvidence) {
    const { evidence, issues: evidenceIssues } = readEvidence(root, task.id);
    issues.push(...evidenceIssues);
    issues.push(...validateRequiredChecks(task, evidence));
  }

  if (task.humanGateRequiredPaths.length > 0 && done && !approvalExists(root, task.id)) {
    issues.push({ severity: "warn", code: "approval.missing", message: `${task.id} touches human gate paths but no approval record was found` });
  }

  return issues;
}

function validateRegistryContracts(root: string, registry: Registry | undefined): Issue[] {
  const issues: Issue[] = [];
  if (!registry) return issues;
  for (const contract of registry.contracts) {
    if (!existsSync(resolveFrom(root, contract.path))) {
      issues.push({ severity: "error", code: "registry.path", message: `${contract.id} path does not exist: ${contract.path}` });
      continue;
    }
    if (contract.type !== "spec") continue;
    const { spec, issues: specIssues } = readSpecFromRegistryContract(root, contract);
    issues.push(...specIssues);
    if (spec) issues.push(...validateRegistrySpecContract(contract, spec));
  }
  return issues;
}

function validateIndexedSpecs(root: string, registry: Registry | undefined): Issue[] {
  const issues: Issue[] = [];
  for (const entry of listSpecs(root)) {
    issues.push(...entry.issues);
    if (!entry.spec) continue;
    const registryContract = matchingRegistrySpecByPath(registry, entry.path);
    if (!registryContract) {
      issues.push({
        severity: "error",
        code: "spec.registry.missing",
        message: `${entry.path} is not indexed by contracts/registry.yaml`
      });
    }
  }
  return issues;
}

export function collectWbsChangesetGateIssues(files: string[]): Issue[] {
  const issues: Issue[] = [];
  const changesWbs = files.some((file) => file.replace(/\\/g, "/") === "contracts/wbs/project.wbs.json");
  if (!changesWbs) return issues;
  const hasWbsChangeSet = files.some((file) => /^contracts\/changesets\/.+\.json$/.test(file.replace(/\\/g, "/")));
  if (!hasWbsChangeSet) {
    issues.push({
      severity: "error",
      code: "wbs.changeset.required",
      message: "contracts/wbs/project.wbs.json was modified without a corresponding contracts/changesets/*.json; run scwbs wbs apply instead of editing the WBS directly"
    });
  }
  return issues;
}

export function collectCheckIssues(root: string): Issue[] {
  const issues: Issue[] = [];
  issues.push(...runWjsValidate(root));
  if (issues.some((item) => item.code === "wjs.validate")) return issues;
  issues.push(...validateWbsDocument(root));

  let wbs: WbsDocument | undefined;
  try {
    wbs = readWbs(root);
  } catch (error) {
    issues.push({ severity: "error", code: "wbs.read", message: error instanceof Error ? error.message : String(error) });
  }

  const { registry, issues: registryIssues } = readRegistry(root);
  issues.push(...registryIssues);
  issues.push(...validateRegistryContracts(root, registry));
  issues.push(...validateIndexedSpecs(root, registry));
  for (const entry of listApprovals(root)) {
    issues.push(...entry.issues);
  }

  for (const entry of listTasks(root)) {
    issues.push(...entry.issues);
    if (!wbs || !entry.task) continue;
    const { spec, path: specPath, issues: specIssues } = resolveSpecForTask(root, registry, entry.task);
    if (spec && spec.status !== "approved") {
      specIssues.push({ severity: "error", code: "task.spec.status", message: `${entry.task.id} references non-approved spec ${spec.id}` });
    }
    issues.push(...validateTaskAgainstWbs(root, specIssues, wbs, entry.task, spec, specPath));
  }

  let changed: string[] = [];
  try {
    changed = changedFiles(root);
  } catch {
    // not in a git repo or git unavailable: skip changeset gate
  }
  issues.push(...collectWbsChangesetGateIssues(changed));

  return issues;
}

export function runCheck(root: string): number {
  const issues = collectCheckIssues(root);
  if (issues.length === 0) {
    console.log("PASS scwbs check");
    return 0;
  }
  printIssues(issues);
  return hasErrors(issues) ? 1 : 0;
}
