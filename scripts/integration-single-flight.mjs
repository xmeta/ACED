import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const INVALID_LOCK_GRACE_MS = 5_000;
const DEFAULT_WAIT_POLL_MS = 250;
const DEFAULT_WAIT_REPORT_MS = 30_000;

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readState(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return undefined;
  }
}

function staleOrInvalid(lockPath, state) {
  if (state) return !processIsAlive(state.pid);
  try {
    return Date.now() - statSync(lockPath).mtimeMs >= INVALID_LOCK_GRACE_MS;
  } catch {
    return true;
  }
}

function elapsedSeconds(state, now = Date.now()) {
  const startedAt = Date.parse(state?.checkStartedAt ?? state?.startedAt ?? "");
  return Number.isFinite(startedAt) ? Math.max(0, Math.floor((now - startedAt) / 1_000)) : 0;
}

export function formatActiveIntegration(state, prefix = "integration already active", now = Date.now()) {
  if (!state) return `${prefix} state=pending`;
  return [
    prefix,
    `task=${state.taskId ?? "direct-integration"}`,
    `pid=${state.pid ?? "?"}`,
    `startedAt=${state.startedAt ?? "?"}`,
    `mode=${state.mode ?? "required-check"}`,
    `workers=${state.workers ?? "?"}`,
    `elapsed=${elapsedSeconds(state, now)}s`
  ].join(" ");
}

export function integrationLockPath(root) {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `Unable to resolve git common directory for ${root}`);
  const gitDirectory = result.stdout.trim();
  const commonDirectory = path.isAbsolute(gitDirectory) ? gitDirectory : path.resolve(root, gitDirectory);
  return path.join(commonDirectory, "scwbs-required-checks.lock");
}

function inheritedLease(lockPath, options) {
  const inheritedRunId = options.env?.SCWBS_REQUIRED_CHECK_RUN_ID;
  const inheritedLockPath = options.env?.SCWBS_REQUIRED_CHECK_LOCK_PATH;
  if (!inheritedRunId || !inheritedLockPath || path.resolve(inheritedLockPath) !== path.resolve(lockPath)) return undefined;
  const state = readState(lockPath);
  if (!state || state.runId !== inheritedRunId || state.check !== "test:integration" || !processIsAlive(state.pid)) {
    throw new Error("integration lock inheritance is invalid or stale");
  }
  const enriched = { ...state, mode: options.mode, workers: options.workers };
  writeFileSync(lockPath, `${JSON.stringify(enriched, null, 2)}\n`, "utf8");
  return { lockPath, runId: state.runId, owned: false, state: enriched };
}

function tryAcquire(lockPath, options) {
  const state = {
    runId: randomUUID(),
    pid: process.pid,
    taskId: "direct-integration",
    startedAt: new Date().toISOString(),
    check: "test:integration",
    checkIndex: 1,
    checkTotal: 1,
    checkStartedAt: new Date().toISOString(),
    mode: options.mode,
    workers: options.workers
  };
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const descriptor = openSync(lockPath, "wx");
    try {
      writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    } finally {
      closeSync(descriptor);
    }
    return { lockPath, runId: state.runId, owned: true, state };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const active = readState(lockPath);
    if (!staleOrInvalid(lockPath, active)) return { active };
    try {
      unlinkSync(lockPath);
    } catch (unlinkError) {
      if (unlinkError?.code !== "ENOENT") throw unlinkError;
    }
    return { retry: true };
  }
}

export async function acquireIntegrationRun(root, options) {
  const lockPath = options.lockPath ?? integrationLockPath(root);
  const inherited = inheritedLease(lockPath, options);
  if (inherited) return inherited;
  let lastReport = 0;
  for (;;) {
    const result = tryAcquire(lockPath, options);
    if (result.owned) return result;
    if (result.retry) continue;
    if (!options.wait) throw new Error(formatActiveIntegration(result.active));
    const now = Date.now();
    if (lastReport === 0 || now - lastReport >= (options.waitReportMs ?? DEFAULT_WAIT_REPORT_MS)) {
      options.onWait?.(formatActiveIntegration(result.active, "integration waiting", now));
      lastReport = now;
    }
    await delay(options.waitPollMs ?? DEFAULT_WAIT_POLL_MS);
  }
}

export function releaseIntegrationRun(lease) {
  if (!lease?.owned) return;
  try {
    const current = readState(lease.lockPath);
    if (current?.runId === lease.runId) unlinkSync(lease.lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function runWithIntegrationSingleFlight(root, options, action) {
  const lease = await acquireIntegrationRun(root, options);
  const signals = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map();
  for (const signal of signals) {
    const handler = () => {
      releaseIntegrationRun(lease);
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  try {
    return await action();
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    releaseIntegrationRun(lease);
  }
}
