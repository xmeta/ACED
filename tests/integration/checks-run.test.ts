import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test, type TestContext } from "vitest";
import { buildChecksRunSummary } from "../../src/commands/checks-run.js";
import { buildCollectedEvidence } from "../../src/commands/evidence-collect.js";
import { buildCheckCacheSubject } from "../../src/core/check-cache.js";
import { checkReceiptPath, collectCheckReceiptProvenance, readCheckReceipt } from "../../src/core/check-receipt.js";
import { headCommit } from "../../src/core/git.js";
import { requiredCheckLockPath } from "../../src/core/required-check-run.js";
import { makeTempRepo, sampleTask, writeJson, writeScwbsProject, writeText, writeYaml } from "../helpers.js";

const taskId = "WBS-001-004";

function commit(root: string, message: string): void {
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message], { cwd: root, stdio: "ignore" });
}

function counterScript(exitStatus = 0): string {
  return `node -e "const fs=require('fs');const p='.git/check-count';const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1));process.exit(${exitStatus})"`;
}

function prepareRepo(): string {
  const root = makeTempRepo();
  writeScwbsProject(root);
  writeYaml(root, `contracts/tasks/${taskId}.yaml`, sampleTask({
    requiredChecks: ["costly"],
    allowedPaths: ["src/**", "package.json", "package-lock.json"]
  }) as unknown as Record<string, unknown>);
  writeJson(root, "package.json", { scripts: { costly: counterScript() } });
  writeJson(root, "package-lock.json", { lockfileVersion: 3 });
  writeText(root, "src/base.ts", "export const base = true;\n");
  commit(root, "base");
  execFileSync("git", ["branch", "base"], { cwd: root });
  writeText(root, "src/feature.ts", "export const feature = 1;\n");
  commit(root, "feature");
  return root;
}

function count(root: string): number {
  return Number(readFileSync(path.join(root, ".git/check-count"), "utf8"));
}

function receiptReason(root: string): string {
  const subject = buildCheckCacheSubject(root, {
    baseRef: "base",
    excludedMetadataFiles: [
      `contracts/evidence/${taskId}.yaml`,
      `contracts/approvals/${taskId}.yaml`,
      `contracts/reviews/${taskId}.yaml`,
      "contracts/registry.yaml"
    ]
  });
  return readCheckReceipt(root, {
    taskId,
    headCommit: headCommit(root)!,
    subjectFingerprint: subject.fingerprint,
    provenance: collectCheckReceiptProvenance(root)
  }).reason;
}

type CaseState = {
  name: string;
  phase: string;
  root?: string;
  command?: string;
};

function lockStateSummary(root: string | undefined): string {
  if (!root) return "absent root=(not-created)";
  const lockPath = requiredCheckLockPath(root);
  if (!existsSync(lockPath)) return `absent path=${lockPath}`;
  try {
    const state = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    return [
      `present path=${lockPath}`,
      `pid=${state.pid ?? "?"}`,
      `task=${state.taskId ?? "?"}`,
      `check=${state.check ?? "?"}`,
      `index=${state.checkIndex ?? "?"}/${state.checkTotal ?? "?"}`,
      `startedAt=${state.startedAt ?? "?"}`
    ].join(" ");
  } catch {
    return `unreadable path=${lockPath}`;
  }
}

function caseDiagnostics(state: CaseState): string {
  const receipt = state.root
    ? `${existsSync(checkReceiptPath(state.root, taskId)) ? "present" : "absent"} path=${checkReceiptPath(state.root, taskId)}`
    : "absent path=(not-created)";
  return [
    `checks-run diagnostics case=${state.name}`,
    `phase=${state.phase}`,
    `testWorkerPid=${process.pid}`,
    `temporaryRepo=${state.root ?? "(not-created)"}`,
    `childProcess=required-check command=${state.command ?? "(unknown)"}`,
    `lockLease=${lockStateSummary(state.root)}`,
    `receipt=${receipt}`
  ].join(" ");
}

function caseTest(name: string, body: (state: CaseState) => void): void {
  test(name, ({ onTestFailed }: TestContext) => {
    const state: CaseState = { name, phase: "starting" };
    onTestFailed(() => {
      process.stderr.write(`${caseDiagnostics(state)}\n`);
    });
    body(state);
  }, 60_000);
}

describe("checks run", () => {
  caseTest("writes an exact receipt and Evidence reuses the costly check once", (state) => {
    state.phase = "prepare-repo";
    const root = prepareRepo();
    state.root = root;
    state.phase = "checks-run initial";
    state.command = "buildChecksRunSummary";
    const first = buildChecksRunSummary(root, taskId, { baseRef: "base" });
    expect(first).toMatchObject({
      schemaVersion: "1.0.0",
      status: "pass",
      receiptReason: "receipt-written",
      checks: [{ name: "costly", status: "passed", disposition: "executed", reason: "receipt-missing" }]
    });
    expect(count(root)).toBe(1);
    expect(existsSync(checkReceiptPath(root, taskId))).toBe(true);
    const receipt = JSON.parse(readFileSync(checkReceiptPath(root, taskId), "utf8"));
    expect(receipt.checks[0].durationMilliseconds).toBeGreaterThanOrEqual(0);

    state.phase = "evidence reuse";
    const evidence = buildCollectedEvidence(root, taskId, { baseRef: "base" });
    expect(evidence.checks).toHaveLength(1);
    expect(evidence.checks[0]).toMatchObject({ name: "costly", status: "passed", cacheKey: first.checks[0]?.cacheKey });
    expect(evidence.checks[0]?.durationMilliseconds).toBe(receipt.checks[0].durationMilliseconds);
    expect(count(root)).toBe(1);

    state.phase = "legacy evidence prefers observed receipt";
    const legacyEvidence = structuredClone(evidence);
    delete legacyEvidence.checks[0]?.durationMilliseconds;
    writeYaml(root, `contracts/evidence/${taskId}.yaml`, legacyEvidence as unknown as Record<string, unknown>);
    const refreshed = buildCollectedEvidence(root, taskId, { baseRef: "base" });
    expect(refreshed.checks[0]?.durationMilliseconds).toBe(receipt.checks[0].durationMilliseconds);
    expect(count(root)).toBe(1);

    state.phase = "checks-run receipt reuse";
    const second = buildChecksRunSummary(root, taskId, { baseRef: "base" });
    expect(second.checks[0]).toMatchObject({ disposition: "reused", reason: "exact-receipt-match" });
    expect(count(root)).toBe(1);
  });

  caseTest("invalidates on HEAD, working diff, command, and lockfile provenance changes", (state) => {
    state.phase = "prepare-repo";
    const root = prepareRepo();
    state.root = root;
    state.phase = "subject invalidation";
    state.command = "buildChecksRunSummary";
    buildChecksRunSummary(root, taskId, { baseRef: "base" });

    writeText(root, "src/feature.ts", "export const feature = 2;\n");
    expect(buildChecksRunSummary(root, taskId, { baseRef: "base" }).checks[0]?.reason).toBe("subject-mismatch");
    expect(count(root)).toBe(2);
    commit(root, "change subject head");
    expect(receiptReason(root)).toBe("head-mismatch");
    buildChecksRunSummary(root, taskId, { baseRef: "base" });

    writeJson(root, "package.json", { scripts: { costly: `${counterScript()} ` } });
    expect(receiptReason(root)).toBe("subject-mismatch");

    writeJson(root, "package.json", { scripts: { costly: counterScript() } });
    writeJson(root, "package-lock.json", { lockfileVersion: 3, packages: { changed: true } });
    expect(receiptReason(root)).toBe("subject-mismatch");
    expect(count(root)).toBe(3);
  });

  caseTest("forced rerun executes again and a failed check leaves no reusable receipt", (state) => {
    state.phase = "prepare-repo";
    const root = prepareRepo();
    state.root = root;
    state.phase = "forced rerun";
    state.command = "buildChecksRunSummary";
    buildChecksRunSummary(root, taskId, { baseRef: "base" });
    const forced = buildChecksRunSummary(root, taskId, { baseRef: "base", rerunChecks: true });
    expect(forced.checks[0]).toMatchObject({ disposition: "executed", reason: "forced-rerun" });
    expect(count(root)).toBe(2);

    writeJson(root, "package.json", { scripts: { costly: counterScript(7) } });
    state.phase = "failed check without receipt";
    const failed = buildChecksRunSummary(root, taskId, { baseRef: "base" });
    expect(failed).toMatchObject({ status: "fail", receiptPath: null, receiptReason: "check-failed-no-receipt" });
    expect(existsSync(checkReceiptPath(root, taskId))).toBe(false);
  });

  caseTest("does not trust raw npm self-report or a malformed receipt", (state) => {
    state.phase = "prepare-repo";
    const root = prepareRepo();
    state.root = root;
    state.phase = "raw npm self-report";
    state.command = "npm run costly";
    execFileSync("npm", ["run", "costly"], { cwd: root, stdio: "ignore" });
    expect(count(root)).toBe(1);
    expect(existsSync(checkReceiptPath(root, taskId))).toBe(false);

    writeText(root, path.relative(root, checkReceiptPath(root, taskId)), "{not-json\n");
    state.phase = "malformed receipt";
    state.command = "buildChecksRunSummary";
    const summary = buildChecksRunSummary(root, taskId, { baseRef: "base" });
    expect(summary.checks[0]).toMatchObject({ disposition: "executed", reason: "receipt-invalid" });
    expect(count(root)).toBe(2);
  });

  caseTest("accepts a legacy receipt without duration and rejects a negative duration", (state) => {
    const root = prepareRepo();
    state.root = root;
    state.command = "buildChecksRunSummary";
    buildChecksRunSummary(root, taskId, { baseRef: "base" });
    const receipt = JSON.parse(readFileSync(checkReceiptPath(root, taskId), "utf8"));
    delete receipt.checks[0].durationMilliseconds;
    writeText(root, path.relative(root, checkReceiptPath(root, taskId)), JSON.stringify(receipt));
    expect(receiptReason(root)).toBe("receipt-valid");
    expect(buildChecksRunSummary(root, taskId, { baseRef: "base" }).checks[0]).toMatchObject({ disposition: "reused" });
    receipt.checks[0].durationMilliseconds = -1;
    writeText(root, path.relative(root, checkReceiptPath(root, taskId)), JSON.stringify(receipt));
    expect(receiptReason(root)).toBe("receipt-invalid");
  });

  caseTest("invalidates when recursive submodule provenance changes", (state) => {
    state.phase = "prepare-repo";
    const root = prepareRepo();
    state.root = root;
    state.phase = "submodule setup";
    state.command = "buildChecksRunSummary";
    const child = makeTempRepo();
    writeText(child, "version.txt", "one\n");
    commit(child, "submodule base");
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", child, "deps/child"], {
      cwd: root,
      stdio: "ignore"
    });
    commit(root, "add submodule");
    buildChecksRunSummary(root, taskId, { baseRef: "base" });
    expect(count(root)).toBe(1);

    writeText(child, "version.txt", "two\n");
    commit(child, "submodule advance");
    execFileSync("git", ["fetch"], { cwd: path.join(root, "deps/child"), stdio: "ignore" });
    execFileSync("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: path.join(root, "deps/child"), stdio: "ignore" });
    expect(receiptReason(root)).toBe("subject-mismatch");
    expect(count(root)).toBe(1);
  });

  caseTest("versioned JSON summary validates against the public schema", (state) => {
    state.phase = "prepare-repo";
    const root = prepareRepo();
    state.root = root;
    state.phase = "schema validation";
    state.command = "buildChecksRunSummary";
    const summary = buildChecksRunSummary(root, taskId, { baseRef: "base" });
    const schema = JSON.parse(readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/checks-run-summary.schema.json"), "utf8"));
    expect(new Ajv2020({ strict: false }).compile(schema)(summary)).toBe(true);
  });
});
