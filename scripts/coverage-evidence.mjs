import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const WORKFLOW_PATH = ".github/workflows/scwbs.yml";
const SCHEMA_VERSION = "1.0.0";
const METRIC_NAMES = ["statements", "branches", "functions", "lines"];

function usage() {
  return [
    "Usage: node scripts/coverage-evidence.mjs [options]",
    "  --coverage-summary <path>  Vitest json-summary coverage file",
    "  --test-results <path>      Vitest json reporter output",
    "  --output <path>            Coverage receipt output",
    "  --snapshot <path>          Evidence snapshot output",
    "  --task-id <id>             SC-WBS Task ID (optional on main push)",
    "  --pull-request <number>    Pull request number (optional on main push)",
    "  --help                     Show this help"
  ].join("\n");
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (!argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function requiredNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
  return value;
}

function metricFromSummary(summary, name) {
  const value = summary?.total?.[name];
  if (!value || typeof value !== "object") throw new Error(`coverage summary is missing total.${name}`);
  return {
    total: requiredNumber(value.total, `total.${name}.total`),
    covered: requiredNumber(value.covered, `total.${name}.covered`),
    skipped: requiredNumber(value.skipped ?? 0, `total.${name}.skipped`),
    percent: requiredNumber(value.pct, `total.${name}.pct`)
  };
}

function testCounts(results) {
  const tests = {
    total: requiredNumber(results?.numTotalTests, "numTotalTests"),
    passed: requiredNumber(results?.numPassedTests, "numPassedTests"),
    failed: requiredNumber(results?.numFailedTests, "numFailedTests"),
    skipped: requiredNumber((results?.numPendingTests ?? 0) + (results?.numTodoTests ?? 0), "skipped tests")
  };
  const testFiles = {
    total: requiredNumber(results?.numTotalTestSuites, "numTotalTestSuites"),
    passed: requiredNumber(results?.numPassedTestSuites, "numPassedTestSuites"),
    failed: requiredNumber(results?.numFailedTestSuites, "numFailedTestSuites"),
    skipped: requiredNumber(
      (results?.numPendingTestSuites ?? 0) + (results?.numTodoTestSuites ?? 0),
      "skipped test files"
    )
  };
  if (tests.passed + tests.failed + tests.skipped !== tests.total) {
    throw new Error("test result counts do not add up to numTotalTests");
  }
  if (testFiles.passed + testFiles.failed + testFiles.skipped > testFiles.total) {
    throw new Error("test file result counts exceed numTotalTestSuites");
  }
  return { testFiles, tests };
}

function skippedTests(results) {
  const entries = [];
  for (const testFile of results?.testResults ?? []) {
    for (const assertion of testFile.assertionResults ?? []) {
      if (assertion.status === "passed") continue;
      const status = assertion.status ?? "skipped";
      entries.push({
        name: assertion.fullName ?? assertion.title ?? "unknown test",
        reason:
          status === "todo"
            ? "todo test"
            : status === "failed"
              ? "failed test"
              : "excluded or skipped by test selection"
      });
    }
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function repositoryFromEnvironment(env) {
  const repository = env.GITHUB_REPOSITORY;
  if (repository) return repository;
  return undefined;
}

function taskIdFromEnvironment(env) {
  if (env.SCWBS_TASK_ID) return env.SCWBS_TASK_ID;
  const branch = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || "";
  return branch.match(/(SCWBS-[A-Z0-9]+)/)?.[1];
}

function pullRequestFromEnvironment(env) {
  if (env.SCWBS_PULL_REQUEST) return env.SCWBS_PULL_REQUEST.replace(/^#/, "");
  return undefined;
}

export function buildCoverageReceipt({
  coverageSummary,
  testResults,
  environment = process.env,
  command = "npm run test:coverage:all",
  scope = "unit-and-integration"
}) {
  const counts = testCounts(testResults);
  const receipt = {
    schemaVersion: SCHEMA_VERSION,
    command,
    scope,
    ...(repositoryFromEnvironment(environment) ? { repository: repositoryFromEnvironment(environment) } : {}),
    ...(taskIdFromEnvironment(environment) ? { taskId: taskIdFromEnvironment(environment) } : {}),
    ...(pullRequestFromEnvironment(environment) ? { pullRequest: pullRequestFromEnvironment(environment) } : {}),
    subjectHeadCommit: environment.SCWBS_SUBJECT_HEAD || environment.GITHUB_SHA || "",
    workflowPath: WORKFLOW_PATH,
    workflowRunId: environment.GITHUB_RUN_ID || "",
    workflowRunUrl:
      environment.SCWBS_WORKFLOW_RUN_URL ||
      (environment.GITHUB_SERVER_URL && environment.GITHUB_REPOSITORY && environment.GITHUB_RUN_ID
        ? `${environment.GITHUB_SERVER_URL}/${environment.GITHUB_REPOSITORY}/actions/runs/${environment.GITHUB_RUN_ID}`
        : ""),
    artifactName: environment.SCWBS_ARTIFACT_NAME || "",
    testFiles: counts.testFiles,
    tests: counts.tests,
    metrics: Object.fromEntries(METRIC_NAMES.map((name) => [name, metricFromSummary(coverageSummary, name)])),
    skippedTests: skippedTests(testResults),
    generatedAt: environment.SCWBS_GENERATED_AT || new Date().toISOString()
  };
  const requiredProvenance = ["subjectHeadCommit", "workflowRunId", "workflowRunUrl", "artifactName"];
  const missing = requiredProvenance.filter((key) => !receipt[key]);
  if (missing.length > 0) throw new Error(`coverage receipt provenance is incomplete: ${missing.join(", ")}`);
  const payload = JSON.stringify({ coverageSummary, testResults });
  return { ...receipt, payloadDigest: sha256(payload) };
}

export function buildEvidenceSnapshot(receipt) {
  return {
    schemaVersion: SCHEMA_VERSION,
    type: "evidence-snapshot",
    taskId: receipt.taskId ?? null,
    subjectHeadCommit: receipt.subjectHeadCommit,
    pullRequest: receipt.pullRequest ?? null,
    coverageReceipt: receipt
  };
}

export function createCoverageEvidence({
  coverageSummaryPath,
  testResultsPath,
  outputPath,
  snapshotPath,
  environment = process.env
}) {
  const coverageSummary = readJson(coverageSummaryPath, "coverage summary");
  const testResults = readJson(testResultsPath, "test results");
  const receipt = buildCoverageReceipt({ coverageSummary, testResults, environment });
  const snapshot = buildEvidenceSnapshot(receipt);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  mkdirSync(path.dirname(snapshotPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return { receipt, snapshot };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    const coverageSummaryPath = options["coverage-summary"] || "coverage/coverage-summary.json";
    const testResultsPath = options["test-results"] || "coverage/test-results.json";
    const outputPath = options.output || "coverage/coverage-receipt.json";
    const snapshotPath = options.snapshot || "coverage/evidence-snapshot.json";
    const environment = {
      ...process.env,
      ...(options["task-id"] ? { SCWBS_TASK_ID: options["task-id"] } : {}),
      ...(options["pull-request"] ? { SCWBS_PULL_REQUEST: options["pull-request"] } : {})
    };
    createCoverageEvidence({ coverageSummaryPath, testResultsPath, outputPath, snapshotPath, environment });
    console.log(`coverage receipt written to ${outputPath}`);
    console.log(`Evidence snapshot written to ${snapshotPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
