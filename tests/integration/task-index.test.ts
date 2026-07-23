import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { buildNextTask } from "../../src/commands/ai-queue.js";
import { collectCheckIssues } from "../../src/commands/check.js";
import { buildRegistryYaml } from "../../src/commands/registry-rebuild.js";
import { runTaskArchive, runTaskIndexRebuild } from "../../src/commands/task-index.js";
import { buildWbsCandidatesFromTaskIndex } from "../../src/commands/wbs.js";
import { listActiveTasks, listTasks, readTask } from "../../src/core/contracts.js";
import { collectTaskIndexInventoryIssues, readTaskIndex } from "../../src/core/task-index.js";
import { makeTempRepo, sampleTask, writeScwbsProject, writeYaml } from "../helpers.js";

function writeIndex(root: string, status: string, extra: Record<string, unknown> = {}): void {
  writeYaml(root, "contracts/tasks/index.yaml", {
    tasks: [{
      id: "WBS-001-004",
      path: "contracts/tasks/WBS-001-004.yaml",
      branchName: "task/WBS-001-004-api-implementation",
      wbsNodeId: "node-api",
      status,
      dependsOn: [],
      ...extra
    }]
  });
}

describe("Task Contract active/archive lifecycle", () => {
  test("rebuild check detects a missing legacy index and force creates a synchronized inventory", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runTaskIndexRebuild(root, { check: true })).toBe(1);
    expect(listActiveTasks(root).map((entry) => entry.task?.id)).toEqual(["WBS-001-004"]);
    expect(runTaskIndexRebuild(root, { force: true })).toBe(0);
    expect(runTaskIndexRebuild(root, { check: true })).toBe(0);
    expect(readTaskIndex(root).index?.tasks).toHaveLength(1);
    expect(collectCheckIssues(root).some((issue) => issue.code.startsWith("task.index."))).toBe(false);
  });

  test("archive excludes default scans while preserving explicit Task and Registry traceability", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeIndex(root, "active");

    expect(runTaskArchive(root, "WBS-001-004", { now: "2026-07-23T01:02:03.000Z" })).toBe(0);
    expect(listActiveTasks(root)).toEqual([]);
    expect(readTask(root, "WBS-001-004").task?.id).toBe("WBS-001-004");
    expect(buildNextTask(root)).toContain("No available planned tasks.");
    expect(JSON.parse(buildWbsCandidatesFromTaskIndex(root)).operations).toEqual([]);

    const registry = buildRegistryYaml(root);
    expect(registry).toContain("status: archived");
    expect(registry).toContain("active: false");
    expect(registry).toContain('archivedAt: "2026-07-23T01:02:03.000Z"');
    expect(readFileSync(path.join(root, "contracts/tasks/WBS-001-004.yaml"), "utf8")).toContain("id: WBS-001-004");
  });

  test("invalid lifecycle data fails closed without hiding Tasks and force normalizes it", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeIndex(root, "unknown-terminal");

    expect(readTaskIndex(root).issues.some((issue) => issue.code === "task.index.status")).toBe(true);
    expect(listActiveTasks(root).map((entry) => entry.task?.id)).toEqual(["WBS-001-004"]);
    expect(runTaskIndexRebuild(root, { check: true })).toBe(1);
    expect(runTaskIndexRebuild(root, { force: true })).toBe(0);
    expect(readTaskIndex(root).index?.tasks[0]?.status).toBe("planned");

    writeIndex(root, "planned", { id: "../escape", path: "contracts/tasks/../escape.yaml" });
    expect(() => readTaskIndex(root)).not.toThrow();
    expect(readTaskIndex(root).issues.some((issue) => issue.code === "task.index.id")).toBe(true);
    expect(listActiveTasks(root).map((entry) => entry.task?.id)).toEqual(["WBS-001-004"]);
  });

  test("force refuses to hide an invalid Task Contract", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(runTaskIndexRebuild(root, { force: true })).toBe(0);
    const before = readFileSync(path.join(root, "contracts/tasks/index.yaml"), "utf8");
    writeYaml(root, "contracts/tasks/BROKEN-001.yaml", { id: "BROKEN-001", type: "task-contract" });

    expect(runTaskIndexRebuild(root, { force: true })).toBe(1);
    expect(readFileSync(path.join(root, "contracts/tasks/index.yaml"), "utf8")).toBe(before);
  });

  test("rebuild detects duplicate, orphan, missing, and contract metadata drift", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/index.yaml", {
      tasks: [
        {
          id: "WBS-001-004",
          path: "contracts/tasks/WBS-001-004.yaml",
          branchName: "wrong-branch",
          wbsNodeId: "wrong-node",
          status: "active",
          dependsOn: []
        },
        {
          id: "WBS-001-004",
          path: "contracts/tasks/WBS-001-004.yaml",
          branchName: "wrong-branch",
          wbsNodeId: "wrong-node",
          status: "active",
          dependsOn: []
        },
        {
          id: "WBS-999-999",
          path: "contracts/tasks/WBS-999-999.yaml",
          branchName: "task/WBS-999-999",
          wbsNodeId: "node-api",
          status: "archived",
          dependsOn: [],
          archivedAt: "2026-07-23T00:00:00.000Z"
        }
      ]
    });

    const codes = collectTaskIndexInventoryIssues(root, listTasks(root)).map((issue) => issue.code);
    expect(codes).toContain("task.index.duplicateId");
    expect(codes).toContain("task.index.duplicatePath");
    expect(codes).toContain("task.index.orphan");
    expect(codes).toContain("task.index.branchNameDrift");
    expect(codes).toContain("task.index.wbsNodeIdDrift");
  });

  test("JSON rebuild output remains bounded beyond one hundred Tasks", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    for (let index = 5; index <= 105; index += 1) {
      const id = `WBS-001-${String(index).padStart(3, "0")}`;
      writeYaml(root, `contracts/tasks/${id}.yaml`, sampleTask({
        id,
        branchName: `task/${id}`,
        featureId: `F-${index}`
      }) as unknown as Record<string, unknown>);
    }
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(runTaskIndexRebuild(root, { force: true, json: true })).toBe(0);
    } finally {
      log.mockRestore();
    }
    const text = output.join("\n");
    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({ schemaVersion: "1.0.0", status: "rebuilt", total: 102 });
    expect(text.length).toBeLessThan(240);
    expect(text).not.toContain("WBS-001-105");

    const plain: string[] = [];
    const plainLog = vi.spyOn(console, "log").mockImplementation((value) => plain.push(String(value)));
    try {
      expect(runTaskIndexRebuild(root, { check: true })).toBe(0);
    } finally {
      plainLog.mockRestore();
    }
    expect(plain).toHaveLength(5);
    expect(plain.join("\n").length).toBeLessThan(160);
    expect(plain.join("\n")).not.toContain("WBS-001-105");
  });
});
