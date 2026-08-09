import { describe, expect, test } from "vitest";
import { buildCoreTaskNew, normalizeTaskNewChecks, runTaskNew, TASK_NEW_BASELINE_CHECKS } from "../../src/commands/task-new.js";
import { makeTempRepo, writeScwbsProject } from "../helpers.js";

describe("task new requiredChecks baseline", () => {
  test("keeps the bootstrap baseline and adds custom checks", () => {
    const { task } = buildCoreTaskNew("Add lint gate", {
      checks: "lint,test:integration,lint",
      id: "SCWBS-DRAFT-BASELINE"
    });

    expect(task.requiredChecks).toEqual(["test", "typecheck", "build", "lint", "test:integration"]);
    expect(task.requiredChecks.slice(0, TASK_NEW_BASELINE_CHECKS.length)).toEqual([...TASK_NEW_BASELINE_CHECKS]);
  });

  test("deduplicates baseline and requested checks", () => {
    expect(normalizeTaskNewChecks("build,typecheck,test,lint,lint")).toEqual({
      checks: ["test", "typecheck", "build", "lint"],
      invalid: []
    });
  });

  test("rejects invalid check names before creating a contract", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runTaskNew(root, "Invalid check", {
      checks: "lint;rm -rf,valid-check",
      noStopConditions: true
    })).toBe(1);
  });

  test("default and empty check values retain the baseline", () => {
    expect(buildCoreTaskNew("Default checks", { id: "SCWBS-DRAFT-DEFAULT" }).task.requiredChecks)
      .toEqual([...TASK_NEW_BASELINE_CHECKS]);
    expect(buildCoreTaskNew("Empty checks", { checks: "", id: "SCWBS-DRAFT-EMPTY" }).task.requiredChecks)
      .toEqual([...TASK_NEW_BASELINE_CHECKS]);
  });
});
