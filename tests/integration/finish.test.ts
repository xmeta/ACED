import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildHumanApprovalCommand, runFinish } from "../../src/commands/finish.js";
import { makeTempRepo, sampleTask, sampleEvidence, writeScwbsProject, writeYaml, writeText, writeJson } from "../helpers.js";
import { buildRegistryYaml } from "../../src/commands/registry-rebuild.js";
import { writeFilesAtomically } from "../../src/core/atomic-files.js";
import { runTaskLock } from "../../src/commands/task-lock.js";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

function gitStatus(root: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
}

function captureFinishJson(root: string, options: Parameters<typeof runFinish>[1]): { exitCode: number; json: Record<string, unknown> } {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => output.push(String(message));
  try {
    const exitCode = runFinish(root, { ...options, json: true });
    return { exitCode, json: JSON.parse(output[output.length - 1]) };
  } finally {
    console.log = originalLog;
  }
}

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
  execFileSync("git", ["add", "src/feature.ts"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "feature"], { cwd: root, stdio: "ignore" });
  return root;
}

describe("finish", () => {
  test("scwbs wrapper serializes the shared build and CLI lifecycle", async () => {
    const root = makeTempRepo();
    const marker = path.join(root, "command-order.log");
    const wrapper = path.join(root, "scripts", "scwbs-run.mjs");
    const fakeCli = path.join(root, "fake-cli.mjs");
    writeText(root, "scripts/scwbs-run.mjs", readFileSync(path.join(process.cwd(), "scripts/scwbs-run.mjs"), "utf8"));
    writeText(root, "fake-cli.mjs", [
      "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
      "const marker = process.env.SCWBS_TEST_MARKER;",
      "const lockPath = process.env.SCWBS_COMMAND_LOCK_PATH;",
      "const state = JSON.parse(readFileSync(lockPath, 'utf8'));",
      "writeFileSync(lockPath, JSON.stringify({ ...state, taskId: 'WBS-001-004', check: 'test:integration', checkIndex: 1, checkTotal: 1, checkStartedAt: new Date().toISOString() }));",
      "appendFileSync(marker, 'start ' + process.pid + '\\n');",
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);",
      "appendFileSync(marker, 'end ' + process.pid + '\\n');"
    ].join("\n"));

    const run = () => new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [wrapper, "status"], {
        cwd: root,
        env: {
          ...process.env,
          SCWBS_SKIP_BUILD_FOR_TESTS: "1",
          SCWBS_CLI_ENTRY_FOR_TESTS: fakeCli,
          SCWBS_TEST_MARKER: marker
        }
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("close", (code) => resolve({ code, stderr }));
    });

    const first = run();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = run();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(results.some((result) => result.stderr.includes("scwbs waiting for active command pid="))).toBe(true);
    expect(results.some((result) => result.stderr.includes("check=1/1:test:integration"))).toBe(true);
    expect(readFileSync(marker, "utf8").trim().split("\n").map((line) => line.split(" ")[0]))
      .toEqual(["start", "end", "start", "end"]);
  }, 15000);

  test("scwbs wrapper recovers a stale command lock", () => {
    const root = makeTempRepo();
    const wrapper = path.join(root, "scripts", "scwbs-run.mjs");
    const fakeCli = path.join(root, "fake-cli.mjs");
    const marker = path.join(root, "stale-recovered.txt");
    const lockPath = path.join(root, ".git", "scwbs-command.lock");
    writeText(root, "scripts/scwbs-run.mjs", readFileSync(path.join(process.cwd(), "scripts/scwbs-run.mjs"), "utf8"));
    writeText(root, "fake-cli.mjs", "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.SCWBS_TEST_MARKER, 'recovered');\n");
    writeText(root, ".git/scwbs-command.lock", JSON.stringify({
      runId: "stale",
      pid: 999_999_999,
      command: "scwbs finish",
      startedAt: "2026-01-01T00:00:00.000Z",
      phase: "cli"
    }));

    execFileSync(process.execPath, [wrapper, "status"], {
      cwd: root,
      env: {
        ...process.env,
        SCWBS_SKIP_BUILD_FOR_TESTS: "1",
        SCWBS_CLI_ENTRY_FOR_TESTS: fakeCli,
        SCWBS_TEST_MARKER: marker
      }
    });
    expect(readFileSync(marker, "utf8")).toBe("recovered");
    expect(existsSync(lockPath)).toBe(false);
  }, 15000);

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
      phase: "complete",
      outcome: "completed",
      taskId: "WBS-001-004",
      requiresHumanApproval: expect.any(Boolean),
      changedFiles: expect.any(Array),
      violations: expect.any(Array),
      requiredChecks: expect.any(Array),
      evidencePath: expect.any(String),
      approvalStatus: expect.any(String),
      nextAction: `gh pr create --base main --title "feat: WBS-001-004" --body ""`,
      resumeCommand: `gh pr create --base main --title "feat: WBS-001-004" --body ""`,
      mutatedFiles: expect.any(Array),
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

  test("finish rejects a dirty working tree before required checks and returns structured JSON", () => {
    const root = prepareFinishRepo();
    const marker = path.join(root, "dirty-check-ran");
    writeJson(root, "package.json", {
      scripts: { test: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"` }
    });
    execFileSync("git", ["add", "package.json"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "configure marker check"], { cwd: root, stdio: "ignore" });
    writeText(root, "src/dirty.ts", "export const dirty = true;\n");

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base", json: true })).toBe(1);
    } finally {
      console.log = originalLog;
    }
    expect(existsSync(marker)).toBe(false);
    expect(JSON.parse(output[output.length - 1])).toMatchObject({
      schemaVersion: "1.0.0",
      status: "blocked",
      taskId: "WBS-001-004",
      requiredChecks: [],
      workingTree: { untracked: ["src/dirty.ts"] },
      violations: [expect.objectContaining({ code: "diff.workingTree.untracked" })]
    });
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
    execFileSync("git", ["add", "package.json"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "configure failing check"], { cwd: root, stdio: "ignore" });
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

  test("failed required checks preserve the previous Evidence and Registry checkpoint", () => {
    const root = prepareFinishRepo();
    const evidenceFile = path.join(root, "contracts/evidence/WBS-001-004.yaml");
    const registryFile = path.join(root, "contracts/registry.yaml");
    const previousEvidence = readFileSync(evidenceFile, "utf8");
    const previousRegistry = readFileSync(registryFile, "utf8");
    writeJson(root, "package.json", { scripts: { test: "node -e \"process.exit(9)\"" } });
    execFileSync("git", ["add", "package.json"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "configure failed check"], { cwd: root, stdio: "ignore" });
    const beforeStatus = gitStatus(root);

    const result = captureFinishJson(root, { taskId: "WBS-001-004", baseRef: "base" });

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      phase: "required-checks",
      outcome: "required-check-failed",
      mutatedFiles: [],
      resumeCommand: "npm run scwbs -- finish --task WBS-001-004"
    });
    expect(readFileSync(evidenceFile, "utf8")).toBe(previousEvidence);
    expect(readFileSync(registryFile, "utf8")).toBe(previousRegistry);
    expect(gitStatus(root)).toBe(beforeStatus);
  }, 30000);

  test("check-diff violations do not persist a candidate Evidence or partial Registry", () => {
    const root = prepareFinishRepo();
    const evidenceFile = path.join(root, "contracts/evidence/WBS-001-004.yaml");
    const registryFile = path.join(root, "contracts/registry.yaml");
    const previousEvidence = readFileSync(evidenceFile, "utf8");
    const previousRegistry = readFileSync(registryFile, "utf8");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      branchName: "master",
      allowedPaths: ["docs/**", "contracts/**"],
      humanGateRequiredPaths: [],
      requiredChecks: ["test"]
    }) as unknown as Record<string, unknown>);
    expect(runTaskLock(root, "WBS-001-004")).toBe(0);
    execFileSync("git", ["add", "contracts/tasks/WBS-001-004.yaml"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "restrict task scope"], { cwd: root, stdio: "ignore" });
    const beforeStatus = gitStatus(root);

    const result = captureFinishJson(root, { taskId: "WBS-001-004", baseRef: "base" });

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ phase: "validation", outcome: "validation-failed", mutatedFiles: [] });
    expect(readFileSync(evidenceFile, "utf8")).toBe(previousEvidence);
    expect(readFileSync(registryFile, "utf8")).toBe(previousRegistry);
    expect(gitStatus(root)).toBe(beforeStatus);
  }, 30000);

  test("finish --preflight is read-only and does not execute required checks", () => {
    const root = prepareFinishRepo();
    const marker = path.join(root, "preflight-check-ran");
    writeJson(root, "package.json", {
      scripts: { test: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"` }
    });
    execFileSync("git", ["add", "package.json"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "configure preflight marker"], { cwd: root, stdio: "ignore" });
    const evidenceFile = path.join(root, "contracts/evidence/WBS-001-004.yaml");
    const registryFile = path.join(root, "contracts/registry.yaml");
    const beforeEvidence = readFileSync(evidenceFile, "utf8");
    const beforeRegistry = readFileSync(registryFile, "utf8");
    const beforeStatus = gitStatus(root);

    const result = captureFinishJson(root, { taskId: "WBS-001-004", baseRef: "base", preflight: true });

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ phase: "preflight", outcome: "ready", mutatedFiles: [] });
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(evidenceFile, "utf8")).toBe(beforeEvidence);
    expect(readFileSync(registryFile, "utf8")).toBe(beforeRegistry);
    expect(gitStatus(root)).toBe(beforeStatus);
  });

  test("an interrupted Evidence and Registry checkpoint rolls both files back", () => {
    const root = prepareFinishRepo();
    const evidenceFile = path.join(root, "contracts/evidence/WBS-001-004.yaml");
    const registryFile = path.join(root, "contracts/registry.yaml");
    writeText(root, "contracts/registry.yaml", `${readFileSync(registryFile, "utf8")}# stale registry marker\n`);
    const beforeEvidence = readFileSync(evidenceFile, "utf8");
    const beforeRegistry = readFileSync(registryFile, "utf8");
    const beforeStatus = gitStatus(root);

    const result = captureFinishJson(root, {
      taskId: "WBS-001-004",
      baseRef: "base",
      checkpointWriter: (files) => writeFilesAtomically(files, {
        beforeCommit: (index) => {
          if (index === 1) throw new Error("simulated interruption before registry replace");
        }
      })
    });

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ phase: "checkpoint", outcome: "checkpoint-failed", mutatedFiles: [] });
    expect(readFileSync(evidenceFile, "utf8")).toBe(beforeEvidence);
    expect(readFileSync(registryFile, "utf8")).toBe(beforeRegistry);
    expect(gitStatus(root)).toBe(beforeStatus);
  }, 30000);

  test("the next finish recovers a checkpoint journal left by a simulated process crash", () => {
    const root = prepareFinishRepo();
    writeJson(root, "package.json", { scripts: { test: "node -e \"process.exit(8)\"" } });
    execFileSync("git", ["add", "package.json"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "configure post-crash failed check"], { cwd: root, stdio: "ignore" });
    const evidenceFile = path.join(root, "contracts/evidence/WBS-001-004.yaml");
    const registryFile = path.join(root, "contracts/registry.yaml");
    const previousEvidence = readFileSync(evidenceFile, "utf8");
    const previousRegistry = readFileSync(registryFile, "utf8");
    const commonDirValue = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
    const commonDir = path.isAbsolute(commonDirValue) ? commonDirValue : path.resolve(root, commonDirValue);
    const journalFile = path.join(commonDir, "scwbs-finish-WBS-001-004.journal.json");
    writeText(root, path.relative(root, journalFile), `${JSON.stringify({
      schemaVersion: "1.0.0",
      files: [
        { path: evidenceFile, existed: true, previous: previousEvidence },
        { path: registryFile, existed: true, previous: previousRegistry }
      ]
    })}\n`);
    writeText(root, "contracts/evidence/WBS-001-004.yaml", "interrupted evidence\n");
    writeText(root, "contracts/registry.yaml", "interrupted registry\n");

    const result = captureFinishJson(root, { taskId: "WBS-001-004", baseRef: "base" });

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ phase: "required-checks", outcome: "required-check-failed", mutatedFiles: [] });
    expect(readFileSync(evidenceFile, "utf8")).toBe(previousEvidence);
    expect(readFileSync(registryFile, "utf8")).toBe(previousRegistry);
    expect(existsSync(journalFile)).toBe(false);
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

  test("Human Gate waiting persists one synchronized checkpoint and reports how to resume", () => {
    const root = prepareFinishRepoWithHumanGate();
    const registryFile = path.join(root, "contracts/registry.yaml");
    writeText(root, "contracts/registry.yaml", `${readFileSync(registryFile, "utf8")}# stale registry marker\n`);
    const beforeEvidence = readFileSync(path.join(root, "contracts/evidence/WBS-001-004.yaml"), "utf8");
    const beforeRegistry = readFileSync(registryFile, "utf8");
    const beforeStatus = gitStatus(root);

    const result = captureFinishJson(root, { taskId: "WBS-001-004", baseRef: "base" });

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      phase: "checkpoint",
      outcome: "awaiting-human-approval",
      requiresHumanApproval: true,
      mutatedFiles: ["contracts/evidence/WBS-001-004.yaml", "contracts/registry.yaml"],
      resumeCommand: buildHumanApprovalCommand("WBS-001-004")
    });
    expect(readFileSync(path.join(root, "contracts/registry.yaml"), "utf8")).toBe(buildRegistryYaml(root));
    expect(readFileSync(path.join(root, "contracts/evidence/WBS-001-004.yaml"), "utf8")).not.toBe(beforeEvidence);
    expect(readFileSync(registryFile, "utf8")).not.toBe(beforeRegistry);
    expect(gitStatus(root)).toBe(beforeStatus);
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
