#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildVitestArgs,
  defaultWorkerCount,
  formatSummary,
  normalizeReport,
  parseArgs as parseRunnerArgs
} from "./integration-test-run.mjs";
import { runWithIntegrationSingleFlight } from "./integration-single-flight.mjs";

export const FAILURE_LIMIT = 5;
export const DIAGNOSTIC_EDGE_BYTES = 2_000;
export const DIAGNOSTIC_CAPTURE_BYTES = DIAGNOSTIC_EDGE_BYTES * 2;

export function parseArgs(argv, env = process.env) {
  const verbose = argv.includes("--verbose");
  const wait = argv.includes("--wait");
  const runnerArgs = argv.filter((argument) => argument !== "--verbose" && argument !== "--wait");
  const options = parseRunnerArgs(runnerArgs, env);
  if (verbose && options.reportPath) throw new Error("--verbose cannot be combined with --report");
  return { ...options, verbose, wait };
}

function createBoundedCapture() {
  let totalBytes = 0;
  let complete = Buffer.alloc(0);
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  return {
    add(chunk) {
      const value = Buffer.from(chunk);
      totalBytes += value.length;
      if (complete.length < DIAGNOSTIC_CAPTURE_BYTES) {
        complete = Buffer.concat([complete, value]).subarray(0, DIAGNOSTIC_CAPTURE_BYTES);
      }
      if (head.length < DIAGNOSTIC_EDGE_BYTES) {
        head = Buffer.concat([head, value]).subarray(0, DIAGNOSTIC_EDGE_BYTES);
      }
      tail = Buffer.concat([tail, value]).subarray(-DIAGNOSTIC_EDGE_BYTES);
    },
    value() {
      if (totalBytes <= DIAGNOSTIC_CAPTURE_BYTES) return { totalBytes, text: complete.toString("utf8") };
      return {
        totalBytes,
        text: `${head.toString("utf8")}\n... ${totalBytes - head.length - tail.length} bytes omitted ...\n${tail.toString("utf8")}`
      };
    }
  };
}

function compactReason(value) {
  const normalized = String(value || "No failure message reported").replace(/\s+/g, " ").trim();
  return normalized.length <= 1_000 ? normalized : `${normalized.slice(0, 997)}...`;
}

function rerunCommand(file, name) {
  return `npx vitest run ${file} --pool=forks --maxWorkers=1 --testTimeout=10000 -t ${JSON.stringify(name)}`;
}

export function formatFailureDiagnostics(raw, stdout, stderr) {
  const failures = raw.testResults.flatMap((result) => result.assertionResults
    .filter((test) => test.status === "failed")
    .map((test) => ({
      file: path.relative(process.cwd(), result.name).split(path.sep).join("/"),
      name: test.fullName,
      reason: compactReason(test.failureMessages?.[0])
    })));
  const lines = [];
  for (const failure of failures.slice(0, FAILURE_LIMIT)) {
    lines.push(`failed test=${failure.file} :: ${failure.name}`);
    lines.push(`cause=${failure.reason}`);
    lines.push(`rerun=${rerunCommand(failure.file, failure.name)}`);
  }
  if (failures.length > FAILURE_LIMIT) lines.push(`failed tests omitted=${failures.length - FAILURE_LIMIT}`);
  if (stdout.text.trim()) lines.push(`stdout bytes=${stdout.totalBytes}\n${stdout.text.trimEnd()}`);
  if (stderr.text.trim()) lines.push(`stderr bytes=${stderr.totalBytes}\n${stderr.text.trimEnd()}`);
  return lines.join("\n");
}

async function runCaptured(args) {
  const stdout = createBoundedCapture();
  const stderr = createBoundedCapture();
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

async function runVerbose(workers) {
  const args = [
    path.join("node_modules", "vitest", "vitest.mjs"),
    "run",
    "tests/integration",
    `--maxWorkers=${workers}`,
    "--pool=forks",
    "--fileParallelism",
    "--testTimeout=10000",
    "--reporter=verbose"
  ];
  const child = spawn(process.execPath, args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  try {
    return await runWithIntegrationSingleFlight(process.cwd(), {
      mode: options.verbose ? "verbose" : "default",
      workers: options.workers,
      wait: options.wait,
      env: process.env,
      onWait: (message) => console.error(message)
    }, async () => {
      if (options.verbose) return runVerbose(options.workers);

      const directory = await mkdtemp(path.join(tmpdir(), "scwbs-integration-output-"));
      const rawOutputFile = path.join(directory, "vitest.json");
      try {
        const execution = await runCaptured(buildVitestArgs({ workers: options.workers, outputFile: rawOutputFile }));
        let raw;
        try {
          raw = JSON.parse(await readFile(rawOutputFile, "utf8"));
        } catch (error) {
          console.error(`FAIL integration report unavailable: ${error instanceof Error ? error.message : String(error)}`);
          if (execution.stdout.text.trim()) console.error(`stdout bytes=${execution.stdout.totalBytes}\n${execution.stdout.text}`);
          if (execution.stderr.text.trim()) console.error(`stderr bytes=${execution.stderr.totalBytes}\n${execution.stderr.text}`);
          return execution.exitCode || 1;
        }

        const report = normalizeReport(raw, execution.wallDurationMs, options.workers);
        const summary = formatSummary(report, options.slowest);
        (report.success ? console.log : console.error)(summary);
        if (options.reportPath) {
          const destination = path.resolve(options.reportPath);
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, "utf8");
          console.log(`duration report: ${path.relative(process.cwd(), destination) || destination}`);
        }
        if (!report.success || execution.exitCode !== 0) {
          const diagnostics = formatFailureDiagnostics(raw, execution.stdout, execution.stderr);
          if (diagnostics) console.error(diagnostics);
        }
        return execution.exitCode;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectExecution) process.exitCode = await main();
