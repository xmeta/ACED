import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { buildAiPacket } from "./ai-packet.js";
import { buildChecksRunSummary, type ChecksRunSummary } from "./checks-run.js";
import { listActiveTasks, readBlock, readTask } from "../core/contracts.js";
import { currentBranch, headCommit, workingTreeChangedFiles } from "../core/git.js";
import { matchesAny } from "../core/glob.js";
import { gitCommonDir } from "../core/required-check-run.js";
import { taskAuthorityFingerprint } from "../core/task-authority.js";
import type { TaskContract } from "../core/types.js";

export const AI_PROVIDER_CAPABILITIES = ["implement", "review", "debug", "fresh-context", "json-io"] as const;
export type AiProviderCapability = typeof AI_PROVIDER_CAPABILITIES[number];
export type AiProviderDescriptor = { id: string; capabilities: AiProviderCapability[] };
export type AiLearnedNote = {
  sourceTaskId: string;
  sourceHeadCommit: string;
  scope: string[];
  note: string;
};
type AiPlanAdapter = { command: string[]; contextId: string; freshContext: true; provider: AiProviderDescriptor };

export type AiExecutionPlan = {
  schemaVersion: "scwbs.ai-execution-plan.v1" | "scwbs.ai-execution-plan.v2";
  executionId: string;
  taskId: string;
  iteration: number;
  phase: "phase-1" | "phase-2";
  branch: string;
  expectedBranch: string;
  subjectHeadCommit: string;
  authorityFingerprint: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  humanGateRequiredPaths: string[];
  requiredChecks: string[];
  implementer: AiPlanAdapter;
  reviewer: AiPlanAdapter;
  automaticPullRequest: false;
  automaticMerge: false;
  debugger: false | AiPlanAdapter;
  maxRemediationRounds?: number;
  resumeFrom?: string;
  learnedNotes?: AiLearnedNote[];
};

export type AiAdapterResult = {
  schemaVersion: "scwbs.ai-execution-result.v1";
  role: "implementer" | "reviewer" | "debugger";
  contextId: string;
  status: "completed" | "blocked" | "manual-review-required" | "approved" | "changes-requested";
  summary: string;
  findings?: string[];
  changedFiles?: string[];
  rootCause?: string;
  category?: string;
  fixPlan?: string;
  nextAction?: string;
};

export type AiExecutionReceipt = {
  schemaVersion: "scwbs.ai-run-receipt.v1" | "scwbs.ai-run-receipt.v2";
  executionId: string;
  taskId: string;
  iteration: number;
  status: "completed" | "blocked";
  plan: AiExecutionPlan;
  implementer?: AiAdapterResult;
  checks?: ChecksRunSummary;
  reviewer?: AiAdapterResult;
  remediation?: Array<{
    round: number;
    debugger: AiAdapterResult;
    implementer: AiAdapterResult;
    checks?: ChecksRunSummary;
    reviewer?: AiAdapterResult;
  }>;
  changedFiles?: string[];
  failure?: { stage: "preflight" | "implementer" | "checks" | "reviewer"; code: string; message: string };
  receiptPath?: string;
  startedAt?: string;
  endedAt?: string;
  cost?: {
    wallTimeMilliseconds: number | null;
    agentTurns: number;
    remediationRounds: number;
    requiredChecksObserved: number;
    requiredChecksReused: number;
    requiredCheckReuseRate: number | null;
  };
};

export type AiExecuteOptions = {
  taskId: string;
  implementerCommand: string;
  reviewerCommand: string;
  baseRef?: string;
  receiptPath?: string;
  debuggerCommand?: string;
  resumeReceipt?: string;
  implementerProvider?: string;
  reviewerProvider?: string;
  debuggerProvider?: string;
  learnedNote?: string;
  json?: boolean;
};

export type AiExecutionDependencies = {
  now?: () => string;
  runChecks?: (root: string, taskId: string, baseRef: string) => ChecksRunSummary;
};

function executionId(taskId: string, now: string): string {
  return `AIR-${createHash("sha256").update(`${taskId}:${now}`).digest("hex").slice(0, 16).toUpperCase()}`;
}

function parseCommandSpec(raw: string, label: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`${label} must be a non-empty JSON command array`);
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${label} must be a JSON array such as ["node","adapter.mjs"]: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${label} must be a non-empty JSON array of command arguments`);
  }
  return value as string[];
}

function defaultProvider(role: "implementer" | "reviewer" | "debugger"): AiProviderDescriptor {
  const capability = role === "implementer" ? "implement" : role === "reviewer" ? "review" : "debug";
  return {
    id: "local-process",
    capabilities: [capability, "fresh-context", "json-io"]
  };
}

function parseProviderSpec(raw: string | undefined, role: "implementer" | "reviewer" | "debugger", label: string): AiProviderDescriptor {
  if (raw === undefined) return defaultProvider(role);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} must be a JSON provider descriptor: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value) || typeof value.id !== "string" || value.id.trim().length === 0 || !Array.isArray(value.capabilities)) {
    throw new Error(`${label} must contain a non-empty id and capabilities array`);
  }
  const capabilities = [...new Set(value.capabilities)];
  if (capabilities.some((capability) => typeof capability !== "string" || !AI_PROVIDER_CAPABILITIES.includes(capability as AiProviderCapability))) {
    throw new Error(`${label} contains an unsupported capability`);
  }
  const required = [role === "implementer" ? "implement" : role === "reviewer" ? "review" : "debug", "fresh-context", "json-io"] as const;
  if (required.some((capability) => !capabilities.includes(capability))) {
    throw new Error(`${label} must support ${required.join(", ")} for the ${role} role`);
  }
  return { id: value.id.trim(), capabilities: capabilities as AiProviderCapability[] };
}

function parseLearnedNote(raw: string | undefined): AiLearnedNote[] | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`--learned-note must be a JSON object: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)
    || typeof value.sourceTaskId !== "string"
    || !/^SCWBS-[A-Z0-9-]+$/.test(value.sourceTaskId)
    || typeof value.sourceHeadCommit !== "string"
    || !/^[0-9a-f]{40}$/i.test(value.sourceHeadCommit)
    || !Array.isArray(value.scope)
    || value.scope.length === 0
    || value.scope.length > 8
    || value.scope.some((item) => typeof item !== "string" || item.trim().length === 0 || item.length > 160)
    || typeof value.note !== "string"
    || value.note.trim().length === 0
    || value.note.length > 2000) {
    throw new Error("--learned-note requires sourceTaskId, a 40-character sourceHeadCommit, bounded scope, and a note of at most 2000 characters");
  }
  return [{
    sourceTaskId: value.sourceTaskId,
    sourceHeadCommit: value.sourceHeadCommit.toLowerCase(),
    scope: value.scope.map((item) => item.trim()),
    note: value.note.trim()
  }];
}

function safeAdapterEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.SCWBS_APPROVAL_DELEGATION_TOKEN;
  return env;
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAdapterResult(filePath: string, role: "implementer" | "reviewer" | "debugger", contextId: string): AiAdapterResult {
  if (!existsSync(filePath)) throw new Error(`${role} adapter did not write its output file`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`${role} adapter output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error(`${role} adapter output must be an object`);
  const allowedStatuses = role === "implementer"
    ? new Set(["completed", "blocked", "manual-review-required"])
    : role === "reviewer"
      ? new Set(["approved", "changes-requested", "manual-review-required"])
      : new Set(["completed", "blocked", "manual-review-required"]);
  if (value.schemaVersion !== "scwbs.ai-execution-result.v1") throw new Error(`${role} adapter output has an unsupported schemaVersion`);
  if (value.role !== role) throw new Error(`${role} adapter output role mismatch`);
  if (typeof value.status !== "string" || !allowedStatuses.has(value.status)) throw new Error(`${role} adapter output has an invalid status`);
  if (typeof value.summary !== "string" || value.summary.trim().length === 0) throw new Error(`${role} adapter output requires a non-empty summary`);
  if (value.contextId !== undefined && value.contextId !== contextId) throw new Error(`${role} adapter output contextId does not match its fresh context`);
  if (value.findings !== undefined && (!Array.isArray(value.findings) || value.findings.some((item) => typeof item !== "string"))) {
    throw new Error(`${role} adapter output findings must be a string array`);
  }
  if (value.changedFiles !== undefined && (!Array.isArray(value.changedFiles) || value.changedFiles.some((item) => typeof item !== "string"))) {
    throw new Error(`${role} adapter output changedFiles must be a string array`);
  }
  const debuggerFields = role === "debugger"
    ? ["rootCause", "category", "fixPlan", "nextAction"] as const
    : [];
  for (const field of debuggerFields) {
    if (typeof value[field] !== "string" || value[field].trim().length === 0) {
      throw new Error(`debugger adapter output requires ${field}`);
    }
  }
  return {
    schemaVersion: "scwbs.ai-execution-result.v1",
    role,
    contextId,
    status: String(value.status) as AiAdapterResult["status"],
    summary: value.summary as string,
    ...(Array.isArray(value.findings) ? { findings: value.findings as string[] } : {}),
    ...(Array.isArray(value.changedFiles) ? { changedFiles: value.changedFiles as string[] } : {}),
    ...(typeof value.rootCause === "string" ? { rootCause: value.rootCause } : {}),
    ...(typeof value.category === "string" ? { category: value.category } : {}),
    ...(typeof value.fixPlan === "string" ? { fixPlan: value.fixPlan } : {}),
    ...(typeof value.nextAction === "string" ? { nextAction: value.nextAction } : {})
  };
}

function runAdapter(root: string, command: string[], input: unknown, role: "implementer" | "reviewer" | "debugger", contextId: string, directory: string): AiAdapterResult {
  const inputPath = path.join(directory, `${role}-input.json`);
  const outputPath = path.join(directory, `${role}-output.json`);
  writeJson(inputPath, input);
  const result = spawnSync(command[0]!, [...command.slice(1), inputPath, outputPath], {
    cwd: root,
    env: { ...safeAdapterEnvironment(), SCWBS_RUNNER_ROLE: role, SCWBS_RUNNER_CONTEXT_ID: contextId },
    encoding: "utf8",
    shell: false,
    timeout: 120_000
  });
  if (result.error) throw new Error(`${role} adapter could not be spawned: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${role} adapter exited with status ${String(result.status)}${detail ? `: ${detail}` : ""}`);
  }
  return parseAdapterResult(outputPath, role, contextId);
}

function preflightTask(root: string, task: TaskContract, taskId: string, branch: string, head: string, expectedChangedFiles: string[] = []): void {
  if (branch !== task.branchName) throw new Error(`branch mismatch: expected ${task.branchName}, got ${branch}`);
  const dirty = workingTreeChangedFiles(root);
  if (dirty.length > 0 && JSON.stringify(dirty) !== JSON.stringify([...expectedChangedFiles].sort())) {
    throw new Error(`working tree must be clean or match the resume receipt scope: ${dirty.join(", ")}`);
  }
  const activeTasks = listActiveTasks(root).flatMap((entry) => entry.task ? [entry.task.id] : []);
  if (activeTasks.length !== 1 || activeTasks[0] !== taskId) {
    throw new Error(`ai execute requires exactly one active Task (${taskId}); active tasks: ${activeTasks.join(", ") || "none"}`);
  }
  const block = readBlock(root, taskId);
  if (block.block?.status === "blocked") throw new Error(`active Block prevents ai execute: ${block.block.reason}`);
  if (block.issues.some((issue) => issue.code !== "block.missing")) throw new Error(block.issues.map((issue) => issue.message).join("\n"));
  if (!head) throw new Error("HEAD is unavailable");
}

function buildPlan(root: string, task: TaskContract, options: AiExecuteOptions, now: string): AiExecutionPlan {
  const branch = currentBranch(root) ?? "";
  const subjectHeadCommit = headCommit(root) ?? "";
  const id = executionId(task.id, now);
  const implementerCommand = parseCommandSpec(options.implementerCommand, "--implementer-command");
  const reviewerCommand = parseCommandSpec(options.reviewerCommand, "--reviewer-command");
  const debuggerCommand = options.debuggerCommand === undefined
    ? undefined
    : parseCommandSpec(options.debuggerCommand, "--debugger-command");
  const learnedNotes = parseLearnedNote(options.learnedNote);
  return {
    schemaVersion: debuggerCommand ? "scwbs.ai-execution-plan.v2" : "scwbs.ai-execution-plan.v1",
    executionId: id,
    taskId: task.id,
    iteration: 1,
    phase: debuggerCommand ? "phase-2" : "phase-1",
    branch,
    expectedBranch: task.branchName ?? "",
    subjectHeadCommit,
    authorityFingerprint: taskAuthorityFingerprint(task),
    allowedPaths: [...task.allowedPaths],
    forbiddenPaths: [...task.forbiddenPaths],
    humanGateRequiredPaths: [...task.humanGateRequiredPaths],
    requiredChecks: [...task.requiredChecks],
    implementer: { command: implementerCommand, contextId: `${id}-IMPLEMENTER`, freshContext: true, provider: parseProviderSpec(options.implementerProvider, "implementer", "--implementer-provider") },
    reviewer: { command: reviewerCommand, contextId: `${id}-REVIEWER`, freshContext: true, provider: parseProviderSpec(options.reviewerProvider, "reviewer", "--reviewer-provider") },
    automaticPullRequest: false,
    automaticMerge: false,
    debugger: debuggerCommand
      ? { command: debuggerCommand, contextId: `${id}-DEBUGGER-1`, freshContext: true, provider: parseProviderSpec(options.debuggerProvider, "debugger", "--debugger-provider") }
      : false,
    ...(debuggerCommand ? { maxRemediationRounds: 2 } : {}),
    ...(options.resumeReceipt ? { resumeFrom: options.resumeReceipt } : {}),
    ...(learnedNotes ? { learnedNotes } : {})
  };
}

function receiptPath(root: string, options: AiExecuteOptions): string {
  const requested = options.receiptPath?.trim();
  if (requested) return path.isAbsolute(requested) ? requested : path.resolve(root, requested);
  const gitEntry = path.join(root, ".git");
  const commonDirectory = existsSync(gitEntry) && statSync(gitEntry).isDirectory() ? gitEntry : gitCommonDir(root);
  return path.join(commonDirectory, "scwbs-ai-execution", `${encodeURIComponent(options.taskId)}.json`);
}

function writeReceipt(receipt: AiExecutionReceipt, outputPath: string): AiExecutionReceipt {
  const endedAt = new Date().toISOString();
  const startedAt = receipt.startedAt ?? endedAt;
  const startMilliseconds = Date.parse(startedAt);
  const endMilliseconds = Date.parse(endedAt);
  const checkSummaries = [
    receipt.checks,
    ...(receipt.remediation?.map((round) => round.checks) ?? [])
  ].filter((summary): summary is ChecksRunSummary => summary !== undefined);
  const checkItems = checkSummaries.flatMap((summary) => summary.checks);
  const adapterTurns = [
    receipt.implementer,
    receipt.reviewer,
    ...(receipt.remediation?.flatMap((round) => [round.debugger, round.implementer, round.reviewer]) ?? [])
  ].filter(Boolean).length;
  const reusedChecks = checkItems.filter((check) => check.disposition === "reused").length;
  const withPath = {
    ...receipt,
    startedAt,
    endedAt,
    cost: {
      wallTimeMilliseconds: Number.isFinite(startMilliseconds) && Number.isFinite(endMilliseconds)
        ? Math.max(0, endMilliseconds - startMilliseconds)
        : null,
      agentTurns: adapterTurns,
      remediationRounds: receipt.remediation?.length ?? 0,
      requiredChecksObserved: checkItems.length,
      requiredChecksReused: reusedChecks,
      requiredCheckReuseRate: checkItems.length === 0 ? null : Number((reusedChecks / checkItems.length).toFixed(4))
    },
    receiptPath: outputPath
  };
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeJson(outputPath, withPath);
  return withPath;
}

function readResumeReceipt(root: string, requestedPath: string | undefined, task: TaskContract): AiExecutionReceipt | undefined {
  if (!requestedPath) return undefined;
  const filePath = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(root, requestedPath);
  if (!existsSync(filePath)) throw new Error(`resume receipt does not exist: ${requestedPath}`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`resume receipt is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value) || value.schemaVersion !== "scwbs.ai-run-receipt.v2" || value.taskId !== task.id || value.status !== "blocked") {
    throw new Error("resume receipt must be a blocked scwbs.ai-run-receipt.v2 for the same Task");
  }
  const receipt = value as unknown as AiExecutionReceipt;
  if (receipt.plan.subjectHeadCommit !== (headCommit(root) ?? "")) throw new Error("resume receipt subject HEAD is stale");
  if (receipt.plan.authorityFingerprint !== taskAuthorityFingerprint(task)) throw new Error("resume receipt authority fingerprint is stale");
  if (receipt.failure?.stage !== "reviewer" || !["review.not-approved", "review.remediation-limit"].includes(receipt.failure.code)) {
    throw new Error("resume is supported only after a reviewer rejection");
  }
  return receipt;
}

export function buildAiExecution(root: string, options: AiExecuteOptions, dependencies: AiExecutionDependencies = {}): AiExecutionReceipt {
  const now = dependencies.now?.() ?? new Date().toISOString();
  const { task, issues } = readTask(root, options.taskId);
  if (!task) throw new Error(issues.map((issue) => issue.message).join("\n"));
  const directory = mkdtempSync(path.join(os.tmpdir(), "scwbs-ai-execute-"));
  const id = executionId(task.id, now);
  let plan: AiExecutionPlan;
  try {
    plan = buildPlan(root, task, options, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallbackPlan = {
      schemaVersion: "scwbs.ai-execution-plan.v1" as const,
      executionId: id,
      taskId: task.id,
      iteration: 1 as const,
      phase: "phase-1" as const,
      branch: currentBranch(root) ?? "",
      expectedBranch: task.branchName ?? "",
      subjectHeadCommit: headCommit(root) ?? "",
      authorityFingerprint: taskAuthorityFingerprint(task),
      allowedPaths: [...task.allowedPaths],
      forbiddenPaths: [...task.forbiddenPaths],
      humanGateRequiredPaths: [...task.humanGateRequiredPaths],
      requiredChecks: [...task.requiredChecks],
      implementer: { command: [], contextId: `${id}-IMPLEMENTER`, freshContext: true as const, provider: defaultProvider("implementer") },
      reviewer: { command: [], contextId: `${id}-REVIEWER`, freshContext: true as const, provider: defaultProvider("reviewer") },
      automaticPullRequest: false as const,
      automaticMerge: false as const,
      debugger: false as const,
    };
    return writeReceipt({
      schemaVersion: "scwbs.ai-run-receipt.v1",
      executionId: id,
      taskId: task.id,
      iteration: 1,
      status: "blocked",
      plan: fallbackPlan,
      startedAt: now,
      failure: { stage: "preflight", code: message.includes("provider") ? "adapter.provider.unsupported" : "adapter.command.invalid", message }
    }, receiptPath(root, options));
  }

  const resumeReceipt = readResumeReceipt(root, options.resumeReceipt, task);
  if (options.resumeReceipt && !plan.debugger) {
    return writeReceipt({
      schemaVersion: "scwbs.ai-run-receipt.v2",
      executionId: plan.executionId,
      taskId: task.id,
      iteration: 1,
      status: "blocked",
      plan: { ...plan, schemaVersion: "scwbs.ai-execution-plan.v2", phase: "phase-2", debugger: false, maxRemediationRounds: 0 },
      startedAt: now,
      failure: { stage: "preflight", code: "resume.debugger.required", message: "--resume-receipt requires --debugger-command" }
    }, receiptPath(root, options));
  }
  const baseReceipt = {
    schemaVersion: plan.schemaVersion === "scwbs.ai-execution-plan.v2" ? "scwbs.ai-run-receipt.v2" as const : "scwbs.ai-run-receipt.v1" as const,
    executionId: plan.executionId,
    taskId: task.id,
    iteration: 1,
    plan,
    startedAt: now
  };
  try {
    preflightTask(root, task, task.id, plan.branch, plan.subjectHeadCommit, resumeReceipt?.changedFiles ?? []);
    const packet = buildAiPacket(root, task.id, 1, "compact");
    const implementer = runAdapter(root, plan.implementer.command, {
      schemaVersion: "scwbs.ai-execution-input.v1",
      role: "implementer",
      contextId: plan.implementer.contextId,
      provider: plan.implementer.provider,
      taskId: task.id,
      iteration: 1,
      packet,
      authority: {
        allowedPaths: plan.allowedPaths,
        forbiddenPaths: plan.forbiddenPaths,
        humanGateRequiredPaths: plan.humanGateRequiredPaths,
        requiredChecks: plan.requiredChecks,
        authorityFingerprint: plan.authorityFingerprint
      },
      learnedNotes: plan.learnedNotes ?? [],
      restrictions: ["Do not edit Task Contract authority", "Do not create Approval or Review records", "Do not commit, push, create a PR, or merge"]
    }, "implementer", plan.implementer.contextId, directory);
    if (implementer.status !== "completed") {
      return writeReceipt({ ...baseReceipt, status: "blocked", implementer, failure: { stage: "implementer", code: "implementer.not-completed", message: implementer.summary } }, receiptPath(root, options));
    }

    const changedFiles = workingTreeChangedFiles(root).sort();
    const changedTask = readTask(root, task.id).task;
    if (headCommit(root) !== plan.subjectHeadCommit) throw new Error("implementer changed HEAD; commits are forbidden during ai execute");
    if (!changedTask || taskAuthorityFingerprint(changedTask) !== plan.authorityFingerprint) throw new Error("Task authority fingerprint changed during implementer execution");
    const violations = changedFiles.filter((file) => !matchesAny(file, plan.allowedPaths) || matchesAny(file, plan.forbiddenPaths) || matchesAny(file, plan.humanGateRequiredPaths));
    if (violations.length > 0) throw new Error(`implementer changed forbidden or Human Gate paths: ${violations.join(", ")}`);

    const checks = dependencies.runChecks?.(root, task.id, options.baseRef ?? "origin/main")
      ?? buildChecksRunSummary(root, task.id, { baseRef: options.baseRef ?? "origin/main" });
    if (checks.status !== "pass") {
      return writeReceipt({ ...baseReceipt, status: "blocked", implementer, checks, changedFiles, failure: { stage: "checks", code: "required-checks.failed", message: "Required checks did not pass; reviewer dispatch was skipped." } }, receiptPath(root, options));
    }

    const diff = spawnSync("git", ["diff", "--binary", "--no-ext-diff", "origin/main"], { cwd: root, encoding: "utf8", shell: false });
    const reviewer = runAdapter(root, plan.reviewer.command, {
      schemaVersion: "scwbs.ai-execution-input.v1",
      role: "reviewer",
      contextId: plan.reviewer.contextId,
      provider: plan.reviewer.provider,
      freshContext: true,
      taskId: task.id,
      iteration: 1,
      taskPacket: packet,
      implementer: { status: implementer.status, summary: implementer.summary, findings: implementer.findings ?? [] },
      requiredChecks: checks,
      changedFiles,
      diff: diff.status === 0 ? diff.stdout : "",
      learnedNotes: plan.learnedNotes ?? [],
      restrictions: ["Review only; do not edit files", "Do not create Approval or Review records", "Do not commit, push, create a PR, or merge"]
    }, "reviewer", plan.reviewer.contextId, directory);
    const afterReviewFiles = workingTreeChangedFiles(root).sort();
    if (headCommit(root) !== plan.subjectHeadCommit || JSON.stringify(afterReviewFiles) !== JSON.stringify(changedFiles)) {
      throw new Error("reviewer changed repository state; reviewer must be read-only");
    }
    if (reviewer.status !== "approved") {
      if (reviewer.status === "changes-requested" && plan.debugger) {
        const remediation: NonNullable<AiExecutionReceipt["remediation"]> = [];
        let currentReviewer = reviewer;
        let currentChangedFiles = changedFiles;
        let currentChecks = checks;
        for (let round = 1; round <= (plan.maxRemediationRounds ?? 0); round += 1) {
          const debuggerResult = runAdapter(root, plan.debugger.command, {
            schemaVersion: "scwbs.ai-execution-input.v1",
            role: "debugger",
            contextId: `${plan.executionId}-DEBUGGER-${round}`,
            provider: plan.debugger.provider,
            freshContext: true,
            taskId: task.id,
            iteration: round + 1,
            failure: { stage: "reviewer", status: currentReviewer.status, summary: currentReviewer.summary, findings: currentReviewer.findings ?? [] },
            changedFiles: currentChangedFiles,
            learnedNotes: plan.learnedNotes ?? [],
            restrictions: ["Return diagnosis only", "Do not edit files", "Do not create Approval or Review records", "Do not commit, push, create a PR, or merge"]
          }, "debugger", `${plan.executionId}-DEBUGGER-${round}`, directory);
          if (debuggerResult.status !== "completed") {
            return writeReceipt({ ...baseReceipt, schemaVersion: "scwbs.ai-run-receipt.v2", status: "blocked", implementer, checks, reviewer: currentReviewer, changedFiles: currentChangedFiles, remediation, failure: { stage: "reviewer", code: "debugger.not-completed", message: debuggerResult.summary } }, receiptPath(root, options));
          }

          const remediationImplementer = runAdapter(root, plan.implementer.command, {
            schemaVersion: "scwbs.ai-execution-input.v1",
            role: "implementer",
            contextId: `${plan.executionId}-REMEDIATION-${round}`,
            provider: plan.implementer.provider,
            freshContext: true,
            taskId: task.id,
            iteration: round + 1,
            taskPacket: packet,
            debugger: debuggerResult,
            authority: {
              allowedPaths: plan.allowedPaths,
              forbiddenPaths: plan.forbiddenPaths,
              humanGateRequiredPaths: plan.humanGateRequiredPaths,
              requiredChecks: plan.requiredChecks,
              authorityFingerprint: plan.authorityFingerprint
            },
            learnedNotes: plan.learnedNotes ?? [],
            restrictions: ["Edit only allowed implementation paths", "Do not edit Task Contract authority", "Do not create Approval or Review records", "Do not commit, push, create a PR, or merge"]
          }, "implementer", `${plan.executionId}-REMEDIATION-${round}`, directory);
          if (remediationImplementer.status !== "completed") {
            return writeReceipt({ ...baseReceipt, schemaVersion: "scwbs.ai-run-receipt.v2", status: "blocked", implementer, checks, reviewer: currentReviewer, changedFiles: currentChangedFiles, remediation: [...remediation, { round, debugger: debuggerResult, implementer: remediationImplementer }], failure: { stage: "implementer", code: "remediation.not-completed", message: remediationImplementer.summary } }, receiptPath(root, options));
          }
          currentChangedFiles = workingTreeChangedFiles(root).sort();
          const violations = currentChangedFiles.filter((file) => !matchesAny(file, plan.allowedPaths) || matchesAny(file, plan.forbiddenPaths) || matchesAny(file, plan.humanGateRequiredPaths));
          if (headCommit(root) !== plan.subjectHeadCommit || violations.length > 0 || taskAuthorityFingerprint(readTask(root, task.id).task ?? task) !== plan.authorityFingerprint) {
            throw new Error("remediation changed HEAD, authority, forbidden, or Human Gate scope");
          }
          currentChecks = dependencies.runChecks?.(root, task.id, options.baseRef ?? "origin/main")
            ?? buildChecksRunSummary(root, task.id, { baseRef: options.baseRef ?? "origin/main" });
          if (currentChecks.status !== "pass") {
            return writeReceipt({ ...baseReceipt, schemaVersion: "scwbs.ai-run-receipt.v2", status: "blocked", implementer, checks: currentChecks, reviewer: currentReviewer, changedFiles: currentChangedFiles, remediation: [...remediation, { round, debugger: debuggerResult, implementer: remediationImplementer, checks: currentChecks }], failure: { stage: "checks", code: "remediation-checks.failed", message: "Remediation checks did not pass; reviewer dispatch was skipped." } }, receiptPath(root, options));
          }
          const remediationDiff = spawnSync("git", ["diff", "--binary", "--no-ext-diff", "origin/main"], { cwd: root, encoding: "utf8", shell: false });
          currentReviewer = runAdapter(root, plan.reviewer.command, {
            schemaVersion: "scwbs.ai-execution-input.v1",
            role: "reviewer",
            contextId: `${plan.executionId}-REVIEWER-${round + 1}`,
            provider: plan.reviewer.provider,
            freshContext: true,
            taskId: task.id,
            iteration: round + 1,
            taskPacket: packet,
            implementer: { status: remediationImplementer.status, summary: remediationImplementer.summary, findings: remediationImplementer.findings ?? [] },
            debugger: debuggerResult,
            requiredChecks: currentChecks,
            changedFiles: currentChangedFiles,
            learnedNotes: plan.learnedNotes ?? [],
            diff: remediationDiff.status === 0 ? remediationDiff.stdout : "",
            restrictions: ["Review only; do not edit files", "Do not create Approval or Review records", "Do not commit, push, create a PR, or merge"]
          }, "reviewer", `${plan.executionId}-REVIEWER-${round + 1}`, directory);
          if (headCommit(root) !== plan.subjectHeadCommit || JSON.stringify(workingTreeChangedFiles(root).sort()) !== JSON.stringify(currentChangedFiles)) {
            throw new Error("remediation reviewer changed repository state");
          }
          remediation.push({ round, debugger: debuggerResult, implementer: remediationImplementer, checks: currentChecks, reviewer: currentReviewer });
          if (currentReviewer.status === "approved") {
            return writeReceipt({ ...baseReceipt, schemaVersion: "scwbs.ai-run-receipt.v2", iteration: round + 1, status: "completed", implementer, checks: currentChecks, reviewer: currentReviewer, changedFiles: currentChangedFiles, remediation }, receiptPath(root, options));
          }
        }
        return writeReceipt({ ...baseReceipt, schemaVersion: "scwbs.ai-run-receipt.v2", status: "blocked", implementer, checks: currentChecks, reviewer: currentReviewer, changedFiles: currentChangedFiles, remediation, failure: { stage: "reviewer", code: "review.remediation-limit", message: `Reviewer did not approve after ${plan.maxRemediationRounds ?? 0} remediation rounds` } }, receiptPath(root, options));
      }
      return writeReceipt({ ...baseReceipt, status: "blocked", implementer, checks, reviewer, changedFiles, failure: { stage: "reviewer", code: "review.not-approved", message: reviewer.summary } }, receiptPath(root, options));
    }
    return writeReceipt({ ...baseReceipt, status: "completed", implementer, checks, reviewer, changedFiles }, receiptPath(root, options));
  } catch (error) {
    return writeReceipt({ ...baseReceipt, status: "blocked", failure: { stage: "preflight", code: "execution.fail-closed", message: error instanceof Error ? error.message : String(error) } }, receiptPath(root, options));
  }
}

export function buildAiRunPlan(root: string, taskId: string, agent = "codex"): string {
  const { task, issues } = readTask(root, taskId);
  if (!task) throw new Error(issues.map((issue) => issue.message).join("\n"));
  return `SC-WBS AI Run (dry-run)

Task: ${task.id}
Agent: ${agent}

Before implementation:
- npm run scwbs -- check
- npm run scwbs -- check-diff --task ${task.id}
- npm run scwbs -- ai packet --task ${task.id} --format ${agent === "codex" ? "codex" : "compact"}

Implementation:
- Give the AI Work Packet to ${agent}
- Stop on forbidden paths, Human Gate paths, DB/API/auth/security/business-rule changes, or unclear scope

After implementation:
- npm run scwbs -- check-diff --task ${task.id}
${task.requiredChecks.map((check) => `- npm ${check === "test" ? "test" : `run ${check}`}`).join("\n")}
- npm run scwbs -- evidence collect --task ${task.id} --force

Packet preview:
${buildAiPacket(root, taskId, 1, agent === "codex" ? "codex" : "compact")}
`;
}

export function runAiRun(root: string, taskId: string, agent?: string): number {
  try {
    process.stdout.write(buildAiRunPlan(root, taskId, agent));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function runAiExecute(root: string, options: AiExecuteOptions): number {
  try {
    const receipt = buildAiExecution(root, options);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return receipt.status === "completed" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
