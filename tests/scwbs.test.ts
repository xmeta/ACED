import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runInit } from "../src/commands/init.js";
import { collectCheckIssues, runCheck } from "../src/commands/check.js";
import { collectDiffIssues } from "../src/commands/check-diff.js";
import { buildAiPacket } from "../src/commands/ai-packet.js";
import { buildStatus } from "../src/commands/status.js";
import { runWbsValidate, runWbsApply } from "../src/commands/wbs.js";
import { validateWbsDocument } from "../src/core/wbs.js";
import { makeTempRepo, sampleTask, sampleWbs, writeJson, writeScwbsProject, writeText, writeYaml, sampleEvidence } from "./helpers.js";

describe("scwbs MVP", () => {
  test("init creates a valid minimal WJS document", () => {
    const root = makeTempRepo();
    expect(runInit(root)).toBe(0);
    expect(validateWbsDocument(root)).toEqual([]);
  });

  test("invalid WBS document reports validation errors", () => {
    const root = makeTempRepo();
    writeJson(root, "contracts/wbs/project.wbs.json", { schemaVersion: "0.1.0", id: "bad" });
    const issues = validateWbsDocument(root);
    expect(issues.some((issue) => issue.code.startsWith("wbs."))).toBe(true);
  });

  test("missing wbsNodeId is an error", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ wbsNodeId: "missing-node" }) as unknown as Record<string, unknown>);
    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code === "task.wbsNodeId")).toBe(true);
  });

  test("done node requires evidence", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code === "evidence.missing")).toBe(true);
  });

  test("evidence must include required checks", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({ checks: [{ name: "test", status: "passed" }] }) as unknown as Record<string, unknown>);
    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code === "evidence.check.missing")).toBe(true);
  });

  test("check-diff passes allowed files and flags forbidden files", () => {
    const root = makeTempRepo();
    const task = sampleTask();
    expect(collectDiffIssues(root, task, ["src/features/api/index.ts"])).toEqual([]);
    expect(collectDiffIssues(root, task, ["src/auth/session.ts"]).some((issue) => issue.code === "diff.forbiddenPaths")).toBe(true);
  });

  test("ai packet includes WBS node, task contract, and stop conditions", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const packet = buildAiPacket(root, "WBS-001-004");
    expect(packet).toContain("API Implementation");
    expect(packet).toContain("WBS-001-004");
    expect(packet).toContain("Stop Conditions");
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

  test("check command succeeds when task and evidence are consistent", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    expect(runCheck(root)).toBe(0);
  });
});
