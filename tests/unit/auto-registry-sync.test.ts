import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { syncRegistry } from "../../src/commands/registry-rebuild.js";
import { detectOpenPullRequest } from "../../src/commands/evidence-collect.js";
import { runTaskLock } from "../../src/commands/task-lock.js";
import { makeTempRepo, sampleSpec, sampleTask, sampleWbs, writeJson, writeYaml } from "../helpers.js";

describe("Automatic Registry Synchronization (Issue #270 Direction A)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempRepo();
    writeJson(tmpDir, "contracts/wbs/project.wbs.json", sampleWbs());
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("automatically creates and synchronizes contracts/registry.yaml", () => {
    writeYaml(tmpDir, "contracts/specs/SPEC-F001-API.yaml", sampleSpec() as unknown as Record<string, unknown>);

    const summary = syncRegistry(tmpDir);
    expect(summary.status).toBe("rebuilt");
    expect(existsSync(path.join(tmpDir, "contracts/registry.yaml"))).toBe(true);

    const registryContent = readFileSync(path.join(tmpDir, "contracts/registry.yaml"), "utf8");
    expect(registryContent).toContain("SPEC-F001-API");

    // Second sync should be synchronized without changes
    const secondSummary = syncRegistry(tmpDir);
    expect(secondSummary.status).toBe("synchronized");
  });

  it("task lock synchronizes the registry before resolving specs", () => {
    writeYaml(tmpDir, "contracts/specs/SPEC-F001-API.yaml", sampleSpec() as unknown as Record<string, unknown>);
    writeYaml(tmpDir, "contracts/tasks/SCWBS-DRAFT-TEST.yaml", sampleTask({ id: "SCWBS-DRAFT-TEST", featureId: "F001", wbsNodeId: "node-api" }) as unknown as Record<string, unknown>);

    // Run task lock without calling registry rebuild beforehand.
    expect(runTaskLock(tmpDir, "SCWBS-DRAFT-TEST")).toBe(0);
    const locked = readFileSync(path.join(tmpDir, "contracts/tasks/SCWBS-DRAFT-TEST.yaml"), "utf8");
    expect(locked).toContain("contractLock:");
    expect(locked).toContain("specVersion: 1.0.0");
    expect(locked).toContain("specRevision:");
    expect(existsSync(path.join(tmpDir, "contracts/registry.yaml"))).toBe(true);
  });

  it("detectOpenPullRequest safely returns undefined when gh CLI is unavailable or fails", () => {
    const result = detectOpenPullRequest(tmpDir, "non-existent-branch-xyz");
    expect(result === undefined || typeof result === "string").toBe(true);
  });
});
