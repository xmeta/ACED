#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const args = process.argv.slice(2);
const waitTimeoutMs = Number(process.env.SCWBS_COMMAND_LOCK_TIMEOUT_MS ?? "600000");
const invalidLockGraceMs = 5_000;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function gitCommonDir() {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "Unable to resolve git common directory");
  const value = result.stdout.trim();
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readState(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return undefined;
  }
}

function activeDescription(state) {
  if (!state) return "state=pending";
  const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(state.checkStartedAt ?? state.startedAt)) / 1000));
  const check = state.check ? ` check=${state.checkIndex ?? "?"}/${state.checkTotal ?? "?"}:${state.check}` : "";
  return `pid=${state.pid} command=${state.command ?? "scwbs"}${check} startedAt=${state.startedAt} elapsed=${elapsed}s`;
}

function acquireCommandLock() {
  const commonDir = gitCommonDir();
  mkdirSync(commonDir, { recursive: true });
  const lockPath = path.join(commonDir, "scwbs-command.lock");
  const startedWaitingAt = Date.now();
  let lastNoticeAt = 0;
  while (Date.now() - startedWaitingAt < waitTimeoutMs) {
    const state = {
      runId: randomUUID(),
      pid: process.pid,
      command: `scwbs ${args.join(" ")}`.trim(),
      startedAt: new Date().toISOString(),
      phase: "build"
    };
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
      return { lockPath, state };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const active = readState(lockPath);
      let stale = active ? !processIsAlive(active.pid) : false;
      if (!active) {
        try {
          stale = Date.now() - statSync(lockPath).mtimeMs >= invalidLockGraceMs;
        } catch {
          stale = true;
        }
      }
      if (stale) {
        try { unlinkSync(lockPath); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
        continue;
      }
      if (lastNoticeAt === 0 || Date.now() - lastNoticeAt >= 30_000) {
        process.stderr.write(`scwbs waiting for active command ${activeDescription(active)}\n`);
        lastNoticeAt = Date.now();
      }
      Atomics.wait(waitBuffer, 0, 0, 100);
    }
  }
  throw new Error(`Timed out waiting for scwbs command lock after ${waitTimeoutMs}ms`);
}

function updateLease(lease, patch) {
  lease.state = { ...lease.state, ...patch };
  writeFileSync(lease.lockPath, `${JSON.stringify(lease.state, null, 2)}\n`, "utf8");
}

function releaseLease(lease) {
  try {
    const current = readState(lease.lockPath);
    if (current?.runId === lease.state.runId) unlinkSync(lease.lockPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

let lease;
try {
  lease = acquireCommandLock();
  let buildStatus = 0;
  if (process.env.SCWBS_SKIP_BUILD_FOR_TESTS !== "1") {
    const tsc = process.platform === "win32"
      ? path.join(root, "node_modules", ".bin", "tsc.cmd")
      : path.join(root, "node_modules", ".bin", "tsc");
    const build = spawnSync(tsc, ["-p", "tsconfig.json"], {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32"
    });
    buildStatus = build.status ?? 1;
  }
  if (buildStatus !== 0) process.exitCode = buildStatus;
  else {
    updateLease(lease, { phase: "cli" });
    const cliEntry = process.env.SCWBS_CLI_ENTRY_FOR_TESTS ?? path.join(root, "dist", "cli.js");
    const cli = spawnSync(process.execPath, [cliEntry, ...args], {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        SCWBS_COMMAND_LOCK_PATH: lease.lockPath,
        SCWBS_COMMAND_LOCK_OWNER_PID: String(process.pid)
      }
    });
    process.exitCode = cli.status ?? 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (lease) releaseLease(lease);
}
