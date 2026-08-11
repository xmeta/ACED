import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_SCHEMA = "scwbs.sdd-benchmark.manifest.v1";
export const REPORT_SCHEMA = "scwbs.sdd-benchmark.report.v1";
export const OBSERVATION_SCHEMA = "scwbs.sdd-benchmark.observation.v1";
const REQUIRED_TOOLS = ["aced", "openspec", "spec-kit", "cc-sdd"];
const REQUIRED_SCENARIOS = ["docs-only", "ordinary-feature", "dangerous-auth-config"];
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_MANIFEST = join(ROOT, "manifest.json");
const DEFAULT_OUT_DIR = join(ROOT, "reports");

function error(message) {
  return new Error(`benchmark.invalid: ${message}`);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error(`${label} must be an object`);
  return value;
}

function text(value, label, max = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw error(`${label} must be a bounded non-empty string`);
  return value;
}

function boundedText(value, label, max) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > max) throw error(`${label} exceeds ${max} bytes`);
  return value;
}

function array(value, label, max = 64) {
  if (!Array.isArray(value) || value.length > max) throw error(`${label} must be an array with at most ${max} items`);
  return value;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function readJson(filePath, label, maxBytes = 262144) {
  const raw = readFileSync(filePath);
  if (raw.byteLength > maxBytes) throw error(`${label} exceeds ${maxBytes} bytes`);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw error(`${label} is not valid JSON`);
  }
}

function validatePin(tool, index) {
  object(tool, `tools[${index}]`);
  text(tool.id, `tools[${index}].id`, 64);
  text(tool.name, `tools[${index}].name`, 128);
  text(tool.repository, `tools[${index}].repository`, 256);
  text(tool.version, `tools[${index}].version`, 128);
  if (!/^[0-9a-f]{40}$/i.test(tool.commit)) throw error(`tools[${index}].commit must be a 40-character immutable commit pin`);
  text(tool.adapter, `tools[${index}].adapter`, 64);
}

export function validateManifest(manifest) {
  object(manifest, "manifest");
  if (manifest.schemaVersion !== MANIFEST_SCHEMA) throw error(`manifest.schemaVersion must be ${MANIFEST_SCHEMA}`);
  text(manifest.suiteId, "manifest.suiteId", 128);
  text(manifest.runnerVersion, "manifest.runnerVersion", 64);
  if (manifest.mode !== "manual-or-opt-in") throw error("manifest.mode must be manual-or-opt-in");
  const tools = array(manifest.tools, "manifest.tools", 8);
  const toolIds = tools.map((tool, index) => {
    validatePin(tool, index);
    return tool.id;
  });
  for (const id of REQUIRED_TOOLS) if (!toolIds.includes(id)) throw error(`manifest.tools is missing ${id}`);
  const scenarios = array(manifest.scenarios, "manifest.scenarios", 8);
  const scenarioIds = scenarios.map((scenario, index) => {
    object(scenario, `scenarios[${index}]`);
    text(scenario.id, `scenarios[${index}].id`, 64);
    text(scenario.fixture, `scenarios[${index}].fixture`, 256);
    text(scenario.purpose, `scenarios[${index}].purpose`, 256);
    array(scenario.expectedSignals, `scenarios[${index}].expectedSignals`, 32).forEach((signal, signalIndex) => text(signal, `scenarios[${index}].expectedSignals[${signalIndex}]`, 128));
    return scenario.id;
  });
  for (const id of REQUIRED_SCENARIOS) if (!scenarioIds.includes(id)) throw error(`manifest.scenarios is missing ${id}`);
  object(manifest.limits, "manifest.limits");
  for (const key of ["maxCommandLogEntries", "maxArgCount", "maxTextBytes", "maxReportBytes"]) {
    if (!Number.isInteger(manifest.limits[key]) || manifest.limits[key] <= 0) throw error(`manifest.limits.${key} must be a positive integer`);
  }
  object(manifest.policy, "manifest.policy");
  if (manifest.policy.defaultExecution !== "plan-only" || manifest.policy.externalExecution !== "manual-or-opt-in" || manifest.policy.roadmapGeneration !== false || manifest.policy.competitorMutation !== false || manifest.policy.safetyGuaranteeClaim !== false) {
    throw error("manifest.policy must remain bounded, opt-in, non-mutating, and non-authoritative");
  }
  return manifest;
}

export function loadManifest(filePath = DEFAULT_MANIFEST) {
  const manifest = readJson(filePath, "manifest", 262144);
  validateManifest(manifest);
  return { manifest, path: resolve(filePath), digest: digest(manifest) };
}

function validateCommandLog(commands, limits, label) {
  array(commands, label, limits.maxCommandLogEntries);
  return commands.map((command, index) => {
    object(command, `${label}[${index}]`);
    const argv = array(command.argv, `${label}[${index}].argv`, limits.maxArgCount);
    argv.forEach((arg, argIndex) => text(arg, `${label}[${index}].argv[${argIndex}]`, 512));
    if (command.shell !== false) throw error(`${label}[${index}].shell must be false`);
    if (!Number.isInteger(command.exitCode)) throw error(`${label}[${index}].exitCode must be an integer`);
    if (!Number.isFinite(command.durationMs) || command.durationMs < 0) throw error(`${label}[${index}].durationMs must be non-negative`);
    return {
      argv: [...argv],
      shell: false,
      exitCode: command.exitCode,
      durationMs: command.durationMs,
      stdout: boundedText(command.stdout, `${label}[${index}].stdout`, limits.maxTextBytes),
      stderr: boundedText(command.stderr, `${label}[${index}].stderr`, limits.maxTextBytes)
    };
  });
}

function validateMetrics(metrics, label) {
  if (metrics === null || metrics === undefined) return null;
  object(metrics, label);
  for (const group of ["friction", "safety", "agentEfficiency"]) {
    if (metrics[group] !== undefined) object(metrics[group], `${label}.${group}`);
  }
  return metrics;
}

export function loadObservations(filePath, manifest) {
  const input = readJson(filePath, "observations", manifest.limits.maxReportBytes);
  object(input, "observations");
  if (input.schemaVersion !== OBSERVATION_SCHEMA) throw error(`observations.schemaVersion must be ${OBSERVATION_SCHEMA}`);
  const entries = array(input.entries, "observations.entries", manifest.limits.maxCommandLogEntries);
  const tools = new Set(manifest.tools.map((tool) => tool.id));
  const scenarios = new Set(manifest.scenarios.map((scenario) => scenario.id));
  const seen = new Set();
  return entries.map((entry, index) => {
    object(entry, `observations.entries[${index}]`);
    text(entry.toolId, `observations.entries[${index}].toolId`, 64);
    text(entry.scenarioId, `observations.entries[${index}].scenarioId`, 64);
    if (!tools.has(entry.toolId) || !scenarios.has(entry.scenarioId)) throw error(`observations.entries[${index}] references an unknown tool or scenario`);
    const key = `${entry.toolId}:${entry.scenarioId}`;
    if (seen.has(key)) throw error(`duplicate observation ${key}`);
    seen.add(key);
    if (!["PASS", "N/A", "FAIL"].includes(entry.status)) throw error(`observations.entries[${index}].status must be PASS, N/A, or FAIL`);
    const commandLog = validateCommandLog(entry.commandLog ?? [], manifest.limits, `observations.entries[${index}].commandLog`);
    const safetyViolation = entry.safetyViolation === true;
    if (safetyViolation && entry.status !== "FAIL") throw error(`safety violation ${key} must be FAIL`);
    return {
      toolId: entry.toolId,
      scenarioId: entry.scenarioId,
      status: entry.status,
      setupStatus: entry.setupStatus === "N/A" ? "N/A" : entry.setupStatus === "PASS" ? "PASS" : entry.status === "N/A" ? "N/A" : "PASS",
      safetyStatus: safetyViolation ? "FAIL" : entry.status,
      safetyViolation,
      rawMetrics: validateMetrics(entry.rawMetrics, `observations.entries[${index}].rawMetrics`),
      subjectiveScore: entry.subjectiveScore ?? null,
      commandLog,
      notes: boundedText(entry.notes, `observations.entries[${index}].notes`, manifest.limits.maxTextBytes)
    };
  });
}

function emptyObservation(toolId, scenarioId) {
  return {
    toolId,
    scenarioId,
    status: "N/A",
    setupStatus: "N/A",
    safetyStatus: "N/A",
    safetyViolation: false,
    rawMetrics: null,
    subjectiveScore: null,
    commandLog: [],
    notes: "No observation supplied; default plan-only mode does not execute external tools."
  };
}

function reportMarkdown(report) {
  const lines = [
    `# ${report.suiteId}`,
    "",
    `- Schema: ${report.schemaVersion}`,
    `- Generated: ${report.observedAt}`,
    `- Manifest digest: ${report.manifestDigest}`,
    `- Execution mode: ${report.executionMode}`,
    "",
    "This report preserves raw observations and never generates roadmap decisions.",
    "",
    "## Tool pins",
    "",
    "| Tool | Repository | Version | Commit | Adapter |",
    "| --- | --- | --- | --- | --- |",
    ...report.tools.map((tool) => `| ${tool.name} | ${tool.repository} | ${tool.version} | ${tool.commit} | ${tool.adapter} |`),
    "",
    "## Results",
    "",
    "| Scenario | Tool | Status | Setup | Safety | Commands |",
    "| --- | --- | --- | --- | ---: | ---: |",
    ...report.results.map((result) => `| ${result.scenarioId} | ${result.toolId} | ${result.status} | ${result.setupStatus} | ${result.safetyStatus} | ${result.commandLog.length} |`),
    "",
    "## Subjective scores",
    "",
    "No subjective score is inferred by the runner.",
    "",
    "## Roadmap",
    "",
    "Automatic roadmap generation: false."
  ];
  return lines.join("\n") + "\n";
}

export function buildReport(manifestRecord, observations = [], observedAt = new Date().toISOString()) {
  const observationMap = new Map(observations.map((entry) => [`${entry.toolId}:${entry.scenarioId}`, entry]));
  const results = [];
  for (const scenario of manifestRecord.manifest.scenarios) {
    for (const tool of manifestRecord.manifest.tools) {
      results.push(observationMap.get(`${tool.id}:${scenario.id}`) ?? emptyObservation(tool.id, scenario.id));
    }
  }
  const report = {
    schemaVersion: REPORT_SCHEMA,
    suiteId: manifestRecord.manifest.suiteId,
    runnerVersion: manifestRecord.manifest.runnerVersion,
    observedAt,
    executionMode: observations.length > 0 ? "manual-record" : "plan-only",
    manifestPath: manifestRecord.path,
    manifestDigest: manifestRecord.digest,
    tools: manifestRecord.manifest.tools.map(({ id, name, repository, version, commit, adapter }) => ({ id, name, repository, version, commit, adapter })),
    scenarios: manifestRecord.manifest.scenarios.map(({ id, fixture, purpose }) => ({ id, fixture, purpose })),
    results,
    subjectiveScores: results.filter((result) => result.subjectiveScore !== null).map(({ toolId, scenarioId, subjectiveScore }) => ({ toolId, scenarioId, subjectiveScore })),
    roadmap: { generated: false, reason: "Benchmark output is for human judgment only." }
  };
  const serialized = JSON.stringify(report);
  if (Buffer.byteLength(serialized, "utf8") > manifestRecord.manifest.limits.maxReportBytes) throw error("report exceeds manifest.limits.maxReportBytes");
  return report;
}

export function writeReports(report, outDir = DEFAULT_OUT_DIR) {
  const directory = resolve(outDir);
  mkdirSync(directory, { recursive: true });
  const jsonPath = join(directory, "report.json");
  const markdownPath = join(directory, "report.md");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  writeFileSync(markdownPath, reportMarkdown(report), "utf8");
  return { jsonPath, markdownPath };
}

function parseArgs(argv) {
  const options = { manifest: DEFAULT_MANIFEST, outDir: DEFAULT_OUT_DIR, observations: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") return { help: true };
    const next = argv[index + 1];
    if (["--manifest", "--out-dir", "--observations"].includes(arg)) {
      if (!next || next.startsWith("--")) throw error(`${arg} requires a value`);
      options[{ "--manifest": "manifest", "--out-dir": "outDir", "--observations": "observations" }[arg]] = next;
      index += 1;
    } else {
      throw error(`unknown option ${arg}`);
    }
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("Usage: node benchmarks/sdd/runner.mjs [--manifest path] [--out-dir path] [--observations path]");
    console.log("Default mode is plan-only; external tools are never executed by this runner.");
    return 0;
  }
  const manifestRecord = loadManifest(options.manifest);
  const observations = options.observations ? loadObservations(options.observations, manifestRecord.manifest) : [];
  const report = buildReport(manifestRecord, observations);
  const files = writeReports(report, options.outDir);
  console.log(JSON.stringify({ schemaVersion: REPORT_SCHEMA, status: "pass", executionMode: report.executionMode, manifestDigest: report.manifestDigest, results: report.results.length, files }));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 2;
  }
}
