import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { collectCheckIssues, runCheck } from "../src/commands/check.js";

import { buildDraftTaskYaml, runTaskGenerate } from "../src/commands/task-generate.js";
import { buildCoreTaskNew, nextDraftTaskId, runTaskNew } from "../src/commands/task-new.js";
import { buildLockedTask, runTaskLock } from "../src/commands/task-lock.js";
import { buildTaskRefreshPreview, runTaskRefresh } from "../src/commands/task-refresh.js";
import { buildWbsCandidatesFromTaskIndex } from "../src/commands/wbs.js";
import { buildNextTask } from "../src/commands/ai-queue.js";
import { makeTempRepo, sampleTask, sampleWbs, sampleSpec, sampleSpecChange, writeScwbsProject, writeJson, writeText, writeYaml } from "./helpers.js";

describe("task management", () => {
  test("check errors when contract lock wbs node id is stale", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(
      root,
      "contracts/tasks/WBS-001-004.yaml",
      sampleTask({
        contractLock: {
          wbsNodeId: "node-old"
        }
      }) as unknown as Record<string, unknown>
    );
    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code === "task.contractLock.wbsNodeId")).toBe(true);
  });

  test("task lock writes a current contract lock", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runTaskLock(root, "WBS-001-004")).toBe(0);
    const locked = buildLockedTask(root, "WBS-001-004", new Date("2026-06-27T00:00:00.000Z"));
    expect(locked.contractLock?.wbsNodeId).toBe("node-api");
    expect(locked.contractLock?.specVersion).toBe("1.0.0");
    expect(locked.contractLock?.specRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(locked.contractLock?.wbsRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(collectCheckIssues(root).some((issue) => issue.code.startsWith("task.contractLock"))).toBe(false);
  });

  test("task refresh previews lock changes and apply writes safe lock fields", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const preview = buildTaskRefreshPreview(root, "WBS-001-004");
    expect(preview).toContain("Task Contract refresh preview");
    expect(preview).toContain("Safe updates");
    expect(runTaskRefresh(root, "WBS-001-004", { apply: true })).toBe(0);
    expect(collectCheckIssues(root).some((issue) => issue.code.startsWith("task.contractLock"))).toBe(false);
  });

  test("check errors when a locked spec contract becomes stale", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const locked = buildLockedTask(root, "WBS-001-004", new Date("2026-06-27T00:00:00.000Z"));
    writeYaml(
      root,
      "contracts/tasks/WBS-001-004.yaml",
      {
        ...locked,
        contractLock: {
          ...locked.contractLock,
          specVersion: "9.9.9",
          specRevision: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        }
      } as unknown as Record<string, unknown>
    );

    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code === "task.contractLock.specVersion")).toBe(true);
    expect(issues.some((issue) => issue.code === "task.contractLock.specRevision")).toBe(true);
  });

  test("check validates first-class spec contracts in the registry", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code.startsWith("registry.spec."))).toBe(false);
    expect(issues.some((issue) => issue.code === "task.spec.status")).toBe(false);
  });

  test("check errors when a spec contract is missing approval metadata", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const invalidApprovedSpec = { ...sampleSpec() } as Record<string, unknown>;
    delete invalidApprovedSpec.approvedBy;
    delete invalidApprovedSpec.approvedAt;
    writeYaml(
      root,
      "contracts/specs/SPEC-F001-API.yaml",
      invalidApprovedSpec
    );
    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code === "spec.approval")).toBe(true);
  });

  test("check errors when registry spec metadata drifts from the spec contract", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/registry.yaml", {
      projectId: "test-wbs",
      contracts: [
        {
          id: "SPEC-F001-API",
          type: "spec",
          path: "contracts/specs/SPEC-F001-API.yaml",
          status: "approved",
          version: "2.0.0",
          featureId: "F001",
          relatedTask: "WBS-001-004"
        }
      ]
    });
    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code.startsWith("registry.spec."))).toBe(true);
  });

  test("check errors when a task references a draft spec", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const draftSpec = { ...sampleSpec({ status: "draft" }) } as Record<string, unknown>;
    writeYaml(
      root,
      "contracts/specs/SPEC-F001-API.yaml",
      draftSpec
    );
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      contractLock: {
        wbsNodeId: "node-api"
      }
    }) as unknown as Record<string, unknown>);
    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code.endsWith("spec.status"))).toBe(true);
  });

  test("check errors when a spec file is not indexed in the registry", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/registry.yaml", {
      projectId: "test-wbs",
      contracts: []
    });
    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code === "spec.registry.missing")).toBe(true);
  });

  test("check errors when a spec change file is not indexed in the registry", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/spec-changes/SCP-F001-API-001.yaml", sampleSpecChange() as unknown as Record<string, unknown>);
    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code === "specChange.registry.missing")).toBe(true);
  });

  test("check errors when a task lock references a missing spec", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/registry.yaml", {
      projectId: "test-wbs",
      contracts: []
    });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      contractLock: {
        wbsNodeId: "node-api",
        specVersion: "1.0.0",
        specRevision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    }) as unknown as Record<string, unknown>);
    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code === "task.spec.missing")).toBe(true);
  });

  test("task generate writes a draft contract from a WBS node", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runTaskGenerate(root, "node-api", "WBS-001-999", { force: false })).toBe(0);
    const expected = buildDraftTaskYaml(root, "node-api", "WBS-001-999");
    const actual = readFileSync(path.join(root, "contracts/tasks/WBS-001-999.yaml"), "utf8");
    expect(actual).toBe(expected);
    expect(expected).toContain("id: WBS-001-999");
    expect(expected).toContain("wbsNodeId: node-api");
    expect(expected).toContain("featureId: F-1-1");
    expect(expected).toContain("branchName: task/WBS-001-999-api-implementation");
    expect(expected).toContain("allowedPaths:");
    expect(expected).toContain("doneCriteria:");
  });

  test("task generate refuses to overwrite an existing contract without force", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-999.yaml", sampleTask({ id: "WBS-001-999" }) as unknown as Record<string, unknown>);
    const before = readFileSync(path.join(root, "contracts/tasks/WBS-001-999.yaml"), "utf8");

    expect(runTaskGenerate(root, "node-api", "WBS-001-999", { force: false })).toBe(1);
    expect(readFileSync(path.join(root, "contracts/tasks/WBS-001-999.yaml"), "utf8")).toBe(before);
    expect(runTaskGenerate(root, "node-api", "WBS-001-999", { force: true })).toBe(0);
    expect(readFileSync(path.join(root, "contracts/tasks/WBS-001-999.yaml"), "utf8")).not.toBe(before);
  });

  test("task new writes a core draft task from title and path options", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runTaskNew(root, "Core Alias Work", {
      paths: "src/**,tests/**",
      forbid: "wjs/**",
      gate: ".github/**",
      checks: "test,typecheck"
    })).toBe(0);

    const taskFileName = readdirSync(path.join(root, "contracts/tasks")).find((file) => file.startsWith("SCWBS-DRAFT-"));
    const taskFile = taskFileName ? `contracts/tasks/${taskFileName}` : undefined;
    expect(taskFile).toBeTruthy();
    const actual = readFileSync(path.join(root, taskFile ?? ""), "utf8");
    expect(actual).toContain("branchName: task/SCWBS-DRAFT-");
    expect(actual).toContain("allowedPaths:");
    expect(actual).toContain("  - src/**");
    expect(actual).toContain("requiredChecks:");
    expect(actual).toContain("  - typecheck");
    const index = readFileSync(path.join(root, "contracts/tasks/index.yaml"), "utf8");
    expect(index).toContain("path: contracts/tasks/SCWBS-DRAFT-");
    expect(index).toContain("status: planned");
    expect(index).toContain("dependsOn: []");
  });

  test("task new builds safe branch names and default checks", () => {
    const { task } = buildCoreTaskNew("Fix Core CLI!");

    expect(task.id).toMatch(/^SCWBS-DRAFT-/);
    expect(task.branchName).toMatch(/^task\/SCWBS-DRAFT-[A-Z0-9]+-fix-core-cli$/);
    expect(task.allowedPaths).toEqual(["src/**", "tests/**", "docs/**", "contracts/**"]);
    expect(task.requiredChecks).toEqual(["test", "typecheck", "build"]);
  });

  test("task new retries draft task id collisions", () => {
    const root = makeTempRepo();
    writeYaml(root, "contracts/tasks/SCWBS-DRAFT-ABC.yaml", sampleTask({ id: "SCWBS-DRAFT-ABC" }) as unknown as Record<string, unknown>);

    expect(nextDraftTaskId(root, "ABC")).toBe("SCWBS-DRAFT-ABC-2");
  });

  test("task new generates stopIf entries from stop option", () => {
    const { task } = buildCoreTaskNew("Stop Presets", {
      stop: "db schema change,auth redesign"
    });

    expect(task.stopIf).toEqual(["db schema change", "auth redesign"]);
  });

  test("task new falls back to a safe placeholder title when title is missing (M1-007)", () => {
    const { task, fallback } = buildCoreTaskNew("");

    expect(fallback.usedFallbackTitle).toBe(true);
    expect(fallback.fallbackNote).toContain(task.id);
    expect(task.doneCriteria[0]).toContain("untitled task");
  });

  test("task new with --wbs-node writes a changeset draft instead of editing the WBS (M1-012)", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const wbsBefore = readFileSync(path.join(root, "contracts/wbs/project.wbs.json"), "utf8");

    expect(runTaskNew(root, "Linked Work", { wbsNode: "node-project" })).toBe(0);

    const wbsAfter = readFileSync(path.join(root, "contracts/wbs/project.wbs.json"), "utf8");
    expect(wbsAfter).toBe(wbsBefore);

    const changesetFile = readdirSync(path.join(root, "contracts/changesets")).find((file) => file.includes("link-wbs-node"));
    expect(changesetFile).toBeTruthy();
    const changeset = JSON.parse(readFileSync(path.join(root, `contracts/changesets/${changesetFile}`), "utf8"));
    expect(changeset.operations[0].nodeId).toBe("node-project");
  });

  test("WBS-less task flow passes check and can generate WBS candidates", () => {
    const root = makeTempRepo();

    expect(runTaskNew(root, "WBS Less Work", { paths: "src/**", checks: "test" })).toBe(0);
    expect(collectCheckIssues(root)).toEqual([]);
    const candidates = buildWbsCandidatesFromTaskIndex(root);
    expect(candidates).toContain('"changeSetId": "changeset-wbs-candidates"');
    expect(candidates).toContain('"operation": "addNode"');
    expect(buildNextTask(root)).toContain("Planned task candidates:");
  });
});
