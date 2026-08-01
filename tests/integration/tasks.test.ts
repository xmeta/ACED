import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { collectCheckIssues, runCheck } from "../../src/commands/check.js";

import { buildDraftTaskYaml, runTaskGenerate } from "../../src/commands/task-generate.js";
import { buildCoreTaskNew, nextDraftTaskId, runTaskNew } from "../../src/commands/task-new.js";
import { buildLockedTask, runTaskLock } from "../../src/commands/task-lock.js";
import { buildAffectedTaskRefreshReport, buildTaskRefreshPreview, runTaskRefresh, taskRefreshReasons } from "../../src/commands/task-refresh.js";
import { applyWbsChangesets, buildWbsCandidatesFromTaskIndex } from "../../src/commands/wbs.js";
import { buildNextTask } from "../../src/commands/ai-queue.js";
import { main } from "../../src/cli.js";
import { validateTaskContract, validateTaskContractSchema } from "../../src/core/schema.js";
import { makeTempRepo, sampleTask, sampleWbs, sampleSpec, sampleSpecChange, writeScwbsProject, writeJson, writeText, writeYaml } from "../helpers.js";

const wjsValidatorModule = "../../wjs/tools/validate.js";
const { validateJsonWithSchema } = await import(wjsValidatorModule) as {
  validateJsonWithSchema(document: unknown, kind: "wbs" | "operations"): string[];
};

describe("task management", () => {
  test("upstream-release submodule authority requires immutable provenance and passed checks", () => {
    const incomplete = sampleTask({
      submoduleDependencies: [{
        path: "vendor/dependency",
        authorityMode: "upstream-release"
      }]
    });
    expect(validateTaskContractSchema(incomplete, "task.yaml").some((issue) => issue.code === "task.schema")).toBe(true);
    expect(validateTaskContract(incomplete, "task.yaml").some((issue) => issue.code === "task.submoduleDependency.upstreamRelease")).toBe(true);

    const complete = sampleTask({
      submoduleDependencies: [{
        path: "vendor/dependency",
        authorityMode: "upstream-release",
        repository: "example/dependency",
        pullRequest: "#4",
        upstreamRef: "refs/remotes/origin/main",
        checks: [{ name: "upstream-ci", status: "passed" }]
      }]
    });
    expect(validateTaskContractSchema(complete, "task.yaml")).toEqual([]);
    expect(validateTaskContract(complete, "task.yaml")).toEqual([]);
  });

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
    expect(locked.contractLock?.lockVersion).toBe("2");
    expect(locked.contractLock?.wbsScopeRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(locked.contractLock?.wbsGlobalRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(locked.contractLock?.wbsRevision).toBeUndefined();
    expect(collectCheckIssues(root).some((issue) => issue.code.startsWith("task.contractLock"))).toBe(false);
  });

  test("version 2 lock ignores unrelated siblings but detects referenced node and ancestor changes", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", buildLockedTask(root, "WBS-001-004") as unknown as Record<string, unknown>);

    const siblingWbs = sampleWbs();
    siblingWbs.nodes.push({
      id: "node-unrelated",
      parentId: "node-root",
      code: "1.2",
      name: "Unrelated sibling",
      type: "workPackage",
      status: "planned"
    });
    writeJson(root, "contracts/wbs/project.wbs.json", siblingWbs);
    expect(collectCheckIssues(root).some((issue) => issue.code.startsWith("task.contractLock"))).toBe(false);
    expect(taskRefreshReasons(root, "WBS-001-004")).toEqual([]);

    siblingWbs.nodes.find((node) => node.id === "node-api")!.name = "Changed API node";
    writeJson(root, "contracts/wbs/project.wbs.json", siblingWbs);
    expect(collectCheckIssues(root).some((issue) => issue.code === "task.contractLock.wbsScopeRevision")).toBe(true);

    writeJson(root, "contracts/wbs/project.wbs.json", sampleWbs());
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", buildLockedTask(root, "WBS-001-004") as unknown as Record<string, unknown>);
    const ancestorWbs = sampleWbs();
    ancestorWbs.nodes.find((node) => node.id === "node-root")!.name = "Changed ancestor";
    writeJson(root, "contracts/wbs/project.wbs.json", ancestorWbs);
    expect(taskRefreshReasons(root, "WBS-001-004")).toContain("node, ancestor, dependency, or artifact scope changed");
  });

  test("version 2 lock detects dependency subgraph changes", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs();
    wbs.nodes.push(
      { id: "node-dependency", parentId: "node-root", code: "1.2", name: "Dependency", type: "workPackage", status: "completed" },
      { id: "node-transitive", parentId: "node-root", code: "1.3", name: "Transitive dependency", type: "workPackage", status: "completed" }
    );
    wbs.relations = [
      ...(wbs.relations ?? []),
      { id: "rel-api-dependency", type: "dependsOn", source: "node-api", target: "node-dependency" },
      { id: "rel-dependency-transitive", type: "dependsOn", source: "node-dependency", target: "node-transitive" }
    ];
    writeScwbsProject(root);
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", buildLockedTask(root, "WBS-001-004") as unknown as Record<string, unknown>);

    wbs.nodes.find((node) => node.id === "node-transitive")!.name = "Changed transitive dependency";
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    expect(collectCheckIssues(root).some((issue) => issue.code === "task.contractLock.wbsScopeRevision")).toBe(true);
  });

  test("version 2 lock detects related artifact and artifact relation changes", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs();
    wbs.artifacts = [...(wbs.artifacts ?? []), { id: "artifact-input", name: "Input", type: "document" }];
    wbs.relations = [...(wbs.relations ?? []), { id: "rel-api-consumes-input", type: "consumes", source: "node-api", target: "artifact-input" }];
    writeScwbsProject(root);
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", buildLockedTask(root, "WBS-001-004") as unknown as Record<string, unknown>);

    wbs.artifacts.find((artifact) => artifact.id === "artifact-input")!.name = "Changed input";
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    expect(taskRefreshReasons(root, "WBS-001-004")).toContain("node, ancestor, dependency, or artifact scope changed");

    wbs.artifacts.find((artifact) => artifact.id === "artifact-input")!.name = "Input";
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", buildLockedTask(root, "WBS-001-004") as unknown as Record<string, unknown>);
    wbs.relations.find((relation) => relation.id === "rel-api-consumes-input")!.description = "Changed artifact relation";
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    expect(taskRefreshReasons(root, "WBS-001-004")).toContain("node, ancestor, dependency, or artifact scope changed");
  });

  test("version 2 lock detects WBS schema and global SC-WBS policy changes", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", buildLockedTask(root, "WBS-001-004") as unknown as Record<string, unknown>);
    const warningBudgetWbs = sampleWbs();
    warningBudgetWbs.extensions = {
      scwbs: {
        governanceCost: {
          warningBudgets: {
            Standard: {
              governanceFiles: 700,
              governanceLines: 31000,
              governanceToSourceLineRatio: 2
            }
          }
        }
      }
    };
    writeJson(root, "contracts/wbs/project.wbs.json", warningBudgetWbs);
    expect(collectCheckIssues(root).some((issue) => issue.code === "task.contractLock.wbsGlobalRevision")).toBe(false);
    expect(taskRefreshReasons(root, "WBS-001-004")).toEqual([]);

    const wbs = sampleWbs();
    wbs.extensions = { scwbs: { profile: "Strict" } };
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    expect(collectCheckIssues(root).some((issue) => issue.code === "task.contractLock.wbsGlobalRevision")).toBe(true);

    writeJson(root, "contracts/wbs/project.wbs.json", sampleWbs());
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", buildLockedTask(root, "WBS-001-004") as unknown as Record<string, unknown>);
    const otherPolicyWbs = sampleWbs();
    otherPolicyWbs.extensions = { scwbs: { governanceCost: { enforcementMode: "strict" } } };
    writeJson(root, "contracts/wbs/project.wbs.json", otherPolicyWbs);
    expect(taskRefreshReasons(root, "WBS-001-004")).toContain("WBS schema or global SC-WBS policy changed");

    writeJson(root, "contracts/wbs/project.wbs.json", sampleWbs());
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", buildLockedTask(root, "WBS-001-004") as unknown as Record<string, unknown>);
    const schemaWbs = sampleWbs();
    schemaWbs.schemaVersion = "0.2.0";
    writeJson(root, "contracts/wbs/project.wbs.json", schemaWbs);
    expect(taskRefreshReasons(root, "WBS-001-004")).toContain("WBS schema or global SC-WBS policy changed");
  });

  test("task refresh affected previews changes and migrates legacy whole-WBS locks", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      contractLock: {
        wbsRevision: "sha256:legacy",
        wbsNodeId: "node-api",
        createdAt: "2026-06-27T00:00:00.000Z"
      }
    }) as unknown as Record<string, unknown>);

    const before = readFileSync(path.join(root, "contracts/tasks/WBS-001-004.yaml"), "utf8");
    expect(buildAffectedTaskRefreshReport(root)).toContain("WBS-001-004: legacy whole-WBS lock requires migration");
    expect(main(["task", "refresh", "--affected"], root)).toBe(0);
    expect(readFileSync(path.join(root, "contracts/tasks/WBS-001-004.yaml"), "utf8")).toBe(before);
    expect(runTaskRefresh(root, "WBS-001-004", { apply: true })).toBe(0);
    expect(buildAffectedTaskRefreshReport(root)).toBe("Affected Task Contracts:\n- None\n");
    expect(readFileSync(path.join(root, "contracts/tasks/WBS-001-004.yaml"), "utf8")).toContain('lockVersion: "2"');
  });

  test("task refresh affected lists only version 2 locks whose scope changed", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs();
    wbs.nodes.push({ id: "node-unrelated", parentId: "node-root", code: "1.2", name: "Unrelated", type: "workPackage", status: "planned" });
    writeScwbsProject(root);
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({ id: "WBS-001-005", featureId: "F002", wbsNodeId: "node-unrelated", branchName: "task/WBS-001-005" }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", buildLockedTask(root, "WBS-001-004") as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", buildLockedTask(root, "WBS-001-005") as unknown as Record<string, unknown>);

    wbs.nodes.find((node) => node.id === "node-api")!.name = "Changed API";
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    const report = buildAffectedTaskRefreshReport(root);
    expect(report).toContain("WBS-001-004: node, ancestor, dependency, or artifact scope changed");
    expect(report).not.toContain("WBS-001-005");
  });

  test("task refresh all previews and explicitly applies every Task lock", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({ id: "WBS-001-005", branchName: "task/WBS-001-005" }) as unknown as Record<string, unknown>);

    expect(buildAffectedTaskRefreshReport(root, true)).toContain("All Task Contracts:");
    expect(runTaskRefresh(root, undefined, { all: true, apply: false })).toBe(0);
    expect(runTaskRefresh(root, undefined, { all: true, apply: true })).toBe(0);
    expect(buildLockedTask(root, "WBS-001-004").contractLock?.lockVersion).toBe("2");
    expect(buildLockedTask(root, "WBS-001-005").contractLock?.lockVersion).toBe("2");
    expect(buildAffectedTaskRefreshReport(root)).toBe("Affected Task Contracts:\n- None\n");
  });

  test("task refresh previews report invalid Task Contracts and fail", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/BROKEN-001.yaml", { id: "BROKEN-001", type: "task-contract" });
    const report = buildAffectedTaskRefreshReport(root);
    expect(report).toContain("contracts/tasks/BROKEN-001.yaml: invalid Task Contract");
    expect(runTaskRefresh(root, undefined, { affected: true, apply: false })).toBe(1);
    expect(runTaskRefresh(root, undefined, { all: true, apply: false })).toBe(1);
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
      checks: "test,typecheck",
      stop: "schema change"
    })).toBe(0);

    const taskFileName = readdirSync(path.join(root, "contracts/tasks")).find((file) => file.startsWith("SCWBS-DRAFT-"));
    const taskFile = taskFileName ? `contracts/tasks/${taskFileName}` : undefined;
    expect(taskFile).toBeTruthy();
    const actual = readFileSync(path.join(root, taskFile ?? ""), "utf8");
    expect(actual).toContain("branchName: task/SCWBS-DRAFT-");
    expect(actual).toContain("allowedPaths:");
    expect(actual).toContain("  - src/**");
    expect(actual).toContain("  - package.json");
    expect(actual).toContain("  - package-lock.json");
    expect(actual).toContain("  - tsconfig.json");
    expect(actual).toContain("  - vitest.config.ts");
    expect(actual.match(/  - \.github\/\*\*/g)).toHaveLength(1);
    expect(actual).toContain("requiredChecks:");
    expect(actual).toContain("  - typecheck");
    const index = readFileSync(path.join(root, "contracts/tasks/index.yaml"), "utf8");
    expect(index).toContain("path: contracts/tasks/SCWBS-DRAFT-");
    expect(index).toContain("status: planned");
    expect(index).toContain("dependsOn: []");
  });

  test("task new builds safe branch names and default checks", () => {
    const { task } = buildCoreTaskNew("Fix Core CLI!", { id: "SCWBS-DRAFT-TEST1234" });

    expect(task.id).toBe("SCWBS-DRAFT-TEST1234");
    expect(task.branchName).toBe("task/SCWBS-DRAFT-TEST1234-fix-core-cli");
    expect(task.allowedPaths).toEqual([]);
    expect(task.wbsNodeId).toBe("wbs-less");
    expect(task.requiredChecks).toEqual(["test", "typecheck", "build"]);
    expect(task.managedContractPaths).toEqual([
      "contracts/tasks/SCWBS-DRAFT-TEST1234.yaml",
      "contracts/tasks/index.yaml",
      "contracts/blocks/SCWBS-DRAFT-TEST1234.yaml",
      "contracts/evidence/SCWBS-DRAFT-TEST1234.yaml",
      "contracts/evidence-payloads/SCWBS-DRAFT-TEST1234.patch",
      "contracts/approvals/SCWBS-DRAFT-TEST1234.yaml",
      "contracts/reviews/SCWBS-DRAFT-TEST1234.yaml",
      "contracts/registry.yaml"
    ]);
  });

  test("task new appends custom gates to the standard Human Gates deterministically", () => {
    const { task } = buildCoreTaskNew("Custom Human Gates", {
      gate: "src/security/**,.github/**,src/security/**,package.json,config/release/**"
    });

    expect(task.humanGateRequiredPaths).toEqual([
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "vitest.config.ts",
      ".github/**",
      "src/security/**",
      "config/release/**"
    ]);
  });

  test("task new fails closed until stop-condition intent is explicit", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runTaskNew(root, "Fail Closed Draft")).toBe(1);
    expect(readdirSync(path.join(root, "contracts/tasks")).filter((file) => file.startsWith("SCWBS-DRAFT-"))).toEqual([]);
  });

  test("task new without paths creates a deny-all WBS-less draft", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runTaskNew(root, "Deny All Draft", { noStopConditions: true })).toBe(0);
    const taskFile = readdirSync(path.join(root, "contracts/tasks")).find((file) => file.startsWith("SCWBS-DRAFT-"));
    const yaml = readFileSync(path.join(root, "contracts/tasks", taskFile ?? ""), "utf8");
    expect(yaml).toContain("wbsNodeId: wbs-less");
    expect(yaml).toContain("allowedPaths: []");
    expect(collectCheckIssues(root)).toEqual([]);
    const taskId = taskFile?.replace(/\.yaml$/, "") ?? "";
    const locked = buildLockedTask(root, taskId);
    expect(locked.contractLock?.wbsNodeId).toBe("wbs-less");
    expect(locked.contractLock?.wbsScopeRevision).toBeUndefined();
    expect(locked.contractLock?.wbsGlobalRevision).toMatch(/^sha256:/);
    writeYaml(root, `contracts/tasks/${taskId}.yaml`, locked as unknown as Record<string, unknown>);
    expect(collectCheckIssues(root)).toEqual([]);
  });

  test("task new warns when broad scope is explicitly requested", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      expect(runTaskNew(root, "Broad Draft", { paths: "src/**", noStopConditions: true })).toBe(0);
      expect(stdout.mock.calls.flat().join("")).toContain("Warning: broad allowedPaths require explicit review");
    } finally {
      stdout.mockRestore();
    }
  });

  test("task new rejects an unknown explicit WBS node before writing artifacts", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runTaskNew(root, "Unknown Node", { paths: "src/safe.ts", noStopConditions: true, wbsNode: "node-missing" })).toBe(1);
    expect(readdirSync(path.join(root, "contracts/tasks")).filter((file) => file.startsWith("SCWBS-DRAFT-"))).toEqual([]);
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

  test("task new with --wbs-node records wbsNodeId without writing a WBS changeset", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const wbsBefore = readFileSync(path.join(root, "contracts/wbs/project.wbs.json"), "utf8");

    expect(runTaskNew(root, "Linked Work", { wbsNode: "node-api", noStopConditions: true })).toBe(0);

    const wbsAfter = readFileSync(path.join(root, "contracts/wbs/project.wbs.json"), "utf8");
    expect(wbsAfter).toBe(wbsBefore);

    const taskFileName = readdirSync(path.join(root, "contracts/tasks")).find((file) => file.startsWith("SCWBS-DRAFT-"));
    const taskFile = taskFileName ? `contracts/tasks/${taskFileName}` : undefined;
    expect(taskFile).toBeTruthy();
    const taskYaml = readFileSync(path.join(root, taskFile ?? ""), "utf8");
    expect(taskYaml).toContain("wbsNodeId: node-api");

    const changesetDir = path.join(root, "contracts/changesets");
    const changesetFiles = existsSync(changesetDir) ? readdirSync(changesetDir).filter((file) => file.includes("link-wbs-node")) : [];
    expect(changesetFiles.length).toBe(0);
  });

  test("task new with --wbs-node is idempotent and does not duplicate WBS changesets", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const wbsBefore = readFileSync(path.join(root, "contracts/wbs/project.wbs.json"), "utf8");

    expect(runTaskNew(root, "Linked Work", { wbsNode: "node-api", noStopConditions: true })).toBe(0);
    expect(runTaskNew(root, "Linked Work", { wbsNode: "node-api", noStopConditions: true })).toBe(0);

    const wbsAfter = readFileSync(path.join(root, "contracts/wbs/project.wbs.json"), "utf8");
    expect(wbsAfter).toBe(wbsBefore);

    const changesetDir = path.join(root, "contracts/changesets");
    const changesetFiles = existsSync(changesetDir) ? readdirSync(changesetDir).filter((file) => file.includes("link-wbs-node")) : [];
    expect(changesetFiles.length).toBe(0);
  });

  test("WBS-less task flow passes check and can generate WBS candidates", () => {
    const root = makeTempRepo();

    expect(runTaskNew(root, "WBS Less Work", { paths: "src/**", checks: "test", noStopConditions: true })).toBe(0);
    expect(collectCheckIssues(root)).toEqual([]);
    const candidates = buildWbsCandidatesFromTaskIndex(root);
    const parsed = JSON.parse(candidates);
    // Validate against WJS operations schema (validator resolves schemas relative to wjs/)
    const wjsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wjs");
    const originalCwd = process.cwd();
    let errors: string[];
    try {
      process.chdir(wjsDir);
      errors = validateJsonWithSchema(parsed, "operations");
    } finally {
      process.chdir(originalCwd);
    }
    expect(errors).toEqual([]);
    // Verify node object structure
    expect(parsed.operations[0].operation).toBe("addNode");
    expect(parsed.operations[0].node).toBeDefined();
    expect(parsed.operations[0].node.id).toBeDefined();
    expect(parsed.operations[0].node.parentId).toBe("node-project");
    expect(parsed.operations[0].node.code).toBeDefined();
    expect(parsed.operations[0].position).toEqual({ mode: "last" });
    expect(buildNextTask(root)).toContain("Planned task candidates:");
  });
});

describe("WBS-less task flow", () => {
  test("applyWbsChangesets processes setDocumentExtension atomically", () => {
    const baseWbs = sampleWbs();
    baseWbs.extensions = {
      scwbs: { profile: "Lean", stale: true },
      vendor: { retained: true }
    };
    const nodesBefore = structuredClone(baseWbs.nodes);

    const result = applyWbsChangesets(baseWbs, [{
      schemaVersion: "0.1.0",
      targetWbsId: "scwbs",
      operations: [{
        operation: "setDocumentExtension",
        namespace: "scwbs",
        value: {
          profile: "Standard",
          governanceCost: {
            warningBudgets: {
              Standard: {
                governanceFiles: 700,
                governanceLines: 31000,
                governanceToSourceLineRatio: 2
              }
            }
          }
        }
      }]
    }]);

    expect(result.extensions?.vendor).toEqual({ retained: true });
    expect(result.extensions?.scwbs).toEqual({
      profile: "Standard",
      governanceCost: {
        warningBudgets: {
          Standard: {
            governanceFiles: 700,
            governanceLines: 31000,
            governanceToSourceLineRatio: 2
          }
        }
      }
    });
    expect(result.nodes).toEqual(nodesBefore);
    expect(baseWbs.extensions?.scwbs).toEqual({ profile: "Lean", stale: true });
  });

  test("applyWbsChangesets processes addNode operations with nested node object format", () => {
    const baseWbs = sampleWbs();
    const beforeCount = baseWbs.nodes.length;

    const changeset = {
      schemaVersion: "0.1.0",
      targetWbsId: "scwbs",
      changeSetId: "changeset-test-addnode",
      author: "test",
      reason: "Test addNode with node object",
      dryRun: false,
      operations: [
        {
          operationId: "op-001",
          operation: "addNode",
          node: {
            id: "node-test-candidate",
            parentId: "node-project",
            code: "test.candidate",
            name: "Test Candidate",
            type: "workPackage",
            status: "planned"
          },
          position: { mode: "last" }
        }
      ]
    };

    const result = applyWbsChangesets(baseWbs, [changeset]);
    const added = result.nodes.find((node) => node.id === "node-test-candidate");

    expect(added).toBeDefined();
    expect(added!.parentId).toBe("node-project");
    expect(added!.code).toBe("test.candidate");
    expect(added!.name).toBe("Test Candidate");
    expect(added!.type).toBe("workPackage");
    expect(added!.status).toBe("planned");
    expect(result.nodes.length).toBe(beforeCount + 1);
  });
});
