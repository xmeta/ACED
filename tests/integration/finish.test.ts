import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildHumanApprovalCommand, runFinish } from "../../src/commands/finish.js";
import { makeTempRepo, sampleTask, sampleEvidence, writeScwbsProject, writeYaml, writeText, writeJson } from "../helpers.js";
import { buildRegistryYaml } from "../../src/commands/registry-rebuild.js";
import { runTaskLock } from "../../src/commands/task-lock.js";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

function prepareFinishRepoWithHumanGate(): string {
  const root = makeTempRepo();
  writeScwbsProject(root);
  writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
    branchName: "master",
    allowedPaths: ["src/**", "contracts/**"],
    humanGateRequiredPaths: ["src/security/**"],
    requiredChecks: ["test"]
  }) as unknown as Record<string, unknown>);
  expect(runTaskLock(root, "WBS-001-004")).toBe(0);
  writeJson(root, "package.json", { scripts: { test: "node -e \"process.exit(0)\"" } });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["branch", "base"], { cwd: root });
  writeText(root, "src/security/secret.ts", "export const secret = 1;\n");
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "human gate change"], { cwd: root, stdio: "ignore" });
  writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
    changedFiles: ["src/security/secret.ts"],
    diffHash: "test-diff-hash",
    git: { diffHash: "test-diff-hash" }
  }) as unknown as Record<string, unknown>);
  writeYaml(root, "contracts/registry.yaml", {
    projectId: "test-wbs",
    contracts: [
      {
        id: "EVD-WBS-001-004",
        type: "evidence",
        path: "contracts/evidence/WBS-001-004.yaml",
        relatedTask: "WBS-001-004"
      },
      {
        id: "SPEC-F001-API",
        type: "spec",
        path: "contracts/specs/SPEC-F001-API.yaml",
        status: "approved",
        version: "1.0.0",
        featureId: "F001"
      },
      {
        id: "TASK-WBS-001-004",
        type: "task",
        path: "contracts/tasks/WBS-001-004.yaml",
        featureId: "F001"
      }
    ]
  });
  return root;
}

function prepareFinishRepo(requestedApproval = false): string {
  const root = makeTempRepo();
  writeScwbsProject(root);
  writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
    branchName: "master",
    allowedPaths: ["src/**", "contracts/**"],
    humanGateRequiredPaths: [],
    requiredChecks: ["test"]
  }) as unknown as Record<string, unknown>);
  expect(runTaskLock(root, "WBS-001-004")).toBe(0);
  writeJson(root, "package.json", { scripts: { test: "node -e \"process.exit(0)\"" } });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["branch", "base"], { cwd: root });
  writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
    git: { branch: "master", base: "base", changedFilesBasis: "branch-diff", pullRequest: "#42" }
  }) as unknown as Record<string, unknown>);
  if (requestedApproval) {
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", {
      id: "APR-WBS-001-004",
      type: "approval",
      taskId: "WBS-001-004",
      status: "requested"
    });
  }
  writeYaml(root, "contracts/registry.yaml", {
    projectId: "test-wbs",
    contracts: [
      ...(requestedApproval ? [{
        id: "APR-WBS-001-004",
        type: "approval",
        path: "contracts/approvals/WBS-001-004.yaml",
        status: "requested",
        relatedTask: "WBS-001-004"
      }] : []),
      {
        id: "EVD-WBS-001-004",
        type: "evidence",
        path: "contracts/evidence/WBS-001-004.yaml",
        relatedTask: "WBS-001-004"
      },
      {
        id: "SPEC-F001-API",
        type: "spec",
        path: "contracts/specs/SPEC-F001-API.yaml",
        status: "approved",
        version: "1.0.0",
        featureId: "F001"
      },
      {
        id: "TASK-WBS-001-004",
        type: "task",
        path: "contracts/tasks/WBS-001-004.yaml",
        featureId: "F001"
      }
    ]
  });
  writeText(root, "src/feature.ts", "export const value = 1;\n");
  return root;
}

describe("finish", () => {
  test("finish --json outputs summary JSON with all required fields", () => {
    const root = prepareFinishRepo(true);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };
    try {
      expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base", json: true })).toBe(0);
    } finally {
      console.log = originalLog;
    }
    const json = JSON.parse(output[output.length - 1]);
    expect(json).toMatchObject({
      schemaVersion: "1.0.0",
      status: "pass",
      taskId: "WBS-001-004",
      requiresHumanApproval: expect.any(Boolean),
      changedFiles: expect.any(Array),
      violations: expect.any(Array),
      requiredChecks: expect.any(Array),
      evidencePath: expect.any(String),
      approvalStatus: expect.any(String),
      nextAction: `gh pr create --base main --title "feat: WBS-001-004" --body ""`,
      readinessWarnings: [],
      fixCommands: []
    });
    const schema = JSON.parse(readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/finish-summary.schema.json"), "utf8"));
    expect(new Ajv2020({ strict: false }).compile(schema)(json)).toBe(true);
  }, 30000);

  test("finish blocks merge readiness when pull request metadata is missing", () => {
    const root = prepareFinishRepo();
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: { branch: "master", base: "base", changedFilesBasis: "branch-diff" }
    }) as unknown as Record<string, unknown>);
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base", json: true })).toBe(1);
    } finally {
      console.log = originalLog;
    }
    const json = JSON.parse(output[output.length - 1]);
    expect(json).toMatchObject({
      schemaVersion: "1.0.0",
      status: "blocked",
      readinessWarnings: [{ code: "health.evidence.git.pullRequest.missing" }]
    });
    expect(json.fixCommands[0]).toContain("evidence annotate --task WBS-001-004 --pull-request");
  }, 30000);

  test("finish rejects a missing contract lock before required checks", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeJson(root, "package.json", { scripts: { test: "node -e \"process.exit(9)\"" } });
    const stderr: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
    try {
      expect(runFinish(root, { taskId: "WBS-001-004", json: true })).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(stderr.join("\n")).toContain("health.task.contractLock.missing");
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toContain("process.exit(9)");
  });

  test("finish does not request Human Approval when no Human Gate files changed", () => {
    const root = prepareFinishRepo(true);
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };
    try {
      expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base" })).toBe(0);
    } finally {
      console.log = originalLog;
    }

    const command = buildHumanApprovalCommand("WBS-001-004");
    expect(output).toContain("PASS registry synchronized");
    expect(output.join("\n")).not.toContain("id: EVD-WBS-001-004");
    expect(output).not.toContain(`  ${command}`);
    expect(output).toContain(`  gh pr create --base main --title "feat: WBS-001-004" --body ""`);
    expect(command).not.toContain("--approved-by");
    expect(command).not.toContain("--human-confirm");
  }, 30000);

  test("finish keeps failed check diagnostics while Evidence collection stays quiet", () => {
    const root = prepareFinishRepo();
    writeJson(root, "package.json", {
      scripts: {
        test: "node -e \"console.log('bounded stdout detail'); console.error('actionable stderr detail'); process.exit(7)\""
      }
    });
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
      expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base" })).toBe(1);
    } finally {
      console.log = originalLog;
      console.error = originalError;
      process.stdout.write = originalWrite;
    }

    expect(stdout.join("\n")).not.toContain("id: EVD-WBS-001-004");
    expect(stderr.join("\n")).toContain("Check failed: test (npm test)");
    expect(stderr.join("\n")).toContain("bounded stdout detail");
    expect(stderr.join("\n")).toContain("actionable stderr detail");
  }, 30000);

  test("a first finish creates Evidence and synchronizes registry before blocking on missing PR metadata", () => {
    const root = prepareFinishRepo();
    unlinkSync(path.join(root, "contracts/evidence/WBS-001-004.yaml"));

    expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base" })).toBe(1);
    expect(readFileSync(path.join(root, "contracts/registry.yaml"), "utf8")).toBe(buildRegistryYaml(root));
    expect(readFileSync(path.join(root, "contracts/evidence/WBS-001-004.yaml"), "utf8")).toContain("cacheKey: sha256:");
  }, 30000);

  test("finish displays diff hash and AI stop message when Human Gate files changed", () => {
    const root = prepareFinishRepoWithHumanGate();

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };
    try {
      expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base" })).toBe(1);
    } finally {
      console.log = originalLog;
    }

    const text = output.join("\n");
    expect(text).toContain("Human approval required.");
    expect(text).toContain("Changed human-gated paths:");
    expect(text).toContain("  - src/security/secret.ts");
    expect(text).toContain("Current diff hash:");
    expect(text).toContain("Next action for human reviewer:");
    expect(text).toContain(buildHumanApprovalCommand("WBS-001-004"));
    expect(text).toContain("AI agents must stop here.");
    expect(text).toContain("Do not approve this task yourself.");
  }, 30000);

  test("finish synchronizes Approval status and can force valid checks to rerun", () => {
    const root = prepareFinishRepo(true);
    expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base" })).toBe(0);
    const firstExecutedAt = readFileSync(path.join(root, "contracts/evidence/WBS-001-004.yaml"), "utf8").match(/executedAt: (.+)/)?.[1];

    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", {
      id: "APR-WBS-001-004", type: "approval", taskId: "WBS-001-004", status: "approved"
    });
    expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base" })).toBe(0);
    expect(readFileSync(path.join(root, "contracts/registry.yaml"), "utf8")).toContain("status: approved");
    expect(readFileSync(path.join(root, "contracts/evidence/WBS-001-004.yaml"), "utf8")).toContain(`executedAt: ${firstExecutedAt}`);

    expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base", rerunChecks: true })).toBe(0);
    const rerunExecutedAt = readFileSync(path.join(root, "contracts/evidence/WBS-001-004.yaml"), "utf8").match(/executedAt: (.+)/)?.[1];
    expect(rerunExecutedAt).not.toBe(firstExecutedAt);
  }, 30000);
});
