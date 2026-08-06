import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../../src/cli.js";
import { readSpecChange } from "../../src/core/contracts.js";
import { makeTempRepo, writeScwbsProject } from "../helpers.js";

describe("spec-change new", () => {
  test("creates a validated proposal and requests Level 2 approval", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(main([
      "spec-change", "new",
      "--spec", "SPEC-F001-API",
      "--task", "WBS-001-004",
      "--id", "SCP-F001-API-002",
      "--summary", "Add a documented API response field",
      "--rationale", "The current contract does not define the response field",
      "--proposed-version", "1.1.0",
      "--level", "2",
      "--affected-paths", "contracts/specs/SPEC-F001-API.yaml,src/features/api/index.ts",
      "--risks", "Existing Tasks may need a lock refresh"
    ], root)).toBe(0);

    const proposalPath = path.join(root, "contracts/spec-changes/SCP-F001-API-002.yaml");
    expect(existsSync(proposalPath)).toBe(true);
    const result = readSpecChange(root, "contracts/spec-changes/SCP-F001-API-002.yaml");
    expect(result.issues).toEqual([]);
    expect(result.specChange).toMatchObject({
      targetSpec: "SPEC-F001-API",
      currentVersion: "1.0.0",
      proposedVersion: "1.1.0",
      taskId: "WBS-001-004",
      level: 2,
      approval: { required: true, status: "requested" }
    });
  });

  test("refuses to overwrite an existing proposal", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(main([
      "spec-change", "new",
      "--spec", "SPEC-F001-API",
      "--task", "WBS-001-004",
      "--id", "SCP-F001-API-002",
      "--summary", "First proposal",
      "--rationale", "First rationale",
      "--proposed-version", "1.1.0"
    ], root)).toBe(0);
    const proposalPath = path.join(root, "contracts/spec-changes/SCP-F001-API-002.yaml");
    const original = readFileSync(proposalPath, "utf8");

    expect(main([
      "spec-change", "new",
      "--spec", "SPEC-F001-API",
      "--task", "WBS-001-004",
      "--id", "SCP-F001-API-002",
      "--summary", "Replacement proposal",
      "--rationale", "Replacement rationale",
      "--proposed-version", "1.2.0"
    ], root)).toBe(1);
    expect(readFileSync(proposalPath, "utf8")).toBe(original);
  });
});
