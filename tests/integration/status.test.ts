import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { main } from "../../src/cli.js";
import { runEvidenceCollect } from "../../src/commands/evidence-collect.js";
import {
  assessTaskCompletionTrust,
  buildStatus,
  buildStatusJsonOutput,
  runStatus
} from "../../src/commands/status.js";
import { readTask } from "../../src/core/contracts.js";
import { headCommit } from "../../src/core/git.js";
import { readWbs } from "../../src/core/wbs.js";
import {
  makeTempRepo,
  sampleApproval,
  sampleEvidence,
  sampleTask,
  writeScwbsProject,
  writeJson,
  writeText,
  writeYaml
} from "../helpers.js";

function writeTerminalTaskIndex(root: string, status: "completed" | "archived" | "cancelled" = "archived"): void {
  const task = sampleTask();
  writeYaml(root, "contracts/tasks/index.yaml", {
    tasks: [{
      id: task.id,
      path: `contracts/tasks/${task.id}.yaml`,
      branchName: task.branchName,
      wbsNodeId: task.wbsNodeId,
      status,
      dependsOn: [],
      ...(status === "archived" ? { archivedAt: "2026-07-23T00:00:00.000Z" } : {})
    }]
  });
}

function commitAll(root: string, message: string): string {
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message], { cwd: root, stdio: "ignore" });
  return headCommit(root)!;
}

function writeTrustEvidence(
  root: string,
  subject: string,
  overrides: Parameters<typeof sampleEvidence>[0] = {}
): void {
  const base = sampleEvidence();
  writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
    commit: subject,
    subjectHeadCommit: subject,
    git: {
      ...base.git,
      changedFilesBasis: "legacy-recorded",
      subjectHeadCommit: subject,
      headCommit: subject
    },
    checks: [
      { name: "test", status: "passed", source: "local", command: "npm test", executedAt: "2026-07-23T00:00:00.000Z" },
      { name: "typecheck", status: "passed", source: "local", command: "npm run typecheck", executedAt: "2026-07-23T00:00:01.000Z" }
    ],
    ...overrides
  }) as unknown as Record<string, unknown>);
}

describe("status completion trust", () => {
  test("reports verified terminal Tasks separately from WBS lifecycle and validates the JSON schema", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeTerminalTaskIndex(root);
    const subject = commitAll(root, "subject");
    writeTrustEvidence(root, subject);

    const report = buildStatusJsonOutput(root);
    expect(report).toMatchObject({
      version: "scwbs.status.v1",
      repository: { shallow: false, commitReachability: "evaluated" },
      wbsStatus: { counts: { completed: 1, planned: 1 } },
      completionTrust: {
        sourceStatus: "available",
        total: 1,
        verified: 1,
        degraded: 0,
        unverifiable: 0,
        notEvaluated: 0
      }
    });
    const schema = JSON.parse(readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/status.schema.json"), "utf8"));
    expect(new Ajv2020({ strict: false }).compile(schema)(report)).toBe(true);
    expect(buildStatus(root)).toContain("Completion Trust (terminal Tasks):\n- verified: 1");
    expect(runStatus(root, { strict: true })).toBe(0);
  });

  test("treats missing Evidence and missing or failed required checks as unverifiable", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeTerminalTaskIndex(root, "completed");
    const subject = commitAll(root, "subject");

    expect(buildStatusJsonOutput(root).completionTrust.unverifiable).toBe(1);
    expect(runStatus(root, { strict: true })).toBe(1);

    writeTrustEvidence(root, subject, {
      checks: [{ name: "test", status: "failed", source: "local", command: "npm test", executedAt: "2026-07-23T00:00:00.000Z" }]
    });
    const { task } = readTask(root, "WBS-001-004");
    expect(task).toBeDefined();
    expect(assessTaskCompletionTrust(root, readWbs(root), task!).issueCodes)
      .toEqual(expect.arrayContaining(["health.evidence.check.missing", "health.evidence.check.notPassed"]));
    expect(buildStatusJsonOutput(root).completionTrust.unverifiable).toBe(1);
  });

  test("classifies verifiable low-source checks as degraded", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeTerminalTaskIndex(root);
    const subject = commitAll(root, "subject");
    writeTrustEvidence(root, subject, {
      checks: [
        { name: "test", status: "passed" },
        { name: "typecheck", status: "passed" }
      ]
    });

    expect(buildStatusJsonOutput(root).completionTrust).toMatchObject({
      verified: 0,
      degraded: 1,
      unverifiable: 0
    });
  });

  test("classifies Human Gate approval mismatch as unverifiable", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeTerminalTaskIndex(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      allowedPaths: ["src/security/**"],
      humanGateRequiredPaths: ["src/security/**"]
    }) as unknown as Record<string, unknown>);
    const subject = commitAll(root, "subject");
    writeTrustEvidence(root, subject, { changedFiles: ["src/security/policy.ts"] });
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval({ status: "requested" }) as unknown as Record<string, unknown>);

    expect(buildStatusJsonOutput(root).completionTrust.unverifiable).toBe(1);
  });

  test("marks commit reachability as not-evaluated in a shallow clone without hiding definite gaps", () => {
    const source = makeTempRepo();
    writeScwbsProject(source, "completed");
    writeTerminalTaskIndex(source);
    const subject = commitAll(source, "subject");
    writeTrustEvidence(source, subject);
    commitAll(source, "evidence");

    const clone = mkdtempSync(path.join(os.tmpdir(), "scwbs-status-shallow-"));
    execFileSync("git", ["clone", "--depth", "1", `file://${source}`, clone], { stdio: "ignore" });
    const report = buildStatusJsonOutput(clone);
    expect(report.repository).toEqual({ shallow: true, commitReachability: "not-evaluated" });
    expect(report.completionTrust).toMatchObject({
      verified: 0,
      degraded: 0,
      unverifiable: 0,
      notEvaluated: 1
    });

    writeText(clone, "contracts/evidence/WBS-001-004.yaml", "");
    expect(buildStatusJsonOutput(clone).completionTrust.unverifiable).toBe(1);
  });

  test("keeps a terminal Task verified from its patch when a fresh clone lacks the subject object", () => {
    const source = makeTempRepo();
    writeScwbsProject(source, "completed");
    writeTerminalTaskIndex(source, "completed");
    writeYaml(source, "contracts/tasks/WBS-001-004.yaml", sampleTask() as unknown as Record<string, unknown>);
    writeJson(source, "package.json", {
      scripts: {
        test: "node -e \"process.exit(0)\"",
        typecheck: "node -e \"process.exit(0)\""
      }
    });
    commitAll(source, "base");
    execFileSync("git", ["branch", "base"], { cwd: source, stdio: "ignore" });
    writeText(source, "src/features/api/retained-status.ts", "export const retained = true;\n");
    const subject = commitAll(source, "subject");
    expect(runEvidenceCollect(source, "WBS-001-004", { baseRef: "base", force: true })).toBe(0);
    execFileSync("git", ["switch", "-c", "retained", "base"], { cwd: source, stdio: "ignore" });
    commitAll(source, "tracked patch evidence");

    const clone = `${source}-status-fresh`;
    execFileSync("git", ["clone", "--no-local", "--single-branch", "--branch", "retained", source, clone], { stdio: "ignore" });
    expect(spawnSync("git", ["cat-file", "-e", `${subject}^{commit}`], {
      cwd: clone,
      stdio: "ignore"
    }).status).not.toBe(0);
    const clonedTask = readTask(clone, "WBS-001-004").task!;
    const trust = assessTaskCompletionTrust(clone, readWbs(clone), clonedTask);
    expect(buildStatusJsonOutput(clone).completionTrust, JSON.stringify(trust)).toMatchObject({
      verified: 1,
      degraded: 0,
      unverifiable: 0,
      notEvaluated: 0
    });
    rmSync(clone, { recursive: true, force: true });
  });

  test("supports bounded JSON, strict mode, help, and excludes cancelled Tasks", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeTerminalTaskIndex(root, "cancelled");

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      expect(main(["status", "--json"], root)).toBe(0);
    } finally {
      console.log = originalLog;
    }
    const parsed = JSON.parse(output.join("\n"));
    expect(parsed.completionTrust.total).toBe(0);
    expect(JSON.stringify(parsed.completionTrust)).not.toContain("WBS-001-004");

    const help: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      help.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(main(["status", "--help"], root)).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(help.join("")).toContain("--strict");
    expect(help.join("")).toContain("--json");
  });
});
