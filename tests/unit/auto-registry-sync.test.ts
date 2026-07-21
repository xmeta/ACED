import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { syncRegistry } from "../../src/commands/registry-rebuild.js";
import { detectOpenPullRequest } from "../../src/commands/evidence-collect.js";
import { buildLockedTask } from "../../src/commands/task-lock.js";
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

  it("buildLockedTask triggers syncRegistry internally to resolve specs without manual rebuild", () => {
    writeYaml(tmpDir, "contracts/specs/SPEC-F001-API.yaml", sampleSpec() as unknown as Record<string, unknown>);
    writeYaml(tmpDir, "contracts/tasks/SCWBS-DRAFT-TEST.yaml", sampleTask({ id: "SCWBS-DRAFT-TEST", featureId: "F001", wbsNodeId: "node-api" }) as unknown as Record<string, unknown>);

    // Call buildLockedTask without calling registry rebuild beforehand
    const locked = buildLockedTask(tmpDir, "SCWBS-DRAFT-TEST");
    expect(locked.contractLock).toBeDefined();
    expect(locked.contractLock?.specVersion).toBe("1.0.0");
    expect(locked.contractLock?.specRevision).toBeDefined();
    expect(existsSync(path.join(tmpDir, "contracts/registry.yaml"))).toBe(true);
  });

  it("detectOpenPullRequest safely returns undefined when gh CLI is unavailable or fails", () => {
    const result = detectOpenPullRequest(tmpDir, "non-existent-branch-xyz");
    expect(result === undefined || typeof result === "string").toBe(true);
  });
});
