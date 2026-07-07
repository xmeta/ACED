import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runInit } from "../src/commands/init.js";
import { collectCheckIssues, runCheck } from "../src/commands/check.js";
import { collectBranchIssues, collectDiffIssues, collectEvidenceGateIssues, runCheckDiff } from "../src/commands/check-diff.js";
import { buildCollectedEvidence, runEvidenceCollect } from "../src/commands/evidence-collect.js";
import { buildDoctorReport } from "../src/commands/doctor.js";
import { buildStartArtifacts } from "../src/commands/start.js";
import { buildReviewQueue } from "../src/commands/review-queue.js";
import { buildBlockChangeSet, buildNextTask, runAiBlock } from "../src/commands/ai-queue.js";
import { collectHealthIssues, runHealth } from "../src/commands/health.js";
import { buildAiPacket } from "../src/commands/ai-packet.js";
import { readProfile, runProfileSet } from "../src/commands/profile.js";
import { buildTaskRefreshPreview, runTaskRefresh } from "../src/commands/task-refresh.js";
import { buildReviewRequestYaml, buildReviewRouteReport, runReviewRequest } from "../src/commands/review-request.js";
import { buildTrace } from "../src/commands/trace.js";
import { buildApprovalApproveYaml, buildApprovalRequestYaml, runApprovalApprove, runApprovalRequest } from "../src/commands/approval-request.js";
import { buildCompletionPreview, runCompletionApply } from "../src/commands/completion.js";
import { buildStatus } from "../src/commands/status.js";
import { buildNextAction } from "../src/commands/next.js";
import { buildDraftTaskYaml, runTaskGenerate } from "../src/commands/task-generate.js";
import { buildLockedTask, runTaskLock } from "../src/commands/task-lock.js";
import { buildCoreTaskNew, nextDraftTaskId, runTaskNew } from "../src/commands/task-new.js";
import { runFinish } from "../src/commands/finish.js";
import { runFix } from "../src/commands/fix.js";
import { resolveCheckCommand, isKnownCheck } from "../src/core/check-catalog.js";
import { buildWbsCandidatesFromTaskIndex, runWbsValidate, runWbsApply, verifyWbsChangesets } from "../src/commands/wbs.js";
import { listSpecChanges, listSpecs, readApproval, readBlock, readEvidence, readRegistry, readReview, readSpec, readSpecChange, readTask } from "../src/core/contracts.js";
import { parseSimpleYaml, stringifySimpleYaml } from "../src/core/yaml.js";
import { baseBranchStatus, branchChangedFiles, branchDiffHash, filesAddedOnBothSides, headCommit, workingTreeChangedFiles } from "../src/core/git.js";
import { validateWbsDocument } from "../src/core/wbs.js";
import { main } from "../src/cli.js";
import { makeTempRepo, sampleApproval, sampleTask, sampleWbs, sampleSpec, sampleSpecChange, writeJson, writeScwbsProject, writeText, writeYaml, sampleEvidence } from "./helpers.js";

describe("scwbs MVP", () => {
  function writeFakeWjsApply(root: string): void {
    mkdirSync(path.join(root, "wjs/tools"), { recursive: true });
    writeText(root, "wjs/tools/apply.ts", "// marker file for the WJS apply tool\n");
    writeText(root, "wjs/tools/apply.cjs", `
const fs = require("node:fs");
const args = process.argv.slice(2);
const wbsPath = args[0];
const changeSetPath = args[1];
const outputIndex = args.indexOf("-o");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : wbsPath;
const wbs = JSON.parse(fs.readFileSync(wbsPath, "utf8"));
const changeSet = JSON.parse(fs.readFileSync(changeSetPath, "utf8"));
for (const operation of changeSet.operations) {
  const node = wbs.nodes.find((item) => item.id === operation.nodeId);
  if (node) node.status = operation.status;
}
fs.writeFileSync(outputPath, JSON.stringify(wbs, null, 2) + "\\n");
`);
    writeJson(root, "wjs/package.json", {
      scripts: {
        apply: "node tools/apply.cjs"
      }
    });
  }

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

  test("WBS document duplicate code validation", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs();
    wbs.nodes.push({
      id: "node-duplicate-code",
      parentId: wbs.rootId,
      code: wbs.nodes[0].code,
      name: "Duplicate Code Node",
      type: "workPackage",
      status: "planned"
    });
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    const issues = validateWbsDocument(root);
    expect(issues.some((issue) => issue.code === "wbs.code.duplicate")).toBe(true);
  });

  test("WBS document status and progress mismatch validation", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs();
    wbs.nodes[0].status = "completed";
    wbs.nodes[0].progressPercent = 50;
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    let issues = validateWbsDocument(root);
    expect(issues.some((issue) => issue.code === "wbs.status.progress.mismatch")).toBe(true);

    wbs.nodes[0].status = "inProgress";
    wbs.nodes[0].progressPercent = 100;
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    issues = validateWbsDocument(root);
    expect(issues.some((issue) => issue.code === "wbs.status.progress.mismatch")).toBe(true);
  });

  test("WBS document parent completed with incomplete child validation", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs();
    const parentNode = wbs.nodes.find(n => n.id === wbs.rootId);
    if (parentNode) {
      parentNode.status = "completed";
      parentNode.progressPercent = 100;
    }
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    const issues = validateWbsDocument(root);
    expect(issues.some((issue) => issue.code === "wbs.hierarchy.incomplete_child")).toBe(true);
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

  test("spec change proposals are first-class files with required metadata", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/spec-changes/SCP-F001-API-001.yaml", sampleSpecChange() as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/registry.yaml", {
      projectId: "test-wbs",
      contracts: [
        {
          id: "SPEC-F001-API",
          type: "spec",
          path: "contracts/specs/SPEC-F001-API.yaml",
          status: "approved",
          version: "1.0.0",
          featureId: "F001",
          relatedTask: "WBS-001-004"
        },
        {
          id: "SCP-F001-API-001",
          type: "spec-change",
          path: "contracts/spec-changes/SCP-F001-API-001.yaml",
          status: "proposed",
          version: "1.1.0",
          relatedTask: "WBS-001-004"
        },
        {
          id: "TASK-WBS-001-004",
          type: "task",
          path: "contracts/tasks/WBS-001-004.yaml",
          featureId: "F001"
        }
      ]
    });

    const { specChange, issues } = readSpecChange(root, "contracts/spec-changes/SCP-F001-API-001.yaml");
    expect(issues).toEqual([]);
    expect(specChange?.type).toBe("spec-change-proposal");
    expect(specChange?.status).toBe("proposed");
    expect(listSpecChanges(root).some((entry) => entry.path === "contracts/spec-changes/SCP-F001-API-001.yaml" && entry.issues.length === 0)).toBe(true);
    expect(collectCheckIssues(root).some((issue) => issue.code.startsWith("specChange."))).toBe(false);
  });

  test("YAML contract reads run JSON Schema validation after parsing", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...sampleTask(),
      mode: "full"
    });

    const { task, issues } = readTask(root, "WBS-001-004");
    expect(task).toBeUndefined();
    expect(issues.some((issue) => issue.code === "task.schema")).toBe(true);
  });

  test("JSON Schema validation applies to every YAML contract kind", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/registry.yaml", { projectId: "test-wbs", contracts: [{ id: "TASK-WBS-001-004", type: "bad", path: "contracts/tasks/WBS-001-004.yaml" }] });
    writeYaml(root, "contracts/specs/SPEC-F001-API.yaml", { ...sampleSpec(), status: "archived" });
    writeYaml(root, "contracts/spec-changes/SCP-F001-API-001.yaml", { ...sampleSpecChange(), status: "waiting" });
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", { ...sampleEvidence(), checks: [{ name: "test", status: "unknown" }] });
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", { ...sampleApproval(), status: "waiting" });
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "pending",
      reviewProfile: "self-review",
      groundTruth: ["contracts/evidence/WBS-001-004.yaml"]
    });

    expect(readRegistry(root).issues.some((issue) => issue.code === "registry.schema")).toBe(true);
    expect(readSpec(root, "contracts/specs/SPEC-F001-API.yaml").issues.some((issue) => issue.code === "spec.schema")).toBe(true);
    expect(readSpecChange(root, "contracts/spec-changes/SCP-F001-API-001.yaml").issues.some((issue) => issue.code === "specChange.schema")).toBe(true);
    expect(readEvidence(root, "WBS-001-004").issues.some((issue) => issue.code === "evidence.schema")).toBe(true);
    expect(readApproval(root, "WBS-001-004").issues.some((issue) => issue.code === "approval.schema")).toBe(true);
    expect(readReview(root, "WBS-001-004").issues.some((issue) => issue.code === "review.schema")).toBe(true);
  });

  test("semantic validation still owns repository consistency after schema validation", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ wbsNodeId: "missing-node" }) as unknown as Record<string, unknown>);

    const directRead = readTask(root, "WBS-001-004");
    expect(directRead.issues).toEqual([]);
    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code === "task.wbsNodeId")).toBe(true);
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

  test("check-diff errors on human-gated sensitive meta files without approved approval", () => {
    const root = makeTempRepo();
    const task = sampleTask({
      allowedPaths: [],
      humanGateRequiredPaths: ["tsconfig.json"]
    });
    const issues = collectDiffIssues(root, task, ["tsconfig.json"]);
    expect(issues.some((issue) => issue.code === "diff.humanGate" && issue.severity === "error")).toBe(true);
    expect(issues.find((issue) => issue.code === "diff.humanGate")?.fixCommand).toContain("npm run scwbs -- approval request --task WBS-001-004");
    expect(issues.some((issue) => issue.code === "diff.metaFile")).toBe(false);
  });

  test("check-diff accepts human-gated sensitive meta files with approved approval", () => {
    const root = makeTempRepo();
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      subjectHeadCommit: "abc1234",
      diffHash: "diff1234"
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval({
      status: "approved",
      approvedBy: "Human Reviewer",
      approvedAt: "2026-07-05T14:30:00.000Z",
      headCommit: "abc1234",
      diffHash: "diff1234"
    }) as unknown as Record<string, unknown>);
    const task = sampleTask({
      allowedPaths: [],
      humanGateRequiredPaths: ["tsconfig.json"]
    });
    const issues = collectDiffIssues(root, task, ["tsconfig.json"]);
    expect(issues.some((issue) => issue.code === "diff.humanGate")).toBe(false);
    expect(issues.some((issue) => issue.code === "diff.metaFile")).toBe(false);
  });

  test("check-diff rejects human-gate approvals that do not match evidence diff scope", () => {
    const root = makeTempRepo();
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      subjectHeadCommit: "abc1234",
      diffHash: "diff1234"
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval({
      status: "approved",
      approvedBy: "Human Reviewer",
      approvedAt: "2026-07-05T14:30:00.000Z",
      headCommit: "abc1234",
      diffHash: "old-diff"
    }) as unknown as Record<string, unknown>);
    const task = sampleTask({
      allowedPaths: [],
      humanGateRequiredPaths: ["tsconfig.json"]
    });
    const issues = collectDiffIssues(root, task, ["tsconfig.json"]);
    expect(issues.some((issue) => issue.code === "diff.humanGate" && issue.severity === "error")).toBe(true);
  });

  test("check-diff treats managedContractPaths as exempt from allowedPaths and the meta-file guard (M2-019)", () => {
    const root = makeTempRepo();
    const task = sampleTask({
      allowedPaths: ["src/**"],
      managedContractPaths: ["contracts/evidence/WBS-001-004.yaml", "package.json"]
    });
    const issues = collectDiffIssues(root, task, ["contracts/evidence/WBS-001-004.yaml", "package.json"]);
    expect(issues.some((issue) => issue.code === "diff.allowedPaths")).toBe(false);
    expect(issues.some((issue) => issue.code === "diff.metaFile")).toBe(false);
  });

  test("check-diff never exempts forbiddenPaths via managedContractPaths (M2-019)", () => {
    const root = makeTempRepo();
    const task = sampleTask({
      forbiddenPaths: ["src/auth/**"],
      managedContractPaths: ["src/auth/**"]
    });
    const issues = collectDiffIssues(root, task, ["src/auth/session.ts"]);
    expect(issues.some((issue) => issue.code === "diff.forbiddenPaths")).toBe(true);
  });

  test("check-diff issues always carry a fixCommand (M2-022)", () => {
    const root = makeTempRepo();
    const task = sampleTask();
    const issues = collectDiffIssues(root, task, ["src/unrelated/handler.ts"]);
    const errors = issues.filter((issue) => issue.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((issue) => typeof issue.fixCommand === "string" && issue.fixCommand.length > 0)).toBe(true);
  });

  test("check-diff can emit CI-friendly JSON output", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ branchName: "master" }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };
    try {
      expect(runCheckDiff(root, "WBS-001-004", { baseRef: "base", json: true })).toBe(0);
    } finally {
      console.log = originalLog;
    }
    expect(JSON.parse(output.join("\n"))).toMatchObject({ status: "pass", taskId: "WBS-001-004", issues: [] });
  });

  test("check-diff requires a semantic WBS operation change set when WBS changes", () => {
    const root = makeTempRepo();
    const task = sampleTask({ allowedPaths: ["contracts/**"] });
    expect(collectDiffIssues(root, task, ["contracts/wbs/project.wbs.json"]).some((issue) => issue.code === "diff.wbs.changeset.required")).toBe(true);
    expect(collectDiffIssues(root, task, ["contracts/wbs/project.wbs.json", "contracts/changesets/change.json"]).some((issue) => issue.code === "diff.wbs.changeset.required")).toBe(false);
  });

  test("check-diff validates WBS operation change sets with WJS validate", () => {
    const root = makeTempRepo();
    writeText(root, "wjs/tools/validate.ts", "if (process.argv.includes('--operations')) process.exit(1);");
    const task = sampleTask({ allowedPaths: ["contracts/**"] });
    const issues = collectDiffIssues(root, task, ["contracts/changesets/change.json"]);
    expect(issues.some((issue) => issue.code.startsWith("diff.wbsOperations."))).toBe(true);
  });

  test("git changed file helpers split working-tree and branch diff basis", () => {
    const root = makeTempRepo();
    writeText(root, "src/features/api/index.ts", "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    writeText(root, "src/features/api/index.ts", "export const value = 2;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "branch change"], { cwd: root, stdio: "ignore" });
    writeText(root, "src/features/api/uncommitted.ts", "export const pending = true;\n");
    writeText(root, "src/features/api/untracked.ts", "export const extra = true;\n");

    expect(branchChangedFiles(root, "base")).toEqual(["src/features/api/index.ts"]);
    expect(workingTreeChangedFiles(root).sort()).toEqual([
      "src/features/api/uncommitted.ts",
      "src/features/api/untracked.ts"
    ]);
  });

  test("git helpers detect branch lag and same-path additions on base", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });

    execFileSync("git", ["switch", "-c", "feature"], { cwd: root, stdio: "ignore" });
    writeYaml(root, "contracts/tasks/SCWBS-030.yaml", sampleTask({ id: "SCWBS-030", featureId: "F-OURS" }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feature task"], { cwd: root, stdio: "ignore" });

    execFileSync("git", ["switch", "-c", "upstream", "refs/remotes/origin/main"], { cwd: root, stdio: "ignore" });
    writeYaml(root, "contracts/tasks/SCWBS-030.yaml", sampleTask({ id: "SCWBS-030", featureId: "F-THEIRS" }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "upstream task"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
    execFileSync("git", ["switch", "feature"], { cwd: root, stdio: "ignore" });

    expect(baseBranchStatus(root).isBehind).toBe(true);
    expect(filesAddedOnBothSides(root)).toContain("contracts/tasks/SCWBS-030.yaml");
  }, 30000);

  test("check-diff uses branch diff files from the requested base", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const branchName = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ branchName }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    writeText(root, "src/auth/session.ts", "export const forbidden = true;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "forbidden branch change"], { cwd: root, stdio: "ignore" });

    expect(runCheckDiff(root, "WBS-001-004", { baseRef: "base" })).toBe(1);
  });

  test("evidence collect records branch diff provenance from the requested base", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: [] }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    writeText(root, "src/features/api/index.ts", "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feature"], { cwd: root, stdio: "ignore" });

    const evidence = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base" });
    expect(evidence.git?.base).toBe("base");
    expect(evidence.git?.baseCommit).toBeTruthy();
    expect(evidence.git?.headCommit).toBe(headCommit(root));
    expect(evidence.subjectHeadCommit).toBe(headCommit(root));
    expect(evidence.git?.subjectHeadCommit).toBe(headCommit(root));
    expect(evidence.git?.changedFilesBasis).toBe("branch-diff");
    expect(evidence.diffHash).toBe(branchDiffHash(root, "base"));
    expect(evidence.git?.diffHash).toBe(branchDiffHash(root, "base"));
    expect(evidence.changedFiles).toContain("src/features/api/index.ts");
  });

  test("evidence diffHash is stable for the same subject diff", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: [] }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    writeText(root, "src/features/api/index.ts", "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feature"], { cwd: root, stdio: "ignore" });

    const first = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base" });
    const second = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base" });
    expect(first.diffHash).toMatch(/^sha256:/);
    expect(first.diffHash).toBe(second.diffHash);
  });

  test("evidence collect records explicit pull request metadata", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: [] }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    const evidence = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base", pullRequest: "#42" });
    expect(evidence.git?.pullRequest).toBe("#42");
  });

  test("evidence collect preserves existing pull request metadata when refreshed", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: [] }) as unknown as Record<string, unknown>);
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "feature",
          base: "base",
          baseCommit: "abc123",
          changedFilesBasis: "branch-diff",
          pullRequest: "#42",
          headCommit: "def456"
        }
      }) as unknown as Record<string, unknown>
    );
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    expect(runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true })).toBe(0);
    const { evidence } = readEvidence(root, "WBS-001-004");
    expect(evidence?.git?.pullRequest).toBe("#42");
  });

  test("evidence collect records explicit test quality metadata", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: [] }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    const evidence = buildCollectedEvidence(root, "WBS-001-004", {
      baseRef: "base",
      testQuality: {
        assertionsAdded: true,
        testsDisabled: false,
        coverageDecreased: false,
        notes: ["Added regression coverage."]
      }
    });
    expect(evidence.testQuality).toEqual({
      assertionsAdded: true,
      testsDisabled: false,
      coverageDecreased: false,
      notes: ["Added regression coverage."]
    });
  });

  test("evidence collect preserves existing test quality metadata when refreshed", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: [] }) as unknown as Record<string, unknown>);
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        testQuality: {
          assertionsAdded: true,
          testsDisabled: false,
          coverageDecreased: false,
          notes: ["Existing test quality rationale."]
        }
      }) as unknown as Record<string, unknown>
    );
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    expect(runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true })).toBe(0);
    const { evidence } = readEvidence(root, "WBS-001-004");
    expect(evidence?.testQuality).toEqual({
      assertionsAdded: true,
      testsDisabled: false,
      coverageDecreased: false,
      notes: ["Existing test quality rationale."]
    });
  });

  test("evidence collect records bounded diagnostics for failed checks", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    writeJson(root, "package.json", {
      scripts: {
        test: "node -e \"console.log('stdout ' + 'x'.repeat(1200)); console.error('stderr failure'); process.exit(7)\""
      }
    });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: ["test"] }) as unknown as Record<string, unknown>);

    const evidence = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base" });
    const check = evidence.checks[0];
    expect(check).toMatchObject({
      name: "test",
      status: "failed",
      command: "npm test",
      exitStatus: 7
    });
    expect(check?.stdoutSummary).toContain("[truncated]");
    expect(check?.stdoutSummary?.length).toBeLessThanOrEqual(1000);
    expect(check?.stderrSummary).toContain("stderr failure");
  }, 30000);

  test("evidence collect preserves passed-check evidence shape", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    writeJson(root, "package.json", {
      scripts: {
        test: "node -e \"console.log('ok')\""
      }
    });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: ["test"] }) as unknown as Record<string, unknown>);

    const evidence = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base" });
    const check = evidence.checks[0];
    expect(check).toMatchObject({
      name: "test",
      status: "passed",
      command: "npm test"
    });
    expect(check).not.toHaveProperty("exitStatus");
    expect(check).not.toHaveProperty("stdoutSummary");
    expect(check).not.toHaveProperty("stderrSummary");
  }, 30000);

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
    expect(buildNextTask(root)).toBe("No available planned tasks.\nFollow-up work remains for existing contracts. Run `scwbs next` for Evidence or review guidance.\n\n");
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

  test("ai next-task excludes a planned task that already has evidence", () => {
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
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);

    expect(buildNextTask(root)).toContain("No available planned tasks.");
    expect(buildNextTask(root)).toContain("Run `scwbs next` for Evidence or review guidance.");
  });

  test("ai next-task points to scwbs next when no planned task is available but evidence is missing", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(
      root,
      "contracts/tasks/WBS-001-004.yaml",
      sampleTask({
        humanGateRequiredPaths: []
      }) as unknown as Record<string, unknown>
    );

    expect(buildNextTask(root)).toContain("No available planned tasks.");
    expect(buildNextTask(root)).toContain("Run `scwbs next` for Evidence or review guidance.");
    expect(buildNextAction(root)).toContain("Collect evidence for WBS-001-004");
  });

  test("next does not request a duplicate review when review metadata exists", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
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
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });

    const next = buildNextAction(root);
    expect(next).toContain("Human review for WBS-001-004");
    expect(next).toContain("scwbs review-queue");
    expect(next).not.toContain("scwbs review request --task WBS-001-004");
  });

  test("next does not suggest completion review when review candidates are blocked", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({
      id: "WBS-001-005",
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: {
        branch: "task/WBS-001-004-api-implementation",
        base: "main",
        headCommit: "abc1234",
        pullRequest: "#42"
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-005.yaml", sampleEvidence({
      id: "EVD-001-005",
      taskId: "WBS-001-005"
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });

    const next = buildNextAction(root);
    expect(next).toContain("Review blocked candidates");
    expect(next).toContain("completion is blocked by prerequisites");
    expect(next).not.toContain("Human review for WBS-001-004");
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

  test("health treats managed contract paths as allowed path exceptions", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(
      root,
      "contracts/tasks/WBS-001-004.yaml",
      sampleTask({
        allowedPaths: ["src/**"],
        managedContractPaths: ["contracts/changesets/WBS-001-004-link-wbs-node.json"]
      }) as unknown as Record<string, unknown>
    );
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        changedFiles: ["contracts/changesets/WBS-001-004-link-wbs-node.json"]
      }) as unknown as Record<string, unknown>
    );

    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.changedFiles.allowedPaths")).toBe(false);
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
    expect(issues.some((issue) => issue.code === "health.evidence.subjectHeadCommit.missing")).toBe(true);
    expect(issues.some((issue) => issue.code === "health.evidence.git.pullRequest.missing")).toBe(true);
  });

  test("evidence git provenance fields are validated as strings", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "main",
          baseCommit: "abc1234",
          changedFilesBasis: false as unknown as string,
          headCommit: "abc1234"
        }
      }) as unknown as Record<string, unknown>
    );
    const { issues } = readEvidence(root, "WBS-001-004");
    expect(issues.some((issue) => issue.code === "evidence.git")).toBe(true);
  });

  test("health warns when evidence provenance basis is missing", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.git.changedFilesBasis.missing")).toBe(true);
  });

  test("health warns when evidence head commit is stale", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["switch", "-c", "task/WBS-001-004-api-implementation"], { cwd: root, stdio: "ignore" });
    const oldHead = headCommit(root) ?? "";
    writeText(root, "src/features/api/index.ts", "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feature"], { cwd: root, stdio: "ignore" });
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "base",
          baseCommit: oldHead,
          changedFilesBasis: "branch-diff",
          headCommit: oldHead
        }
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.subjectHeadCommit.stale")).toBe(true);
  }, 15000);

  test("health ignores historical stale evidence on other branches", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    const oldHead = headCommit(root) ?? "";
    writeText(root, "src/features/api/index.ts", "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "later-work"], { cwd: root, stdio: "ignore" });
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "base",
          baseCommit: oldHead,
          changedFilesBasis: "branch-diff",
          headCommit: oldHead
        }
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.git.headCommit.stale")).toBe(false);
  });

  test("health accepts post-evidence metadata-only commits", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    const evidenceHead = headCommit(root) ?? "";
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "base",
          baseCommit: evidenceHead,
          changedFilesBasis: "branch-diff",
          headCommit: evidenceHead
        }
      }) as unknown as Record<string, unknown>
    );
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "evidence"], { cwd: root, stdio: "ignore" });
    writeYaml(root, "contracts/registry.yaml", {
      projectId: "test-wbs",
      contracts: [
        {
          id: "TASK-WBS-001-004",
          type: "task",
          path: "contracts/tasks/WBS-001-004.yaml",
          featureId: "F001"
        },
        {
          id: "EVD-WBS-001-004",
          type: "evidence",
          path: "contracts/evidence/WBS-001-004.yaml",
          relatedTask: "WBS-001-004"
        }
      ]
    });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "registry"], { cwd: root, stdio: "ignore" });
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.git.headCommit.stale")).toBe(false);
  }, 30000);

  test("health accepts post-evidence metadata-only commits with subjectHeadCommit", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    writeText(root, "src/features/api/index.ts", "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feature"], { cwd: root, stdio: "ignore" });
    const evidence = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base" });
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", evidence as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "evidence"], { cwd: root, stdio: "ignore" });
    writeYaml(root, "contracts/registry.yaml", {
      projectId: "test-wbs",
      contracts: [
        {
          id: "TASK-WBS-001-004",
          type: "task",
          path: "contracts/tasks/WBS-001-004.yaml",
          featureId: "F001"
        },
        {
          id: "EVD-WBS-001-004",
          type: "evidence",
          path: "contracts/evidence/WBS-001-004.yaml",
          relatedTask: "WBS-001-004"
        }
      ]
    });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "registry"], { cwd: root, stdio: "ignore" });
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.subjectHeadCommit.stale")).toBe(false);
    expect(issues.some((issue) => issue.code === "health.evidence.diffHash.stale")).toBe(false);
  }, 30000);

  test("health ignores missing diffHash on historical evidence from other branches", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    const oldHead = headCommit(root) ?? "";
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "base",
          baseCommit: oldHead,
          changedFilesBasis: "branch-diff",
          subjectHeadCommit: oldHead,
          headCommit: oldHead
        }
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.diffHash.missing")).toBe(false);
  });

  test("health warns when active branch evidence has no diffHash", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    execFileSync("git", ["switch", "-c", "task/WBS-001-004-api-implementation"], { cwd: root, stdio: "ignore" });
    const evidenceHead = headCommit(root) ?? "";
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "base",
          baseCommit: evidenceHead,
          changedFilesBasis: "branch-diff",
          subjectHeadCommit: evidenceHead,
          headCommit: evidenceHead
        }
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.diffHash.missing")).toBe(true);
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

  test("health warns when tracked text files contain CRLF line endings", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeText(root, "README.md", "title\r\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.workingTree.crlf" && issue.message.includes("README.md"))).toBe(true);
  });

  test("health warns when current branch is behind base and contract paths collide", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });

    execFileSync("git", ["switch", "-c", "feature"], { cwd: root, stdio: "ignore" });
    writeYaml(root, "contracts/tasks/SCWBS-030.yaml", sampleTask({ id: "SCWBS-030", featureId: "F-OURS" }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feature task"], { cwd: root, stdio: "ignore" });

    execFileSync("git", ["switch", "-c", "upstream", "refs/remotes/origin/main"], { cwd: root, stdio: "ignore" });
    writeYaml(root, "contracts/tasks/SCWBS-030.yaml", sampleTask({ id: "SCWBS-030", featureId: "F-THEIRS" }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "upstream task"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
    execFileSync("git", ["switch", "feature"], { cwd: root, stdio: "ignore" });

    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.git.baseBehind")).toBe(true);
    expect(issues.some((issue) => issue.code === "health.git.addedPathCollision" && issue.message.includes("contracts/tasks/SCWBS-030.yaml"))).toBe(true);
  }, 15000);

  test("health warns when a submodule worktree is dirty", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    mkdirSync(path.join(root, "wjs"), { recursive: true });
    execFileSync("git", ["init"], { cwd: path.join(root, "wjs"), stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: path.join(root, "wjs") });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: path.join(root, "wjs") });
    writeText(root, "wjs/README.md", "clean\n");
    execFileSync("git", ["add", "README.md"], { cwd: path.join(root, "wjs") });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: path.join(root, "wjs"), stdio: "ignore" });
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "./wjs", "vendor/wjs"], { cwd: root, stdio: "ignore" });
    writeText(root, "vendor/wjs/README.md", "dirty\n");
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.submodule.dirty" && issue.message.includes("vendor/wjs"))).toBe(true);
  }, 15000);

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

  test("next prioritizes failed evidence checks before review work", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      checks: [
        { name: "test", status: "failed" },
        { name: "typecheck", status: "passed" }
      ]
    }) as unknown as Record<string, unknown>);

    const next = buildNextAction(root);
    expect(next).toContain("Fix failed check for WBS-001-004");
    expect(next).toContain("Evidence check failed: test");
  });

  test("core packet tiny stays short and prints finish and block commands", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    const output: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(main(["packet", "--task", "WBS-001-004", "--tiny"], root)).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }

    const packet = output.join("");
    expect(packet.split("\n").length).toBeLessThanOrEqual(50);
    expect(packet).toContain("npm run scwbs -- finish --task WBS-001-004");
    expect(packet).toContain('npm run scwbs -- block "reason" --task WBS-001-004');
    expect(packet).not.toContain("Context Filter");
  });

  test("core command aliases route to existing approval and block commands", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(main(["request-approval", "--task", "WBS-001-004", "--pr", "#42", "--note", "Needs review"], root)).toBe(0);
    expect(readApproval(root, "WBS-001-004").approval?.status).toBe("requested");
    expect(main(["approve", "--task", "WBS-001-004", "--pr", "#42", "--reason=Reviewed"], root)).toBe(0);
    expect(readApproval(root, "WBS-001-004").approval?.status).toBe("approved");
    expect(main(["block", "Human Gate required", "--task", "WBS-001-004"], root)).toBe(0);
    expect(readBlock(root, "WBS-001-004").block?.category).toBe("human-gate");
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

  test("approval approve writes a human approved record", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      subjectHeadCommit: "abc1234",
      diffHash: "diff1234"
    }) as unknown as Record<string, unknown>);

    expect(runApprovalApprove(root, "WBS-001-004", { pullRequest: "#42", reason: "Evidence and PR reviewed", force: false })).toBe(0);
    const actual = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(actual).toContain("status: approved");
    expect(actual).toContain("approvedBy: human");
    expect(actual).toContain("approvedAt:");
    expect(actual).toContain("headCommit: abc1234");
    expect(actual).toContain("diffHash: diff1234");
    expect(actual).toContain('pullRequest: "#42"');
    expect(actual).toContain("reason: Evidence and PR reviewed");
  });

  test("approval approve rejects AI execution mode", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runApprovalApprove(root, "WBS-001-004", { reason: "AI should not approve", actor: "ai", force: false })).toBe(1);
    expect(readApproval(root, "WBS-001-004").approval).toBeUndefined();
  });

  test("approval approve updates requested records and protects existing approvals", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval() as unknown as Record<string, unknown>);

    expect(runApprovalApprove(root, "WBS-001-004", { reason: "Reviewed", force: false })).toBe(0);
    expect(readApproval(root, "WBS-001-004").approval?.status).toBe("approved");
    const before = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(runApprovalApprove(root, "WBS-001-004", { reason: "Second approval", force: false })).toBe(1);
    expect(readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8")).toBe(before);
  });

  test("approval approve CLI accepts inline multi-word reason syntax", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(main(["approval", "approve", "--task", "WBS-001-004", "--pull-request", "#42", "--reason=Evidence and PR reviewed"], root)).toBe(0);
    const actual = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(actual).toContain("reason: Evidence and PR reviewed");
  });

  test("approval approve helper can render deterministic YAML", () => {
    expect(buildApprovalApproveYaml("WBS-001-004", {
      pullRequest: "#42",
      reason: "Reviewed",
      approvedBy: "human",
      approvedAt: "2026-07-02T00:00:00.000Z"
    })).toContain('approvedAt: "2026-07-02T00:00:00.000Z"');
  });

  test("completion apply dry-run previews approved records and WBS changeset operations", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: {
        branch: "task/WBS-001-004-api-implementation",
        base: "main",
        headCommit: "abc1234",
        pullRequest: "#42"
      }
    }) as unknown as Record<string, unknown>);

    const preview = buildCompletionPreview(root, " WBS-001-004 ", "WBS-001-999", { reason: "Reviewed and accepted", allowRoot: false });
    expect(preview).toContain("Completion apply dry-run:");
    expect(preview).toContain("- WBS-001-004: 1.1 API Implementation -> completed");
    expect(preview).toContain("approval: will write approved record");
    expect(preview).toContain("changeset: contracts/changesets/WBS-001-999-complete-reviewed-work.json");
    expect(readApproval(root, "WBS-001-004").approval).toBeUndefined();
  });

  test("completion apply dry-run previews node-level completion targets", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({
      id: "WBS-001-005",
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/tasks/WBS-001-006.yaml", sampleTask({
      id: "WBS-001-006",
      wbsNodeId: "node-api",
      branchName: "codex/wbs-001-006-node-completion",
      completionScope: "node",
      completionTaskIds: ["WBS-001-004", "WBS-001-005"],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      id: "EVD-001-004",
      taskId: "WBS-001-004",
      git: {
        branch: "codex/wbs-001-004-api",
        base: "main",
        headCommit: "abc1234",
        pullRequest: "#41"
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-005.yaml", sampleEvidence({
      id: "EVD-001-005",
      taskId: "WBS-001-005",
      git: {
        branch: "codex/wbs-001-005-api",
        base: "main",
        headCommit: "abc1235",
        pullRequest: "#42"
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-006.yaml", sampleEvidence({
      id: "EVD-001-006",
      taskId: "WBS-001-006",
      git: {
        branch: "codex/wbs-001-006-node-completion",
        base: "main",
        headCommit: "abc1236",
        pullRequest: "#43"
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#41",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });
    writeYaml(root, "contracts/reviews/WBS-001-005.yaml", {
      id: "RVW-WBS-001-005",
      type: "review",
      taskId: "WBS-001-005",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-005.yaml", "contracts/evidence/WBS-001-005.yaml"]
    });
    writeYaml(root, "contracts/reviews/WBS-001-006.yaml", {
      id: "RVW-WBS-001-006",
      type: "review",
      taskId: "WBS-001-006",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#43",
      groundTruth: ["contracts/tasks/WBS-001-006.yaml", "contracts/evidence/WBS-001-006.yaml"]
    });

    const preview = buildCompletionPreview(root, "WBS-001-006", "WBS-001-999", { reason: "Reviewed and accepted", allowRoot: false });
    expect(preview).toContain("Completion apply dry-run:");
    expect(preview).toContain("- WBS-001-006: 1.1 API Implementation -> completed");
    expect(preview).toContain("completionTargets:");
    expect(preview).toContain("- WBS-001-004: 1.1 API Implementation");
    expect(preview).toContain("- WBS-001-005: 1.1 API Implementation");
    expect(preview).toContain("approval: will write approved record");
  });

  test("completion apply rejects root node completion by default", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ wbsNodeId: "node-root" }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: {
        branch: "task/WBS-001-004-api-implementation",
        base: "main",
        headCommit: "abc1234",
        pullRequest: "#42"
      }
    }) as unknown as Record<string, unknown>);

    expect(runCompletionApply(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", apply: false, allowRoot: false })).toBe(1);
  });

  test("completion apply writes approvals applies WBS changeset and rebuilds registry", () => {
    const root = makeTempRepo();
    writeFakeWjsApply(root);
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: {
        branch: "task/WBS-001-004-api-implementation",
        base: "main",
        headCommit: "abc1234",
        pullRequest: "#42"
      }
    }) as unknown as Record<string, unknown>);

    expect(runCompletionApply(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed and accepted", apply: true, allowRoot: false })).toBe(0);
    expect(readApproval(root, "WBS-001-004").approval?.status).toBe("approved");
    expect(readFileSync(path.join(root, "contracts/changesets/WBS-001-999-complete-reviewed-work.json"), "utf8")).toContain("\"nodeId\": \"node-api\"");
    const wbs = JSON.parse(readFileSync(path.join(root, "contracts/wbs/project.wbs.json"), "utf8"));
    expect(wbs.nodes.find((node: { id: string; status: string }) => node.id === "node-api")?.status).toBe("completed");
    const registry = readFileSync(path.join(root, "contracts/registry.yaml"), "utf8");
    expect(registry).toContain("id: APR-WBS-001-004");
    expect(registry).toContain("type: approval");
  });

  test("completion apply writes approvals for node-level completion tasks and completes the shared node", () => {
    const root = makeTempRepo();
    writeFakeWjsApply(root);
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({
      id: "WBS-001-005",
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/tasks/WBS-001-006.yaml", sampleTask({
      id: "WBS-001-006",
      wbsNodeId: "node-api",
      branchName: "codex/wbs-001-006-node-completion",
      completionScope: "node",
      completionTaskIds: ["WBS-001-004", "WBS-001-005"],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      id: "EVD-001-004",
      taskId: "WBS-001-004",
      git: {
        branch: "codex/wbs-001-004-api",
        base: "main",
        headCommit: "abc1234",
        pullRequest: "#41"
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-005.yaml", sampleEvidence({
      id: "EVD-001-005",
      taskId: "WBS-001-005",
      git: {
        branch: "codex/wbs-001-005-api",
        base: "main",
        headCommit: "abc1235",
        pullRequest: "#42"
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-006.yaml", sampleEvidence({
      id: "EVD-001-006",
      taskId: "WBS-001-006",
      git: {
        branch: "codex/wbs-001-006-node-completion",
        base: "main",
        headCommit: "abc1236",
        pullRequest: "#43"
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#41",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });
    writeYaml(root, "contracts/reviews/WBS-001-005.yaml", {
      id: "RVW-WBS-001-005",
      type: "review",
      taskId: "WBS-001-005",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-005.yaml", "contracts/evidence/WBS-001-005.yaml"]
    });
    writeYaml(root, "contracts/reviews/WBS-001-006.yaml", {
      id: "RVW-WBS-001-006",
      type: "review",
      taskId: "WBS-001-006",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#43",
      groundTruth: ["contracts/tasks/WBS-001-006.yaml", "contracts/evidence/WBS-001-006.yaml"]
    });

    expect(runCompletionApply(root, "WBS-001-006", "WBS-001-999", { reason: "Reviewed and accepted", apply: true, allowRoot: false })).toBe(0);
    expect(readApproval(root, "WBS-001-006").approval?.status).toBe("approved");
    expect(readFileSync(path.join(root, "contracts/changesets/WBS-001-999-complete-reviewed-work.json"), "utf8")).toContain("\"nodeId\": \"node-api\"");
    const wbs = JSON.parse(readFileSync(path.join(root, "contracts/wbs/project.wbs.json"), "utf8"));
    expect(wbs.nodes.find((node: { id: string; status: string }) => node.id === "node-api")?.status).toBe("completed");
    const registry = readFileSync(path.join(root, "contracts/registry.yaml"), "utf8");
    expect(registry).toContain("id: APR-WBS-001-006");
    expect(registry).toContain("type: approval");
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
        subjectHeadCommit: "abc1234",
        diffHash: "diff1234",
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
    expect(review).toContain("headCommit: abc1234");
    expect(review).toContain("diffHash: diff1234");
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

  test("health accepts explained test maintenance without new assertions", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        changedFiles: ["tests/features/api/api.test.ts"],
        testQuality: {
          assertionsAdded: false,
          testsDisabled: false,
          coverageDecreased: false,
          notes: ["Only increased timeout for an existing git-heavy test."]
        }
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.testQuality.assertions")).toBe(false);
  });

  test("health warns when test changes add no assertions without rationale", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        changedFiles: ["tests/features/api/api.test.ts"],
        testQuality: {
          assertionsAdded: false,
          testsDisabled: false,
          coverageDecreased: false
        }
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.testQuality.assertions")).toBe(true);
  });

  test("status summarizes WBS node status", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "blocked");
    const status = buildStatus(root);
    expect(status).toContain("- blocked: 1");
  });

  test("review queue lists tasks with evidence awaiting review", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    const queue = buildReviewQueue(root);
    expect(queue).toContain("Review Queue:");
    expect(queue).toContain("WBS-001-004");
    expect(queue).toContain("branch: task/WBS-001-004-api-implementation");
    expect(queue).toContain("evidence exists and the WBS node is ready for human review");
    expect(queue).toContain("suggestedAction: create or record PR, then human review for completion");
  });

  test("review queue blocks completion review when the WBS node is not ready", () => {
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
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });

    const queue = buildReviewQueue(root);
    expect(queue).toContain("completionBlockedBy: WBS node status is planned; completion requires ready");
    expect(queue).toContain("- 0 candidates ready for completion review");
    expect(queue).toContain("Ready for completion review:\n- None");
    expect(buildNextAction(root)).not.toContain("Human review for WBS-001-004");
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
    expect(queue).toContain("- 1 candidates blocked by completion prerequisites");
    expect(queue).toContain("warning: dependsOn node 1 Root is not completed");
    expect(queue).toContain("completionBlockedBy: 1 Root");
    expect(queue).toContain("suggestedAction: review evidence now, but defer completion until dependencies are completed");
  });

  test("review queue defers completion for shared WBS nodes", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({
      id: "WBS-001-005",
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-005.yaml", sampleEvidence({
      id: "EVD-001-005",
      taskId: "WBS-001-005"
    }) as unknown as Record<string, unknown>);

    const queue = buildReviewQueue(root);
    expect(queue).toContain("- 2 candidates blocked by completion prerequisites");
    expect(queue).toContain("completionBlockedBy: node has multiple Task Contracts; completion requires a dedicated node-level completion task");
    expect(queue).toContain("suggestedAction: review evidence now, but defer WBS completion to a dedicated node-level completion task");
    expect(queue).toContain("Ready for completion review:\n- None");
  });

  test("review queue allows a dedicated node completion task to aggregate shared-node prerequisites", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({
      id: "WBS-001-005",
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/tasks/WBS-001-006.yaml", sampleTask({
      id: "WBS-001-006",
      wbsNodeId: "node-api",
      branchName: "codex/wbs-001-006-node-completion",
      completionScope: "node",
      completionTaskIds: ["WBS-001-004", "WBS-001-005"],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      id: "EVD-001-004",
      taskId: "WBS-001-004",
      git: {
        branch: "codex/wbs-001-004-api",
        base: "main",
        headCommit: "abc1234",
        pullRequest: "#41"
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-005.yaml", sampleEvidence({
      id: "EVD-001-005",
      taskId: "WBS-001-005",
      git: {
        branch: "codex/wbs-001-005-api",
        base: "main",
        headCommit: "abc1235",
        pullRequest: "#42"
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-006.yaml", sampleEvidence({
      id: "EVD-001-006",
      taskId: "WBS-001-006",
      git: {
        branch: "codex/wbs-001-006-node-completion",
        base: "main",
        headCommit: "abc1236",
        pullRequest: "#43"
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#41",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });
    writeYaml(root, "contracts/reviews/WBS-001-005.yaml", {
      id: "RVW-WBS-001-005",
      type: "review",
      taskId: "WBS-001-005",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-005.yaml", "contracts/evidence/WBS-001-005.yaml"]
    });
    writeYaml(root, "contracts/reviews/WBS-001-006.yaml", {
      id: "RVW-WBS-001-006",
      type: "review",
      taskId: "WBS-001-006",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#43",
      groundTruth: ["contracts/tasks/WBS-001-006.yaml", "contracts/evidence/WBS-001-006.yaml"]
    });

    const queue = buildReviewQueue(root);
    expect(queue).toContain("WBS-001-006 | 1.1 | API Implementation");
    expect(queue).toContain("completionTargets:");
    expect(queue).toContain("- WBS-001-006");
    expect(queue).toContain("Ready for completion review:");
    expect(queue).toContain("- WBS-001-006");
    expect(queue).toContain("- WBS-001-004 blocked by node has multiple Task Contracts; completion requires a dedicated node-level completion task");
    expect(queue).toContain("- WBS-001-005 blocked by node has multiple Task Contracts; completion requires a dedicated node-level completion task");
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

  test("review queue asks for review request when PR metadata exists but review is missing", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
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
    expect(queue).toContain("warning: no review request is recorded for this review candidate");
    expect(queue).toContain("suggestedAction: request review for this task");
  });

  test("review queue shows review status when review metadata exists", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
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
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });

    const queue = buildReviewQueue(root);
    expect(queue).toContain("reviewStatus: requested");
    expect(queue).toContain("suggestedAction: human review for completion");
    expect(queue).not.toContain("warning: no review request is recorded for this review candidate");
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
    expect(queue).toContain("- 1 candidates blocked by completion prerequisites");
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
