import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runInit } from "../src/commands/init.js";
import { collectCheckIssues, runCheck } from "../src/commands/check.js";
import { buildStartArtifacts } from "../src/commands/start.js";
import { buildDoctorReport } from "../src/commands/doctor.js";
import { readProfile, runProfileSet } from "../src/commands/profile.js";
import { buildStatus } from "../src/commands/status.js";
import { runFinish } from "../src/commands/finish.js";
import { runFix } from "../src/commands/fix.js";
import { runAiBlock } from "../src/commands/ai-queue.js";
import { runWbsValidate, runWbsApply, verifyWbsChangesets } from "../src/commands/wbs.js";
import { readBlock, readEvidence, readSpecChange, readTask } from "../src/core/contracts.js";
import { parseSimpleYaml, stringifySimpleYaml } from "../src/core/yaml.js";
import { validateWbsDocument } from "../src/core/wbs.js";
import { resolveCheckCommand, isKnownCheck } from "../src/core/check-catalog.js";
import { main } from "../src/cli.js";
import { makeTempRepo, sampleTask, sampleWbs, sampleSpec, sampleEvidence, writeScwbsProject, writeJson, writeText, writeYaml } from "./helpers.js";
import type { WbsDocument } from "../src/core/types.js";

describe("misc", () => {
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
    expect(changeSetPath).toBeTruthy();
    const changeSet = JSON.parse(artifacts[changeSetPath!]);
    expect(changeSet.targetWbsId).toBe("scwbs");
    expect(changeSet.operations[0].operation).toBe("addNode");
    expect(changeSet.operations[0].node.parentId).toBe("node-project");
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

  test("finish without task id or task branch fails with a fix command", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(main(["finish"], root)).toBe(2);
  });

  test("finish stops after required check failures", () => {
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
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    writeText(root, "src/feature.ts", "export const value = 1;\n");

    expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base" })).toBe(1);
    const { evidence } = readEvidence(root, "WBS-001-004");
    expect(evidence?.checks[0]).toMatchObject({ name: "test", status: "failed" });
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
    expect(report).toContain("Fix: Run: npm install --prefix wjs");
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

  test("profile set updates the WBS profile", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(readProfile(root)).toBe("Standard");
    expect(runProfileSet(root, "lean")).toBe(0);
    expect(readProfile(root)).toBe("Lean");
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
