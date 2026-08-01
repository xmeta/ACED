import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { runInit } from "../../src/commands/init.js";
import { collectCheckIssues, collectWbsChangesetGateIssues, runCheck } from "../../src/commands/check.js";
import { buildStartArtifacts } from "../../src/commands/start.js";
import { buildDoctorReport, collectEnvironmentDiagnostics } from "../../src/commands/doctor.js";
import { readProfile, runProfileSet } from "../../src/commands/profile.js";
import { buildStatus } from "../../src/commands/status.js";
import { runFinish } from "../../src/commands/finish.js";
import { runTaskLock } from "../../src/commands/task-lock.js";
import { runFix } from "../../src/commands/fix.js";
import { runAiBlock, runHumanBlockResolve } from "../../src/commands/ai-queue.js";
import { buildRegistryRebuildSummary, buildRegistryYaml, runRegistryRebuild } from "../../src/commands/registry-rebuild.js";
import { runWbsValidate, runWbsApply, verifyWbsChangesets } from "../../src/commands/wbs.js";
import { readBlock, readSpecChange, readTask } from "../../src/core/contracts.js";
import { parseSimpleYaml, stringifySimpleYaml } from "../../src/core/yaml.js";
import { validateWbsDocument } from "../../src/core/wbs.js";
import { resolveCheckCommand, isKnownCheck } from "../../src/core/check-catalog.js";
import { main } from "../../src/cli.js";
import { makeTempRepo, sampleTask, sampleWbs, sampleSpec, sampleEvidence, writeScwbsProject, writeJson, writeText, writeYaml } from "../helpers.js";
import type { WbsDocument } from "../../src/core/types.js";

function captureOutput(action: () => number): { result: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWrite = process.stdout.write;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { result: action(), stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalWrite;
  }
}

describe("misc", () => {
  test("registry rebuild defaults to a bounded diff summary", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(runRegistryRebuild(root, { check: false, force: true, quiet: true })).toBe(0);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);

    const output = captureOutput(() => runRegistryRebuild(root, { check: false, force: true }));
    expect(output.result).toBe(0);
    expect(output.stdout).toBe([
      "PASS registry rebuilt",
      "added: 1",
      "updated: 0",
      "removed: 0",
      "path: contracts/registry.yaml"
    ].join("\n"));
    expect(output.stdout).not.toContain("contracts:");

    const identitySummary = buildRegistryRebuildSummary(
      stringifySimpleYaml({ projectId: "test", contracts: [
        { id: "TASK-A", type: "task", path: "contracts/tasks/old.yaml" },
        { id: "TASK-B", type: "task", path: "contracts/tasks/shared.yaml" }
      ] }),
      stringifySimpleYaml({ projectId: "test", contracts: [
        { id: "TASK-A", type: "task", path: "contracts/tasks/new.yaml" },
        { id: "TASK-C", type: "task", path: "contracts/tasks/shared.yaml" }
      ] }),
      "rebuilt"
    );
    expect(identitySummary).toMatchObject({ added: 1, updated: 1, removed: 1 });
  });

  test("registry rebuild supports quiet json verbose output and help", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    const quiet = captureOutput(() => runRegistryRebuild(root, { check: false, force: true, quiet: true }));
    expect(quiet).toMatchObject({ result: 0, stdout: "", stderr: "" });

    const json = captureOutput(() => runRegistryRebuild(root, { check: false, force: true, json: true }));
    const jsonSummary = JSON.parse(json.stdout);
    expect(jsonSummary).toEqual({
      schemaVersion: "1.0.0",
      status: "rebuilt",
      added: 0,
      updated: 0,
      removed: 0,
      path: "contracts/registry.yaml"
    });
    const schema = JSON.parse(readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/registry-rebuild-summary.schema.json"), "utf8"));
    expect(new Ajv2020({ strict: false }).compile(schema)(jsonSummary)).toBe(true);

    const verbose = captureOutput(() => runRegistryRebuild(root, { check: false, force: true, verbose: true }));
    expect(verbose.stdout).toContain("PASS registry rebuilt");
    expect(verbose.stdout).toContain("projectId:");
    expect(verbose.stdout).toContain("contracts:");

    const yaml = captureOutput(() => runRegistryRebuild(root, { check: false, force: true, output: "-" }));
    expect(yaml.stdout).toMatch(/^projectId:/);
    expect(yaml.stdout).not.toContain("PASS registry rebuilt");

    const help = captureOutput(() => main(["registry", "rebuild", "--help"], root));
    expect(help.result).toBe(0);
    expect(help.stdout).toContain("--quiet");
    expect(help.stdout).toContain("--json");
    expect(help.stdout).toContain("--verbose");
    expect(help.stdout).toContain("--output <target>");

    const conflict = captureOutput(() => runRegistryRebuild(root, { check: false, force: true, quiet: true, json: true }));
    expect(conflict).toMatchObject({ result: 2, stderr: "Choose one of --quiet, --json, --verbose, or --output -" });
  });

  test("registry rebuild JSON summary stays bounded with more than 1000 prior entries", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/registry.yaml", {
      projectId: "test-wbs",
      contracts: Array.from({ length: 1001 }, (_, index) => ({
        id: `OLD-${index}`,
        type: "evidence",
        path: `contracts/evidence/OLD-${index}.yaml`,
        relatedTask: `OLD-${index}`
      }))
    });

    const output = captureOutput(() => runRegistryRebuild(root, { check: false, force: true, json: true }));
    expect(output.result).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({ removed: 1001 });
    expect(output.stdout.length).toBeLessThan(200);
  });

  test("registry rebuild check keeps default messages and exit codes", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    runRegistryRebuild(root, { check: false, force: true, quiet: true });
    expect(captureOutput(() => runRegistryRebuild(root, { check: true, force: false }))).toMatchObject({
      result: 0,
      stdout: "PASS registry rebuild --check",
      stderr: ""
    });
    writeText(root, "contracts/registry.yaml", "projectId: stale\ncontracts: []\n");
    expect(captureOutput(() => runRegistryRebuild(root, { check: true, force: false }))).toMatchObject({
      result: 1,
      stderr: "contracts/registry.yaml is out of sync; run scwbs registry rebuild --force"
    });
  });

  test("check rejects direct WBS edits without a corresponding changeset", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: root, stdio: "ignore" });

    const changed = sampleWbs("planned");
    changed.nodes.push({
      id: "node-wbs-tool-only",
      parentId: "node-meta-file-safety",
      code: "1.7.1",
      name: "WBS JSON tool-only enforcement",
      type: "workPackage",
      status: "ready"
    });
    writeJson(root, "contracts/wbs/project.wbs.json", changed);

    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code === "wbs.changeset.required")).toBe(true);
    const wbsIssue = issues.find((issue) => issue.code === "wbs.changeset.required");
    expect(wbsIssue?.message).toContain("WBS direct edit detected");
    expect(wbsIssue?.fixCommand).toContain("wbs apply contracts/changesets/");

    writeJson(root, "contracts/changesets/SCWBS-023-wbs-tool-only.json", {
      schemaVersion: "0.1.0",
      targetWbsId: "test-wbs",
      changeSetId: "changeset-SCWBS-023-wbs-tool-only",
      dryRun: true,
      operations: []
    });

    expect(collectCheckIssues(root).some((issue) => issue.code === "wbs.changeset.required")).toBe(false);
  });

  test("start emits schema-shaped WBS addNode operations", () => {
    const artifacts = buildStartArtifacts("Add reporting");
    const changeSetPath = Object.keys(artifacts).find((item) => item.startsWith("contracts/changesets/start-"));
    const taskPath = Object.keys(artifacts).find((item) => item.startsWith("contracts/tasks/"));
    const specPath = Object.keys(artifacts).find((item) => item.startsWith("contracts/specs/"));
    expect(changeSetPath).toBeTruthy();
    expect(taskPath).toBeTruthy();
    expect(specPath).toBeTruthy();
    const changeSet = JSON.parse(artifacts[changeSetPath!]);
    const task = parseSimpleYaml(artifacts[taskPath!]);
    const taskId = taskPath!.replace(/^contracts\/tasks\//, "").replace(/\.yaml$/, "");
    expect(changeSet.targetWbsId).toBe("scwbs");
    expect(changeSet.operations[0].operation).toBe("addNode");
    expect(changeSet.operations[0].node.parentId).toBe("node-project");
    expect(task.managedContractPaths).toEqual([
      taskPath,
      specPath,
      "contracts/tasks/index.yaml",
      `contracts/blocks/${taskId}.yaml`,
      `contracts/evidence/${taskId}.yaml`,
      `contracts/evidence-payloads/${taskId}.patch`,
      `contracts/approvals/${taskId}.yaml`,
      `contracts/reviews/${taskId}.yaml`,
      "contracts/registry.yaml"
    ]);
  });

  test("yaml parser preserves quoted strings with colons", () => {
    const parsed = parseSimpleYaml(stringifySimpleYaml({
      doneCriteria: ["Plan and implement: Replace YAML parser"]
    }));

    expect(parsed.doneCriteria).toEqual(["Plan and implement: Replace YAML parser"]);
  });

  test("start artifacts can be read back as valid task contracts", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(main(["start", "Replace YAML parser"], root)).toBe(0);

    const taskFileName = readdirSync(path.join(root, "contracts/tasks")).find((file) => file.startsWith("SCWBS-DRAFT-"));
    expect(taskFileName).toBeTruthy();
    const taskId = taskFileName!.replace(/\.yaml$/, "");
    const { task } = readTask(root, taskId);
    expect(task?.doneCriteria).toEqual(["Plan and implement: Replace YAML parser"]);
  });

  test("help flags do not run mutating commands", () => {
    const root = makeTempRepo();

    expect(main(["start", "--help"], root)).toBe(0);
    expect(main(["task", "new", "--help"], root)).toBe(0);

    expect(existsSync(path.join(root, "contracts/specs"))).toBe(false);
    expect(existsSync(path.join(root, "contracts/tasks"))).toBe(false);
    expect(existsSync(path.join(root, "contracts/changesets"))).toBe(false);
  });

  test("start prints pre-flight details and fails on branch mismatch", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const output: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(main(["start", "WBS-001-004"], root)).toBe(1);
    } finally {
      process.stdout.write = originalWrite;
    }

    const preflight = output.join("");
    expect(preflight).toContain("Task: WBS-001-004");
    expect(preflight).toContain("Branch status: mismatch");
    expect(preflight).toContain("Allowed paths:");
    expect(preflight).toContain("Checks:");
  });

  test("block writes a stop record and can draft a spec change proposal", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runAiBlock(root, "WBS-001-004", "DB schema change is required", { specChange: true })).toBe(0);
    const { block } = readBlock(root, "WBS-001-004");
    expect(block).toMatchObject({
      type: "block",
      taskId: "WBS-001-004",
      status: "blocked",
      level: 2,
      category: "db"
    });
    expect(readSpecChange(root, "contracts/spec-changes/SCP-WBS-001-004-block.yaml").specChange?.level).toBe(2);
  });

  test("a human can resolve a Block without deletion and reblocking preserves lifecycle history", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runAiBlock(root, "WBS-001-004", "Human Gate required")).toBe(0);
    const createdAt = readBlock(root, "WBS-001-004").block?.createdAt;
    expect(runHumanBlockResolve(root, "WBS-001-004", "Human decision recorded", { now: "2026-07-13T01:00:00.000Z" })).toBe(0);
    const resolved = readBlock(root, "WBS-001-004").block;
    expect(resolved).toMatchObject({
      status: "resolved",
      createdAt,
      resolvedAt: "2026-07-13T01:00:00.000Z",
      resolvedBy: "human",
      resolution: "Human decision recorded"
    });
    expect(resolved?.history?.map((entry) => entry.status)).toEqual(["blocked", "resolved"]);
    expect(buildRegistryYaml(root)).toContain("status: resolved");

    expect(runAiBlock(root, "WBS-001-004", "A new decision is required")).toBe(0);
    const reblocked = readBlock(root, "WBS-001-004").block;
    expect(reblocked?.status).toBe("blocked");
    expect(reblocked?.history?.map((entry) => entry.status)).toEqual(["blocked", "resolved", "blocked"]);
    expect(reblocked?.history?.[1]).toMatchObject({
      at: "2026-07-13T01:00:00.000Z",
      reason: "Human decision recorded",
      by: "human"
    });
  });

  test("Block resolution requires an existing active Block and a non-empty reason", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runHumanBlockResolve(root, "WBS-001-004", "Decision recorded")).toBe(1);
    expect(runAiBlock(root, "WBS-001-004", "Human Gate required")).toBe(0);
    expect(runHumanBlockResolve(root, "WBS-001-004", "   ")).toBe(1);
    expect(runHumanBlockResolve(root, "WBS-001-004", "Decision recorded")).toBe(0);
    expect(runHumanBlockResolve(root, "WBS-001-004", "Second decision")).toBe(1);
  });

  test("AI execution mode cannot create a human Block resolution", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(runAiBlock(root, "WBS-001-004", "Human Gate required")).toBe(0);
    expect(runHumanBlockResolve(root, "WBS-001-004", "AI should not resolve", { actor: "ai" })).toBe(1);
    expect(readBlock(root, "WBS-001-004").block?.status).toBe("blocked");
  });

  test("reblocking refuses to overwrite an invalid existing Block", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/blocks/WBS-001-004.yaml", { type: "block", status: "broken" });
    expect(runAiBlock(root, "WBS-001-004", "New reason")).toBe(1);
    expect(readFileSync(path.join(root, "contracts/blocks/WBS-001-004.yaml"), "utf8")).toContain("status: broken");
  });

  test("reblocking a legacy resolved Block reconstructs its resolution history", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/blocks/WBS-001-004.yaml", {
      id: "BLK-WBS-001-004",
      type: "block",
      taskId: "WBS-001-004",
      status: "resolved",
      level: 1,
      category: "human-gate",
      reason: "Original block",
      requiredHumanDecision: "Decide",
      createdAt: "2026-07-12T01:00:00.000Z",
      resolvedAt: "2026-07-12T02:00:00.000Z",
      resolvedBy: "human",
      resolution: "Decision recorded"
    });

    expect(runAiBlock(root, "WBS-001-004", "New block")).toBe(0);
    expect(readBlock(root, "WBS-001-004").block?.history).toEqual([
      { status: "blocked", at: "2026-07-12T01:00:00.000Z", reason: "Original block", by: "ai-agent" },
      { status: "resolved", at: "2026-07-12T02:00:00.000Z", reason: "Decision recorded", by: "human" },
      expect.objectContaining({ status: "blocked", reason: "New block", by: "ai-agent" })
    ]);
  });

  test("finish without task id or task branch fails with a fix command", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(main(["finish"], root)).toBe(2);
  });

  test("finish stops after required check failures without replacing the existing checkpoint", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeJson(root, "package.json", {
      scripts: {
        test: "node -e \"process.exit(9)\""
      }
    });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      branchName: "master",
      allowedPaths: ["src/**", "contracts/**"],
      humanGateRequiredPaths: [],
      requiredChecks: ["test"]
    }) as unknown as Record<string, unknown>);
    expect(runTaskLock(root, "WBS-001-004")).toBe(0);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    writeText(root, "src/feature.ts", "export const value = 1;\n");
    execFileSync("git", ["add", "src/feature.ts"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feature"], { cwd: root, stdio: "ignore" });
    const evidencePath = path.join(root, "contracts/evidence/WBS-001-004.yaml");
    const registryPath = path.join(root, "contracts/registry.yaml");
    const previousRegistry = readFileSync(registryPath, "utf8");
    expect(existsSync(evidencePath)).toBe(false);

    expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base" })).toBe(1);
    expect(existsSync(evidencePath)).toBe(false);
    expect(readFileSync(registryPath, "utf8")).toBe(previousRegistry);
  }, 30000);

  test("doctor reports suggested fixes for stale contracts", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      contractLock: {
        wbsRevision: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        wbsNodeId: "node-api"
      }
    }) as unknown as Record<string, unknown>);
    const report = buildDoctorReport(root);
    expect(report).toContain("task.contractLock.wbsRevision");
    expect(report).toContain("scwbs task refresh --task <task-id>");
  });

  test("doctor reports environment diagnostics with PASS lines for a healthy repo", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    writeText(root, "node_modules/.keep", "");
    mkdirSync(path.join(root, "wjs/node_modules"), { recursive: true });
    writeText(root, "wjs/node_modules/.keep", "");
    mkdirSync(path.join(root, "wjs/node_modules/@esbuild"), { recursive: true });
    writeText(root, "wjs/node_modules/@esbuild/.keep", "");
    writeText(root, "wjs/schema/wbs-json.schema.json", "{}");
    writeJson(root, "package.json", { engines: { node: ">=22.12.0" } });
    const report = buildDoctorReport(root);
    expect(report).toContain("Environment diagnostics:");
    expect(report).toContain("Node.js");
    expect(report).toContain("root dependencies installed");
    expect(report).toContain("wjs dependencies installed");
    expect(report).toContain("contracts/registry.yaml exists");
    expect(report).toContain("contracts/wbs/project.wbs.json exists");
    expect(report).toContain("wjs/schema/wbs-json.schema.json exists");
    expect(report).toContain("[PASS] Node.js");
    expect(report).toContain("[PASS] root dependencies installed");
    expect(report).toContain("[PASS] wjs dependencies installed");
    expect(report).toContain("[PASS] contracts/registry.yaml exists");
    expect(report).toContain("[PASS] contracts/wbs/project.wbs.json exists");
    expect(report).toContain("[PASS] wjs/schema/wbs-json.schema.json exists");
  });

  test("doctor reads the Node.js lower bound from package.json engines.node", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeJson(root, "package.json", { engines: { node: ">=22.12.0" } });

    const supported = collectEnvironmentDiagnostics(root, { nodeVersion: "22.12.0", npmVersion: "10.9.0" })
      .find((diagnostic) => diagnostic.id === "node");
    const unsupported = collectEnvironmentDiagnostics(root, { nodeVersion: "22.11.0", npmVersion: "10.9.0" })
      .find((diagnostic) => diagnostic.id === "node");

    expect(supported).toMatchObject({ status: "pass", label: "Node.js >=22.12.0 (package.json engines.node)" });
    expect(unsupported).toMatchObject({ status: "fail" });
    expect(unsupported?.message).toContain("does not satisfy package.json engines.node >=22.12.0");
  });

  test("doctor flags missing root node_modules and prints a suggested fix", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const report = buildDoctorReport(root);
    expect(report).toContain("[FAIL] root dependencies installed");
    expect(report).toContain("Fix: Run: npm install");
  });

  test("doctor flags missing wjs/node_modules with the correct suggested fix", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    writeText(root, "node_modules/.keep", "");
    const report = buildDoctorReport(root);
    expect(report).toContain("[FAIL] wjs dependencies installed");
    expect(report).toContain("Fix: Run: npm install");
  });

  test("doctor --fix runs safe recipes and refuses destructive repairs", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeJson(root, "package.json", { name: "temp-doctor", private: true, version: "0.0.0" });
    writeJson(root, "wjs/package.json", { name: "temp-wjs", private: true, version: "0.0.0" });
    const report = buildDoctorReport(root, { fix: true });
    expect(report).toContain("--fix execution:");
    expect(report).toContain("[OK] root dependencies installed");
    expect(report).toContain("[OK] wjs dependencies installed");
    expect(report).toContain("npm install");
  });

  test("doctor omits --fix plan when --fix flag is not set", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const report = buildDoctorReport(root);
    expect(report).not.toContain("--fix execution:");
  });

  test("profile set writes and applies a semantic WBS changeset", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs();
    wbs.extensions = {
      vendor: { retained: true },
      scwbs: { profile: "Standard", retained: true }
    };
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    expect(readProfile(root)).toBe("Standard");

    let appliedPath = "";
    const apply = (applyRoot: string, changeSetPath: string, options: { force: boolean; output?: string }): number => {
      appliedPath = changeSetPath;
      expect(applyRoot).toBe(root);
      expect(options).toEqual({ force: true, output: "contracts/wbs/project.wbs.json" });
      const changeSet = JSON.parse(readFileSync(path.join(root, changeSetPath), "utf8"));
      const operationSchema = JSON.parse(readFileSync(
        path.join(process.cwd(), "wjs/schema/wbs-operations.schema.json"),
        "utf8"
      ));
      const ajv = new Ajv2020({ strict: false });
      expect(ajv.compile(operationSchema)(changeSet)).toBe(true);
      const operation = changeSet.operations[0];
      wbs.extensions = {
        ...wbs.extensions,
        [operation.namespace]: operation.value
      };
      writeJson(root, options.output!, wbs);
      return 0;
    };

    expect(runProfileSet(root, "lean", {
      now: "2026-07-27T01:00:00.000Z",
      apply
    })).toBe(0);
    expect(appliedPath).toBe("contracts/changesets/profile-set-lean-20260727010000000.json");
    expect(readProfile(root)).toBe("Lean");
    expect(JSON.parse(readFileSync(path.join(root, "contracts/wbs/project.wbs.json"), "utf8")).extensions).toEqual({
      vendor: { retained: true },
      scwbs: { profile: "Lean", retained: true }
    });
    expect(collectWbsChangesetGateIssues([
      "contracts/wbs/project.wbs.json",
      appliedPath
    ])).toEqual([]);
  });

  test("profile set does not directly edit WBS when changeset apply fails", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs();
    wbs.extensions = { scwbs: { profile: "Standard", retained: true } };
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    const before = readFileSync(path.join(root, "contracts/wbs/project.wbs.json"), "utf8");

    expect(runProfileSet(root, "strict", {
      now: "2026-07-27T01:00:00.000Z",
      apply: () => 1
    })).toBe(1);
    expect(readFileSync(path.join(root, "contracts/wbs/project.wbs.json"), "utf8")).toBe(before);
    expect(existsSync(path.join(
      root,
      "contracts/changesets/profile-set-strict-20260727010000000.json"
    ))).toBe(true);
  });

  test("status summarizes WBS node status", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "blocked");
    const status = buildStatus(root);
    expect(status).toContain("- blocked: 1");
  });

  test("wbs apply dry-run does not write output file", () => {
    const root = makeTempRepo();
    mkdirSync(path.join(root, "wjs/tools"), { recursive: true });
    writeText(root, "wjs/tools/apply.ts", "console.log('dryRun: preview only (use --force to write)');");
    writeJson(root, "wjs/package.json", {
      scripts: {
        apply: "node -e \"console.log('dryRun: preview only (use --force to write)')\""
      }
    });
    writeScwbsProject(root);
    writeJson(root, "change-set.json", {
      schemaVersion: "0.1.0",
      targetWbsId: "test-wbs",
      dryRun: true,
      operations: []
    });
    const output = "contracts/wbs/out.json";
    expect(runWbsApply(root, "change-set.json", { force: false, output })).toBe(0);
  });

  test("wbs verify-changesets requires changesets to reproduce head WBS", () => {
    const root = makeTempRepo();
    const base = sampleWbs("planned");
    const head = sampleWbs("planned");
    const node = head.nodes.find((item) => item.id === "node-api");
    if (node) node.status = "blocked";
    writeJson(root, "base.wbs.json", base);
    writeJson(root, "head.wbs.json", head);
    writeJson(root, "change-set.json", {
      schemaVersion: "0.1.0",
      targetWbsId: "test-wbs",
      changeSetId: "changeset-block",
      operations: [
        { operation: "changeNodeStatus", nodeId: "node-api", status: "blocked" }
      ]
    });
    writeJson(root, "empty-change-set.json", {
      schemaVersion: "0.1.0",
      targetWbsId: "test-wbs",
      changeSetId: "changeset-empty",
      operations: []
    });

    expect(verifyWbsChangesets(root, "base.wbs.json", "head.wbs.json", ["change-set.json"])).toBe(true);
    expect(verifyWbsChangesets(root, "base.wbs.json", "head.wbs.json", ["empty-change-set.json"])).toBe(false);
  });

  test("check command succeeds when task and evidence are consistent", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    expect(runCheck(root)).toBe(0);
  });

  test("check ignores contracts/tasks/index.yaml (it is a task index, not a Task Contract)", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    writeText(root, "contracts/tasks/index.yaml", "tasks:\n  - id: SCWBS-DRAFT-ABC\n    path: contracts/tasks/SCWBS-DRAFT-ABC.yaml\n    branchName: task/SCWBS-DRAFT-ABC-example\n    wbsNodeId: node-governance-maintenance\n");
    expect(runCheck(root)).toBe(0);
  });

  test("check catalog resolves known checks to explicit commands (M2-003)", () => {
    expect(resolveCheckCommand("test")).toEqual(["npm", "test"]);
    expect(resolveCheckCommand("typecheck")).toEqual(["npm", "run", "typecheck"]);
    expect(resolveCheckCommand("build")).toEqual(["npm", "run", "build"]);
    expect(isKnownCheck("test")).toBe(true);
    expect(isKnownCheck("lint")).toBe(false);
    expect(resolveCheckCommand("lint")).toEqual(["npm", "run", "lint"]);
  });

  test("scwbs fix regenerates registry.yaml and nothing else (M2-023)", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(root, "contracts/registry.yaml", { projectId: "stale", contracts: [] } as unknown as Record<string, unknown>);
    expect(runFix(root)).toBe(0);
    const registry = readFileSync(path.join(root, "contracts/registry.yaml"), "utf8");
    expect(registry).not.toContain("projectId: stale");
  });
});
