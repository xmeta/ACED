import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import {
  buildCollectedEvidence,
  buildCollectedEvidenceYaml,
  detectOpenPullRequest
} from "../../src/core/evidence/build.js";
import * as commandEvidence from "../../src/commands/evidence-collect.js";
import { makeTempRepo, sampleTask, writeScwbsProject, writeText, writeYaml } from "../helpers.js";

describe("evidence build module boundary", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps command exports as compatibility re-exports", () => {
    expect(commandEvidence.buildCollectedEvidence).toBe(buildCollectedEvidence);
    expect(commandEvidence.buildCollectedEvidenceYaml).toBe(buildCollectedEvidenceYaml);
    expect(commandEvidence.detectOpenPullRequest).toBe(detectOpenPullRequest);
  });

  it("builds the same Evidence shape from the core module", () => {
    const root = makeTempRepo();
    tempRoots.push(root);
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: [] }) as unknown as Record<string, unknown>);
    writeText(root, "src/features/api/index.ts", "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
    const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    writeText(root, "src/features/api/index.ts", "export const value = 2;\n");
    execFileSync("git", ["add", "src/features/api/index.ts"], { cwd: root });
    execFileSync("git", ["commit", "-m", "implementation"], { cwd: root, stdio: "ignore" });

    const evidence = buildCollectedEvidence(root, "WBS-001-004", { baseRef });

    expect(evidence.type).toBe("evidence");
    expect(evidence.taskId).toBe("WBS-001-004");
    expect(evidence.checks).toEqual([]);
    expect(evidence.changedFiles).toContain("src/features/api/index.ts");
    expect(buildCollectedEvidenceYaml(root, "WBS-001-004", { baseRef })).toContain("type: evidence");
  }, 15000);
});
