import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildHumanApprovalCommand, runFinish } from "../../src/commands/finish.js";
import { makeTempRepo, sampleTask, sampleEvidence, writeScwbsProject, writeYaml, writeText, writeJson } from "../helpers.js";
import { buildRegistryYaml } from "../../src/commands/registry-rebuild.js";
import path from "node:path";

function prepareFinishRepoWithHumanGate(): string {
  const root = makeTempRepo();
  writeScwbsProject(root);
  writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
    branchName: "master",
    allowedPaths: ["src/**", "contracts/**"],
    humanGateRequiredPaths: ["src/security/**"],
    requiredChecks: ["test"]
  }) as unknown as Record<string, unknown>);
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
  writeJson(root, "package.json", { scripts: { test: "node -e \"process.exit(0)\"" } });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["branch", "base"], { cwd: root });
  writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
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
    expect(JSON.parse(output[output.length - 1])).toMatchObject({
      status: "pass",
      taskId: "WBS-001-004",
      requiresHumanApproval: expect.any(Boolean),
      changedFiles: expect.any(Array),
      violations: expect.any(Array),
      requiredChecks: expect.any(Array),
      evidencePath: expect.any(String),
      approvalStatus: expect.any(String),
      nextAction: `gh pr create --base main --title "feat: WBS-001-004" --body ""`
    });
  }, 30000);

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

  test("a first finish creates Evidence and synchronizes registry in one run", () => {
    const root = prepareFinishRepo();
    unlinkSync(path.join(root, "contracts/evidence/WBS-001-004.yaml"));

    expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base" })).toBe(0);
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
