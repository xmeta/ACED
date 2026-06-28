import { mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runInit } from "../src/commands/init.js";
import { collectCheckIssues, runCheck } from "../src/commands/check.js";
import { collectBranchIssues, collectDiffIssues, collectEvidenceGateIssues } from "../src/commands/check-diff.js";
import { buildDoctorReport } from "../src/commands/doctor.js";
import { buildStartArtifacts } from "../src/commands/start.js";
import { buildReviewQueue } from "../src/commands/review-queue.js";
import { buildBlockChangeSet, buildNextTask } from "../src/commands/ai-queue.js";
import { collectHealthIssues, runHealth } from "../src/commands/health.js";
import { buildAiPacket } from "../src/commands/ai-packet.js";
import { readProfile, runProfileSet } from "../src/commands/profile.js";
import { buildTaskRefreshPreview, runTaskRefresh } from "../src/commands/task-refresh.js";
import { buildReviewRequestYaml, buildReviewRouteReport, runReviewRequest } from "../src/commands/review-request.js";
import { buildTrace } from "../src/commands/trace.js";
import { buildApprovalRequestYaml, runApprovalRequest } from "../src/commands/approval-request.js";
import { buildStatus } from "../src/commands/status.js";
import { buildDraftTaskYaml, runTaskGenerate } from "../src/commands/task-generate.js";
import { buildLockedTask, runTaskLock } from "../src/commands/task-lock.js";
import { runWbsValidate, runWbsApply } from "../src/commands/wbs.js";
import { listSpecs, readSpec } from "../src/core/contracts.js";
import { validateWbsDocument } from "../src/core/wbs.js";
import { main } from "../src/cli.js";
import { makeTempRepo, sampleApproval, sampleTask, sampleWbs, sampleSpec, writeJson, writeScwbsProject, writeText, writeYaml, sampleEvidence } from "./helpers.js";

describe("scwbs MVP", () => {
  test("init creates a valid minimal WJS document", () => {
    const root = makeTempRepo();
    expect(runInit(root)).toBe(0);
    expect(validateWbsDocument(root)).toEqual([]);
  });

  test("init stores profile agent and language options", () => {
    const root = makeTempRepo();
    expect(runInit(root, { profile: "lean", agent: "codex", lang: "ja" })).toBe(0);
    const wbs = JSON.parse(readFileSync(path.join(root, "contracts/wbs/project.wbs.json"), "utf8")) as WbsDocument;
    expect(wbs.metadata?.language).toBe("ja-JP");
    expect(wbs.extensions?.scwbs).toEqual({
      profile: "Lean",
      agent: "codex",
      lang: "ja"
    });
  });

  test("invalid WBS document reports validation errors", () => {
    const root = makeTempRepo();
    writeJson(root, "contracts/wbs/project.wbs.json", { schemaVersion: "0.1.0", id: "bad" });
    const issues = validateWbsDocument(root);
    expect(issues.some((issue) => issue.code.startsWith("wbs."))).toBe(true);
  });

  test("spec contracts are first-class files with required metadata", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    const { spec, issues } = readSpec(root, "contracts/specs/SPEC-F001-API.yaml");
    expect(issues).toEqual([]);
    expect(spec?.type).toBe("spec-contract");
    expect(spec?.status).toBe("approved");
    expect(spec?.approvedBy).toBe("Product Owner");
    expect(listSpecs(root).some((entry) => entry.path === "contracts/specs/SPEC-F001-API.yaml" && entry.issues.length === 0)).toBe(true);
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

  test("check-diff flags current branch mismatches", () => {
    const task = sampleTask({ branchName: "task/WBS-001-004-api-implementation" });
    expect(collectBranchIssues(task, "task/WBS-001-004-api-implementation")).toEqual([]);
    expect(collectBranchIssues(task, "task/OTHER").some((issue) => issue.code === "diff.branchName")).toBe(true);
  });

  test("check-diff requires evidence before PR readiness", () => {
    const root = makeTempRepo();
    const task = sampleTask();
    const missingIssues = collectEvidenceGateIssues(root, task);
    expect(missingIssues.some((issue) => issue.code === "diff.evidence.missing")).toBe(true);

    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    expect(collectEvidenceGateIssues(root, task)).toEqual([]);
  });

  test("check-diff flags sensitive meta files unless they are explicitly allowed", () => {
    const root = makeTempRepo();
    const task = sampleTask({
      allowedPaths: ["src/**", "docs/**"],
      humanGateRequiredPaths: []
    });
    const issues = collectDiffIssues(root, task, ["package.json"]);
    expect(issues.some((issue) => issue.code === "diff.metaFile")).toBe(true);
  });

  test("check-diff does not flag explicitly allowed sensitive meta files", () => {
    const root = makeTempRepo();
    const task = sampleTask({
      allowedPaths: ["src/**", "docs/**", "package.json"],
      humanGateRequiredPaths: []
    });
    const issues = collectDiffIssues(root, task, ["package.json"]);
    expect(issues.some((issue) => issue.code === "diff.metaFile")).toBe(false);
  });

  test("check-diff warns on human-gated sensitive meta files without adding a meta-file error", () => {
    const root = makeTempRepo();
    const task = sampleTask({
      allowedPaths: [],
      humanGateRequiredPaths: ["tsconfig.json"]
    });
    const issues = collectDiffIssues(root, task, ["tsconfig.json"]);
    expect(issues.some((issue) => issue.code === "diff.humanGate")).toBe(true);
    expect(issues.some((issue) => issue.code === "diff.metaFile")).toBe(false);
  });

  test("check-diff requires a semantic WBS operation change set when WBS changes", () => {
    const root = makeTempRepo();
    const task = sampleTask({ allowedPaths: ["contracts/**"] });
    expect(collectDiffIssues(root, task, ["contracts/wbs/project.wbs.json"]).some((issue) => issue.code === "diff.wbsOperations")).toBe(true);
    expect(collectDiffIssues(root, task, ["contracts/wbs/project.wbs.json", "contracts/changesets/change.json"]).some((issue) => issue.code === "diff.wbsOperations")).toBe(false);
  });

  test("check-diff validates WBS operation change sets with WJS validate", () => {
    const root = makeTempRepo();
    writeText(root, "wjs/tools/validate.ts", "if (process.argv.includes('--operations')) process.exit(1);");
    const task = sampleTask({ allowedPaths: ["contracts/**"] });
    const issues = collectDiffIssues(root, task, ["contracts/changesets/change.json"]);
    expect(issues.some((issue) => issue.code.startsWith("diff.wbsOperations."))).toBe(true);
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

  test("ai packet includes WBS node, task contract, and stop conditions", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const packet = buildAiPacket(root, "WBS-001-004");
    expect(packet).toContain("API Implementation");
    expect(packet).toContain("WBS-001-004");
    expect(packet).toContain("Stop Conditions");
    expect(packet).toContain("仕様変更レベル判断に迷う場合はLevel 2");
    expect(packet).toContain("Human Gate対象変更はLevel 0またはLevel 1に見えても停止する");
  });

  test("ai packet reports a direct subtree phase on the target node", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs("planned");
    wbs.nodes[1].extensions = {
      scwbs: {
        phase: "bootstrap"
      }
    };
    writeScwbsProject(root);
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    const packet = buildAiPacket(root, "WBS-001-004");
    expect(packet).toContain("## Subtree Phase");
    expect(packet).toContain("- Phase: bootstrap");
  });

  test("ai packet inherits subtree phase from the nearest parent node", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs("planned");
    wbs.nodes.push({
      id: "node-api-child",
      parentId: "node-api",
      code: "1.1.1",
      name: "API Child Task",
      type: "workPackage",
      status: "planned"
    });
    wbs.nodes[1].extensions = {
      scwbs: {
        phase: "normal"
      }
    };
    wbs.relations = [];
    writeScwbsProject(root);
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    writeYaml(
      root,
      "contracts/tasks/WBS-001-004.yaml",
      sampleTask({
        wbsNodeId: "node-api-child"
      }) as unknown as Record<string, unknown>
    );
    const packet = buildAiPacket(root, "WBS-001-004");
    expect(packet).toContain("## Subtree Phase");
    expect(packet).toContain("- Phase: normal");
  });

  test("ai packet reports relation depth filtering", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const packet = buildAiPacket(root, "WBS-001-004", 0);
    expect(packet).toContain("Relation depth: 0");
    expect(packet).toContain("Included WBS nodes: 1");
  });

  test("ai packet supports compact agent formats without breaking default content", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const packet = buildAiPacket(root, "WBS-001-004", 1, "codex");
    expect(packet).toContain("# AI Work Packet (codex)");
    expect(packet).toContain("## Agent Notes");
    expect(packet).toContain("Allowed Paths");
  });

  test("ai block emits a change set for the task node", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const changeSet = JSON.parse(buildBlockChangeSet(root, "WBS-001-004", "Human review needed"));
    expect(changeSet.schemaVersion).toBe("0.1.0");
    expect(changeSet.targetWbsId).toBe("test-wbs");
    expect(changeSet.changeSetId).toBe("changeset-block-WBS-001-004");
    expect(changeSet.author).toBe("ai-agent");
    expect(changeSet.reason).toBe("Human review needed");
    expect(changeSet.dryRun).toBe(true);
    expect(changeSet.operations).toEqual([
      {
        operationId: "op-001",
        operation: "changeNodeStatus",
        nodeId: "node-api",
        status: "blocked"
      }
    ]);
  });

  test("ai next-task excludes a planned task when its dependency is not completed", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs("planned");
    wbs.relations = [
      ...(wbs.relations ?? []),
      {
        id: "rel-api-depends-on-root",
        type: "dependsOn",
        source: "node-api",
        target: "node-root"
      }
    ];
    writeScwbsProject(root);
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    writeYaml(
      root,
      "contracts/tasks/WBS-001-004.yaml",
      sampleTask({
        humanGateRequiredPaths: []
      }) as unknown as Record<string, unknown>
    );
    expect(buildNextTask(root)).toBe("No available planned tasks.\n");
  });

  test("ai next-task includes a planned task when its dependency is completed", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs("planned");
    wbs.nodes[0].status = "completed";
    wbs.relations = [
      ...(wbs.relations ?? []),
      {
        id: "rel-api-depends-on-root",
        type: "dependsOn",
        source: "node-api",
        target: "node-root"
      }
    ];
    writeScwbsProject(root);
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    writeYaml(
      root,
      "contracts/tasks/WBS-001-004.yaml",
      sampleTask({
        humanGateRequiredPaths: []
      }) as unknown as Record<string, unknown>
    );
    expect(buildNextTask(root)).toBe("Planned task candidates:\n- WBS-001-004 | API Implementation | 1.1\n");
  });

  test("health warns when evidence has only low-trust checks", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.lowTrust")).toBe(true);
    expect(issues.some((issue) => issue.code === "health.evidence.check.lowTrust")).toBe(true);
  });

  test("health accepts CI evidence with run id as Level A", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        checks: [
          { name: "test", status: "passed", source: "ci", runId: "github-actions-123456" },
          { name: "typecheck", status: "passed", source: "ci", runId: "github-actions-123456" }
        ]
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.lowTrust")).toBe(false);
    expect(issues.some((issue) => issue.code === "health.evidence.check.lowTrust")).toBe(false);
  });

  test("health accepts local evidence with command and timestamp as Level B", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        checks: [
          { name: "test", status: "passed", source: "local", command: "npm test", executedAt: "2026-06-27T10:00:00+09:00" },
          { name: "typecheck", status: "passed", source: "local", command: "npm run typecheck", executedAt: "2026-06-27T10:00:00+09:00" }
        ]
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.lowTrust")).toBe(false);
    expect(issues.some((issue) => issue.code === "health.evidence.check.lowTrust")).toBe(false);
  });

  test("health errors when evidence changed files touch forbidden paths", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({ changedFiles: ["src/auth/session.ts"] }) as unknown as Record<string, unknown>);
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.changedFiles.forbiddenPaths")).toBe(true);
    expect(runHealth(root)).toBe(1);
  });

  test("health warns when evidence commit is missing", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.commit.missing")).toBe(true);
    expect(runHealth(root)).toBe(0);
  });

  test("health warns when evidence git metadata is missing for review workflow", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation"
        }
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.git.headCommit.missing")).toBe(true);
    expect(issues.some((issue) => issue.code === "health.evidence.git.pullRequest.missing")).toBe(true);
  });

  test("health accepts approval pull request metadata when evidence pull request is missing", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "main",
          headCommit: "abc1234"
        }
      }) as unknown as Record<string, unknown>
    );
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval() as unknown as Record<string, unknown>);
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.git.pullRequest.missing")).toBe(false);
  });

  test("health warns when task contract has no contract lock", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.task.contractLock.missing")).toBe(true);
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

  test("approval request writes a requested approval record", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runApprovalRequest(root, "WBS-001-004", { pullRequest: "#42", note: "Awaiting human review", force: false })).toBe(0);
    const actual = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(actual).toBe(buildApprovalRequestYaml("WBS-001-004", { pullRequest: "#42", note: "Awaiting human review" }));
    expect(actual).toContain("status: requested");
    expect(actual).toContain('pullRequest: "#42"');
  });

  test("approval request refuses to overwrite an existing record without force", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval() as unknown as Record<string, unknown>);
    const before = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");

    expect(runApprovalRequest(root, "WBS-001-004", { pullRequest: "#99", note: "Updated", force: false })).toBe(1);
    expect(readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8")).toBe(before);
    expect(runApprovalRequest(root, "WBS-001-004", { pullRequest: "#99", note: "Updated", force: true })).toBe(0);
    expect(readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8")).not.toBe(before);
  });

  test("approval request CLI accepts multi-word notes", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(main(["approval", "request", "--task", "WBS-001-004", "--pull-request", "#42", "--note", "Awaiting", "human", "review"], root)).toBe(0);
    const actual = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(actual).toContain("  - Awaiting human review");
  });

  test("approval request CLI accepts inline note syntax", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(main(["approval", "request", "--task", "WBS-001-004", "--note=Awaiting human review"], root)).toBe(0);
    const actual = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(actual).toContain("  - Awaiting human review");
  });

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

  test("profile set updates the WBS profile", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(readProfile(root)).toBe("Standard");
    expect(runProfileSet(root, "lean")).toBe(0);
    expect(readProfile(root)).toBe("Lean");
  });

  test("review request writes a review record and trace shows missing links", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(buildReviewRequestYaml("WBS-001-004", { pullRequest: "#42" })).toContain("type: review");
    expect(runReviewRequest(root, "WBS-001-004", { pullRequest: "#42", force: false })).toBe(0);
    const trace = buildTrace(root, "WBS-001-004");
    expect(trace).toContain("Review: RVW-WBS-001-004 requested");
    expect(trace).toContain("Evidence: missing");
  });

  test("review route and request include requested reviewers from evidence changes", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        changedFiles: [
          "src/features/api/index.ts",
          "contracts/tasks/WBS-001-004.yaml"
        ]
      }) as unknown as Record<string, unknown>
    );
    const route = buildReviewRouteReport(root, "WBS-001-004");
    expect(route).toContain("code-owner");
    expect(route).toContain("methodology-owner");

    expect(runReviewRequest(root, "WBS-001-004", { pullRequest: "#42", force: false })).toBe(0);
    const review = readFileSync(path.join(root, "contracts/reviews/WBS-001-004.yaml"), "utf8");
    expect(review).toContain("requestedReviewers:");
    expect(review).toContain("role: code-owner");
    expect(review).toContain("role: methodology-owner");
  });

  test("health warns when changed test files lack test quality metadata", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        changedFiles: ["tests/features/api/api.test.ts"]
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.testQuality.missing")).toBe(true);
  });

  test("evidence test quality notes are accepted", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        changedFiles: ["tests/features/api/api.test.ts"],
        testQuality: {
          assertionsAdded: true,
          testsDisabled: false,
          coverageDecreased: false,
          notes: ["API success case asserts response body"]
        }
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "evidence.testQuality")).toBe(false);
    expect(issues.some((issue) => issue.code === "health.evidence.testQuality.missing")).toBe(false);
  });

  test("status summarizes WBS node status", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "blocked");
    const status = buildStatus(root);
    expect(status).toContain("- blocked: 1");
  });

  test("review queue lists tasks with evidence awaiting review", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    const queue = buildReviewQueue(root);
    expect(queue).toContain("Review Queue:");
    expect(queue).toContain("WBS-001-004");
    expect(queue).toContain("branch: task/WBS-001-004-api-implementation");
    expect(queue).toContain("evidence exists and the WBS node is ready for human review");
    expect(queue).toContain("suggestedAction: create or record PR, then human review for completion");
  });

  test("review queue reports incomplete dependencies that block completion", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs("ready");
    wbs.relations = [
      ...(wbs.relations ?? []),
      {
        id: "rel-api-depends-on-root",
        type: "dependsOn",
        source: "node-api",
        target: "node-root"
      }
    ];
    writeScwbsProject(root, "planned");
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    const queue = buildReviewQueue(root);
    expect(queue).toContain("evidence exists and the WBS node is not completed");
    expect(queue).toContain("warning: dependsOn node 1 Root is not completed");
    expect(queue).toContain("completionBlockedBy: 1 Root");
    expect(queue).toContain("suggestedAction: review evidence now, but defer completion until dependencies are completed");
  });

  test("review queue shows pull request metadata when present", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "main",
          headCommit: "abc1234",
          pullRequest: "#42"
        }
      }) as unknown as Record<string, unknown>
    );
    const queue = buildReviewQueue(root);
    expect(queue).toContain("pullRequest: #42");
  });

  test("review queue shows approval status and approval pull request metadata", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "main",
          headCommit: "abc1234"
        }
      }) as unknown as Record<string, unknown>
    );
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval() as unknown as Record<string, unknown>);
    const queue = buildReviewQueue(root);
    expect(queue).toContain("pullRequest: #42");
    expect(queue).toContain("approvalStatus: requested");
    expect(queue).toContain("warning: human review approval has been requested but is not approved yet");
  });

  test("review queue warns when pull request metadata is missing", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "main",
          headCommit: "abc1234"
        }
      }) as unknown as Record<string, unknown>
    );
    const queue = buildReviewQueue(root);
    expect(queue).toContain("warning: no pull request is recorded for this review candidate");
  });

  test("review queue lists missing approval for human gate changes", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        changedFiles: ["src/security/policy.ts"]
      }) as unknown as Record<string, unknown>
    );
    const queue = buildReviewQueue(root);
    expect(queue).toContain("human gate paths were changed but no approval record exists");
  });

  test("review queue is empty when there is nothing pending", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    const queue = buildReviewQueue(root);
    expect(queue).toBe("Review Queue:\n- None\n");
  });

  test("review queue includes review health summary sections", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs("ready");
    wbs.relations = [
      ...(wbs.relations ?? []),
      {
        id: "rel-api-depends-on-root",
        type: "dependsOn",
        source: "node-api",
        target: "node-root"
      }
    ];
    writeScwbsProject(root, "planned");
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);

    const queue = buildReviewQueue(root);
    expect(queue).toContain("Review Health:");
    expect(queue).toContain("- 1 review candidates");
    expect(queue).toContain("- 1 candidates missing pull request metadata");
    expect(queue).toContain("- 1 candidates blocked by incomplete dependencies");
    expect(queue).toContain("- 0 candidates ready for completion review");
    expect(queue).toContain("Ready for completion review:");
    expect(queue).toContain("Blocked review candidates:");
    expect(queue).toContain("- WBS-001-004 blocked by 1 Root");
    expect(queue).toContain("Missing PR metadata:");
    expect(queue).toContain("- WBS-001-004");
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
