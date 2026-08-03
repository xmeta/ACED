import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export type RequiredCheckRunState = {
  runId: string;
  pid: number;
  taskId: string;
  startedAt: string;
  check?: string;
  checkIndex?: number;
  checkTotal?: number;
  checkStartedAt?: string;
  mode?: string;
  workers?: number;
};

export type RequiredCheckRunLease = {
  root: string;
  lockPath: string;
  state: RequiredCheckRunState;
};

const invalidLockGraceMs = 5_000;
// Required checks normally finish within hours; a full day keeps recovery conservative.
const maximumLockAgeMs = 24 * 60 * 60 * 1_000;

export function gitCommonDir(root: string): string {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `Unable to resolve git common directory for ${root}`);
  const value = result.stdout.trim();
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

export function requiredCheckLockPath(root: string): string {
  return path.join(gitCommonDir(root), "scwbs-required-checks.lock");
}

function commandLockPath(root: string): string {
  return path.join(gitCommonDir(root), "scwbs-command.lock");
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readState(lockPath: string): RequiredCheckRunState | undefined {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) as RequiredCheckRunState;
  } catch {
    return undefined;
  }
}

function staleOrInvalid(lockPath: string, state: RequiredCheckRunState | undefined): boolean {
  if (state) {
    if (!processIsAlive(state.pid)) return true;
    const startedAt = Date.parse(state.startedAt);
    return Number.isFinite(startedAt) && Date.now() - startedAt >= maximumLockAgeMs;
  }
  try {
    return Date.now() - statSync(lockPath).mtimeMs >= invalidLockGraceMs;
  } catch {
    return true;
  }
}

function activeRunMessage(state: RequiredCheckRunState | undefined): string {
  if (!state) return "required checks are locked by another process whose state is still being written";
  const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(state.checkStartedAt ?? state.startedAt)) / 1000));
  const current = state.check
    ? ` check=${state.checkIndex ?? "?"}/${state.checkTotal ?? "?"}:${state.check}`
    : "";
  const mode = state.mode ? ` mode=${state.mode}` : "";
  const workers = state.workers ? ` workers=${state.workers}` : "";
  return `required checks already active task=${state.taskId}${current} pid=${state.pid} startedAt=${state.startedAt}${mode}${workers} elapsed=${elapsed}s`;
}

export function requiredCheckChildEnv(lease: RequiredCheckRunLease): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SCWBS_REQUIRED_CHECK_RUN_ID: lease.state.runId,
    SCWBS_REQUIRED_CHECK_LOCK_PATH: lease.lockPath
  };
}

export function acquireRequiredCheckRun(root: string, taskId: string, checkTotal: number): RequiredCheckRunLease {
  const lockPath = requiredCheckLockPath(root);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state: RequiredCheckRunState = {
      runId: randomUUID(),
      pid: process.pid,
      taskId,
      startedAt: new Date().toISOString(),
      checkTotal
    };
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        fstatSync(fd);
      } finally {
        closeSync(fd);
      }
      return { root, lockPath, state };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const active = readState(lockPath);
      if (!staleOrInvalid(lockPath, active)) throw new Error(activeRunMessage(active));
      try {
        unlinkSync(lockPath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new Error("Unable to acquire required-check single-flight lock");
}

function updateCommandLock(root: string, state: RequiredCheckRunState): void {
  const lockPath = process.env.SCWBS_COMMAND_LOCK_PATH ?? commandLockPath(root);
  if (!existsSync(lockPath)) return;
  try {
    const current = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    const ownerPid = Number(process.env.SCWBS_COMMAND_LOCK_OWNER_PID ?? process.pid);
    if (current.pid !== ownerPid) return;
    writeFileSync(lockPath, `${JSON.stringify({
      ...current,
      taskId: state.taskId,
      check: state.check,
      checkIndex: state.checkIndex,
      checkTotal: state.checkTotal,
      checkStartedAt: state.checkStartedAt
    }, null, 2)}\n`, "utf8");
  } catch {
    // Progress enrichment must never invalidate the command-level lock.
  }
}

export function updateRequiredCheckRun(lease: RequiredCheckRunLease, check: string, checkIndex: number): void {
  lease.state = {
    ...lease.state,
    check,
    checkIndex,
    checkStartedAt: new Date().toISOString()
  };
  writeFileSync(lease.lockPath, `${JSON.stringify(lease.state, null, 2)}\n`, "utf8");
  updateCommandLock(lease.root, lease.state);
}

export function releaseRequiredCheckRun(lease: RequiredCheckRunLease): void {
  try {
    const current = readState(lease.lockPath);
    if (current?.runId === lease.state.runId) unlinkSync(lease.lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function formatRequiredCheckProgress(
  state: RequiredCheckRunState,
  status: "executed" | "running" | "cache-hit" | "passed" | "failed",
  now = Date.now()
): string {
  const elapsed = Math.max(0, Math.floor((now - Date.parse(state.checkStartedAt ?? state.startedAt)) / 1000));
  return `scwbs progress task=${state.taskId} check=${state.checkIndex ?? "?"}/${state.checkTotal ?? "?"}:${state.check ?? "(pending)"} status=${status} elapsed=${elapsed}s pid=${state.pid} startedAt=${state.startedAt}`;
}

export function heartbeatScript(): string {
  return `
const interval = Number(process.env.SCWBS_HEARTBEAT_INTERVAL_MS || "30000");
const started = Number(process.env.SCWBS_CHECK_STARTED_MS || Date.now());
const parentPid = Number(process.env.SCWBS_PARENT_PID || process.ppid);
const line = () => {
  try { process.kill(parentPid, 0); } catch { process.exit(0); }
  const elapsed = Math.max(0, Math.floor((Date.now() - started) / 1000));
  process.stderr.write("scwbs progress task=" + process.env.SCWBS_TASK_ID
    + " check=" + process.env.SCWBS_CHECK_INDEX + "/" + process.env.SCWBS_CHECK_TOTAL + ":" + process.env.SCWBS_CHECK_NAME
    + " status=running elapsed=" + elapsed + "s pid=" + parentPid + " startedAt=" + process.env.SCWBS_RUN_STARTED_AT + "\\n");
};
setInterval(line, interval);
`;
}

export function startRequiredCheckHeartbeat(lease: RequiredCheckRunLease): ChildProcess | undefined {
  const interval = Number(process.env.SCWBS_HEARTBEAT_INTERVAL_MS ?? "30000");
  if (!Number.isFinite(interval) || interval <= 0 || !lease.state.check || !lease.state.checkStartedAt) return undefined;
  const child = spawn(process.execPath, ["-e", heartbeatScript()], {
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      SCWBS_HEARTBEAT_INTERVAL_MS: String(interval),
      SCWBS_CHECK_STARTED_MS: String(Date.parse(lease.state.checkStartedAt)),
      SCWBS_PARENT_PID: String(process.pid),
      SCWBS_TASK_ID: lease.state.taskId,
      SCWBS_CHECK_INDEX: String(lease.state.checkIndex ?? "?"),
      SCWBS_CHECK_TOTAL: String(lease.state.checkTotal ?? "?"),
      SCWBS_CHECK_NAME: lease.state.check,
      SCWBS_RUN_STARTED_AT: lease.state.startedAt
    }
  });
  child.unref();
  return child;
}

export function stopRequiredCheckHeartbeat(child: ChildProcess | undefined): void {
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
}
