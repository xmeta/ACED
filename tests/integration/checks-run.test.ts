import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { buildChecksRunSummary } from "../../src/commands/checks-run.js";
import { buildCollectedEvidence } from "../../src/commands/evidence-collect.js";
import { buildCheckCacheSubject } from "../../src/core/check-cache.js";
import { checkReceiptPath, collectCheckReceiptProvenance, readCheckReceipt } from "../../src/core/check-receipt.js";
import { headCommit } from "../../src/core/git.js";
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

describe("checks run", () => {
  test.concurrent("writes an exact receipt and Evidence reuses the costly check once", () => {
    const root = prepareRepo();
    const first = buildChecksRunSummary(root, taskId, { baseRef: "base" });
    expect(first).toMatchObject({
      schemaVersion: "1.0.0",
      status: "pass",
      receiptReason: "receipt-written",
      checks: [{ name: "costly", status: "passed", disposition: "executed", reason: "receipt-missing" }]
    });
    expect(count(root)).toBe(1);
    expect(existsSync(checkReceiptPath(root, taskId))).toBe(true);

    const evidence = buildCollectedEvidence(root, taskId, { baseRef: "base" });
    expect(evidence.checks).toHaveLength(1);
    expect(evidence.checks[0]).toMatchObject({ name: "costly", status: "passed", cacheKey: first.checks[0]?.cacheKey });
    expect(count(root)).toBe(1);

    const second = buildChecksRunSummary(root, taskId, { baseRef: "base" });
    expect(second.checks[0]).toMatchObject({ disposition: "reused", reason: "exact-receipt-match" });
    expect(count(root)).toBe(1);
  }, 60_000);

  test.concurrent("invalidates on HEAD, working diff, command, and lockfile provenance changes", () => {
    const root = prepareRepo();
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
  }, 60_000);

  test.concurrent("forced rerun executes again and a failed check leaves no reusable receipt", () => {
    const root = prepareRepo();
    buildChecksRunSummary(root, taskId, { baseRef: "base" });
    const forced = buildChecksRunSummary(root, taskId, { baseRef: "base", rerunChecks: true });
    expect(forced.checks[0]).toMatchObject({ disposition: "executed", reason: "forced-rerun" });
    expect(count(root)).toBe(2);

    writeJson(root, "package.json", { scripts: { costly: counterScript(7) } });
    const failed = buildChecksRunSummary(root, taskId, { baseRef: "base" });
    expect(failed).toMatchObject({ status: "fail", receiptPath: null, receiptReason: "check-failed-no-receipt" });
    expect(existsSync(checkReceiptPath(root, taskId))).toBe(false);
  }, 60_000);

  test.concurrent("does not trust raw npm self-report or a malformed receipt", () => {
    const root = prepareRepo();
    execFileSync("npm", ["run", "costly"], { cwd: root, stdio: "ignore" });
    expect(count(root)).toBe(1);
    expect(existsSync(checkReceiptPath(root, taskId))).toBe(false);

    writeText(root, path.relative(root, checkReceiptPath(root, taskId)), "{not-json\n");
    const summary = buildChecksRunSummary(root, taskId, { baseRef: "base" });
    expect(summary.checks[0]).toMatchObject({ disposition: "executed", reason: "receipt-invalid" });
    expect(count(root)).toBe(2);
  }, 60_000);

  test.concurrent("invalidates when recursive submodule provenance changes", () => {
    const root = prepareRepo();
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
  }, 60_000);

  test.concurrent("versioned JSON summary validates against the public schema", () => {
    const root = prepareRepo();
    const summary = buildChecksRunSummary(root, taskId, { baseRef: "base" });
    const schema = JSON.parse(readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/checks-run-summary.schema.json"), "utf8"));
    expect(new Ajv2020({ strict: false }).compile(schema)(summary)).toBe(true);
  }, 60_000);
});
