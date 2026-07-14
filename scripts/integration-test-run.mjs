#!/usr/bin/env node

import { spawn } from "node:child_process";
import { availableParallelism, tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SLOWEST_COUNT = 5;
export const MIN_PARALLEL_WORKERS = 2;
export const MAX_PARALLEL_WORKERS = 4;
export const OUTPUT_CAPTURE_BYTES = 8_000;
export const OUTPUT_EDGE_BYTES = OUTPUT_CAPTURE_BYTES / 2;

// These files contain tests that must remain serial within their worker because
// they mutate process-global state. Vitest's fork-per-file isolation makes the
// files themselves safe to schedule in parallel.
export const SERIAL_WITHIN_FILE = Object.freeze({
  "tests/integration/tasks.test.ts": "process.chdir",
  "tests/integration/approval.test.ts": "process.env",
  "tests/integration/review.test.ts": "process.env and stdout/stderr",
  "tests/integration/ai.test.ts": "process.stdout",
  "tests/integration/check.test.ts": "console",
  "tests/integration/doctor.test.ts": "console",
  "tests/integration/evidence.test.ts": "stdout/stderr",
  "tests/integration/finish.test.ts": "stdout/stderr",
  "tests/integration/health.test.ts": "console",
  "tests/integration/misc.test.ts": "stdout/stderr",
  "tests/integration/check-diff.test.ts": "console"
});

export function defaultWorkerCount() {
  return Math.max(MIN_PARALLEL_WORKERS, Math.min(MAX_PARALLEL_WORKERS, availableParallelism()));
}

export function parseArgs(argv, env = process.env) {
  let workers = Number(env.SCWBS_INTEGRATION_WORKERS || defaultWorkerCount());
  let slowest = DEFAULT_SLOWEST_COUNT;
  let reportPath;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--workers") workers = Number(argv[++index]);
    else if (argument === "--slowest") slowest = Number(argv[++index]);
    else if (argument === "--report") reportPath = argv[++index];
    else throw new Error(`Unknown integration runner option: ${argument}`);
  }

  if (!Number.isInteger(workers) || workers < MIN_PARALLEL_WORKERS || workers > MAX_PARALLEL_WORKERS) {
    throw new Error(`--workers must be an integer between ${MIN_PARALLEL_WORKERS} and ${MAX_PARALLEL_WORKERS}`);
  }
  if (!Number.isInteger(slowest) || slowest < 0 || slowest > 20) {
    throw new Error("--slowest must be an integer between 0 and 20");
  }
  if (reportPath === undefined && argv.includes("--report")) {
    throw new Error("--report requires a path");
  }
  return { workers, slowest, reportPath };
}

export function buildVitestArgs({ workers, outputFile }) {
  return [
    path.join("node_modules", "vitest", "vitest.mjs"),
    "run",
    "tests/integration",
    `--maxWorkers=${workers}`,
    "--pool=forks",
    "--fileParallelism",
    "--testTimeout=10000",
    "--reporter=json",
    `--outputFile=${outputFile}`
  ];
}

function captureEdge() {
  let totalBytes = 0;
  let complete = Buffer.alloc(0);
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  return {
    add(chunk) {
      const value = Buffer.from(chunk);
      totalBytes += value.length;
      if (complete.length < OUTPUT_CAPTURE_BYTES) {
        complete = Buffer.concat([complete, value]).subarray(0, OUTPUT_CAPTURE_BYTES);
      }
      if (head.length < OUTPUT_EDGE_BYTES) {
        head = Buffer.concat([head, value]).subarray(0, OUTPUT_EDGE_BYTES);
      }
      tail = Buffer.concat([tail, value]).subarray(-OUTPUT_EDGE_BYTES);
    },
    value() {
      const truncated = totalBytes > OUTPUT_CAPTURE_BYTES;
      return {
        totalBytes,
        text: truncated
          ? `${head.toString("utf8")}\n... ${totalBytes - head.length - tail.length} bytes omitted ...\n${tail.toString("utf8")}`
          : complete.toString("utf8")
      };
    }
  };
}

export function normalizeReport(raw, wallDurationMs, workers) {
  const files = raw.testResults.map((result) => ({
    file: path.relative(process.cwd(), result.name).split(path.sep).join("/"),
    status: result.status,
    durationMs: Math.max(0, Math.round(result.endTime - result.startTime)),
    tests: result.assertionResults.length
  })).sort((left, right) => right.durationMs - left.durationMs || left.file.localeCompare(right.file));

  const tests = raw.testResults.flatMap((result) => result.assertionResults.map((test) => ({
    file: path.relative(process.cwd(), result.name).split(path.sep).join("/"),
    name: test.fullName,
    status: test.status,
    durationMs: Math.max(0, Math.round(test.duration || 0))
  }))).sort((left, right) => right.durationMs - left.durationMs || left.name.localeCompare(right.name));

  return {
    schemaVersion: "1",
    success: raw.success,
    workers,
    wallDurationMs: Math.round(wallDurationMs),
    counts: {
      files: raw.testResults.length,
      tests: raw.numTotalTests,
      passed: raw.numPassedTests,
      failed: raw.numFailedTests,
      skipped: raw.numPendingTests + raw.numTodoTests
    },
    files,
    tests
  };
}

export function formatSummary(report, slowest = DEFAULT_SLOWEST_COUNT) {
  const status = report.success ? "PASS" : "FAIL";
  const lines = [
    `${status} integration files=${report.counts.files} tests=${report.counts.tests} passed=${report.counts.passed} failed=${report.counts.failed} skipped=${report.counts.skipped} workers=${report.workers} duration=${(report.wallDurationMs / 1000).toFixed(2)}s`
  ];
  for (const file of report.files.slice(0, slowest)) {
    lines.push(`slow file=${file.file} duration=${(file.durationMs / 1000).toFixed(2)}s tests=${file.tests}`);
  }
  for (const test of report.tests.slice(0, slowest)) {
    lines.push(`slow test=${test.file} :: ${test.name} duration=${(test.durationMs / 1000).toFixed(2)}s`);
  }
  return lines.join("\n");
}

async function runVitest(args) {
  const stdout = captureEdge();
  const stderr = captureEdge();
  const startedAt = performance.now();
  const child = spawn(process.execPath, args, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => stdout.add(chunk));
  child.stderr.on("data", (chunk) => stderr.add(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  return { exitCode, wallDurationMs: performance.now() - startedAt, stdout: stdout.value(), stderr: stderr.value() };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "scwbs-integration-"));
  const rawOutputFile = path.join(temporaryDirectory, "vitest.json");

  try {
    const execution = await runVitest(buildVitestArgs({ workers: options.workers, outputFile: rawOutputFile }));
    let raw;
    try {
      raw = JSON.parse(await readFile(rawOutputFile, "utf8"));
    } catch (error) {
      console.error(`FAIL integration report unavailable: ${error instanceof Error ? error.message : String(error)}`);
      if (execution.stdout.text.trim()) console.error(`stdout (${execution.stdout.totalBytes} bytes):\n${execution.stdout.text}`);
      if (execution.stderr.text.trim()) console.error(`stderr (${execution.stderr.totalBytes} bytes):\n${execution.stderr.text}`);
      return execution.exitCode || 1;
    }

    const report = normalizeReport(raw, execution.wallDurationMs, options.workers);
    console.log(formatSummary(report, options.slowest));
    if (options.reportPath) {
      const destination = path.resolve(options.reportPath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.log(`duration report: ${path.relative(process.cwd(), destination) || destination}`);
    }
    if (!report.success || execution.exitCode !== 0) {
      if (execution.stdout.text.trim()) console.error(`stdout (${execution.stdout.totalBytes} bytes):\n${execution.stdout.text}`);
      if (execution.stderr.text.trim()) console.error(`stderr (${execution.stderr.totalBytes} bytes):\n${execution.stderr.text}`);
    }
    return execution.exitCode;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectExecution) {
  process.exitCode = await main();
}
