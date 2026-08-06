import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { buildAiPacket, buildTinyPacket } from "../../src/commands/ai-packet.js";
import { buildBlockChangeSet, buildNextTask } from "../../src/commands/ai-queue.js";
import { buildNextAction } from "../../src/commands/next.js";
import { main } from "../../src/cli.js";
import { readApproval, readBlock } from "../../src/core/contracts.js";
import { buildCodeContextManifest, buildCodeContextManifestJson } from "../../src/core/code-context.js";
import { makeTempRepo, sampleTask, sampleWbs, sampleEvidence, writeScwbsProject, writeJson, writeText, writeYaml } from "../helpers.js";

describe("AI commands", () => {
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

  test("ai packet shows submodule dependent PR merge order", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      submoduleDependencies: [{ path: "vendor/dependency", repository: "example/dependency", pullRequest: "#4" }]
    }) as unknown as Record<string, unknown>);
    const packet = buildAiPacket(root, "WBS-001-004");
    expect(packet).toContain("## Submodule Dependencies");
    expect(packet).toContain("dependentPullRequest: #4");
    expect(packet).toContain("mergeOrder: #4 before parent PR");
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

  test("ai next-task orders eligible tasks by priority before task id", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs("planned");
    wbs.nodes[0].status = "completed";
    wbs.nodes.push({
      id: "node-api-low",
      parentId: "node-root",
      code: "1.2",
      name: "Lower Priority API",
      type: "workPackage",
      status: "planned"
    });
    wbs.relations = [];
    writeScwbsProject(root);
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ humanGateRequiredPaths: [], priority: "low" }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({
      id: "WBS-001-005",
      wbsNodeId: "node-api-low",
      branchName: "task/WBS-001-005-api-priority",
      humanGateRequiredPaths: [],
      priority: "high"
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/tasks/WBS-001-006.yaml", sampleTask({
      id: "WBS-001-006",
      branchName: "task/WBS-001-006-api-unprioritized",
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);

    expect(buildNextTask(root)).toBe(
      "Planned task candidates:\n" +
      "- WBS-001-005 | Lower Priority API | 1.2\n" +
      "- WBS-001-004 | API Implementation | 1.1\n" +
      "- WBS-001-006 | API Implementation | 1.1\n"
    );
  });

  test("ai next-task excludes active Blocks and includes resolved Blocks", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs("planned");
    wbs.nodes[0].status = "completed";
    writeScwbsProject(root);
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ humanGateRequiredPaths: [] }) as unknown as Record<string, unknown>);

    expect(buildNextTask(root)).toContain("WBS-001-004");
    expect(main(["ai", "block", "--task", "WBS-001-004", "--reason", "Human Gate required"], root)).toBe(0);
    expect(buildNextTask(root)).not.toContain("WBS-001-004 | API Implementation");
    expect(main(["block", "resolve", "--task", "WBS-001-004", "--reason", "Decision recorded"], root)).toBe(0);
    expect(buildNextTask(root)).toContain("WBS-001-004 | API Implementation");
  });

  test("top-level next does not suggest work for an active Block", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    expect(main(["ai", "block", "--task", "WBS-001-004", "--reason", "Human Gate required"], root)).toBe(0);
    expect(buildNextAction(root)).not.toContain("Collect evidence for WBS-001-004");
    expect(buildNextAction(root)).not.toContain("Review blocked candidates");
    expect(buildNextAction(root)).not.toContain("Run `scwbs next`");
  });

  test("top-level next skips an active Block and still finds a later review candidate", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({
      id: "WBS-001-005",
      branchName: "task/WBS-001-005-follow-up",
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-005.yaml", sampleEvidence({ id: "EVD-001-005", taskId: "WBS-001-005" }) as unknown as Record<string, unknown>);
    expect(main(["ai", "block", "--task", "WBS-001-004", "--reason", "Human Gate required"], root)).toBe(0);
    expect(buildNextAction(root)).toContain("Review blocked candidates");
  });

  test("resolve without --reason fails closed without creating a Block", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(main(["block", "resolve", "--task", "WBS-001-004"], root)).toBe(2);
    expect(readBlock(root, "WBS-001-004").block).toBeUndefined();
    expect(readBlock(root, "WBS-001-004").issues.map((issue) => issue.code)).toContain("block.missing");
  });

  test("resolve rejects positional text and does not mutate an active Block", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(main(["block", "--task", "WBS-001-004", "Human Gate required"], root)).toBe(0);
    const before = readFileSync(path.join(root, "contracts/blocks/WBS-001-004.yaml"), "utf8");
    expect(main(["block", "resolve", "Decision recorded", "--task", "WBS-001-004"], root)).toBe(2);
    expect(readFileSync(path.join(root, "contracts/blocks/WBS-001-004.yaml"), "utf8")).toBe(before);
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
    expect(packet).toContain("Objective:");
    expect(packet).not.toContain("Goal:");
  });

  test("core packet standard outputs full packet with relation depth 0", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    const output: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(main(["packet", "--task", "WBS-001-004", "--standard"], root)).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }

    const packet = output.join("");
    expect(packet).toContain("# AI Work Packet");
    expect(packet).toContain("Allowed Paths");
    expect(packet).toContain("Stop Conditions");
  });

  test("packet displays policy-required and missing checks", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/check-coverage.yaml", {
      rules: [{ id: "integration", paths: ["src/commands/**"], requires: ["test:integration"] }]
    });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      allowedPaths: ["src/**"], requiredChecks: ["test"]
    }) as unknown as Record<string, unknown>);

    const packet = buildAiPacket(root, "WBS-001-004", 0);
    expect(packet).toContain("## Check Coverage");
    expect(packet).toContain("Allowed-path prediction:\nRequired checks:\n- test:integration");
    expect(packet).toContain("Missing from Task Contract:\n- test:integration");
  });

  test("packet compares allowed-path and current-diff coverage", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/check-coverage.yaml", {
      implementationRoots: ["src/core"],
      rules: [{
        id: "core-safety",
        classification: "behavior-critical",
        rationale: "Core workflow behavior requires integration coverage.",
        paths: ["src/core/git.ts"],
        requires: ["test:integration"]
      }]
    });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      allowedPaths: ["src/core/git.ts"], requiredChecks: ["test"]
    }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root, stdio: "ignore" });
    writeText(root, "src/core/git.ts", "export const changed = true;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "core change"], { cwd: root, stdio: "ignore" });

    const packet = buildAiPacket(root, "WBS-001-004", 0);
    expect(packet).toContain("Allowed-path prediction:");
    expect(packet).toContain("Current branch diff (origin/main):");
    expect(packet).toContain("Unclassified implementation paths:\n- None");
    expect(packet.match(/Missing from Task Contract:\n- test:integration/g)).toHaveLength(2);
  });

  test("core packet full outputs deep packet with relation depth 1", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    const output: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(main(["packet", "--task", "WBS-001-004", "--full"], root)).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }

    const packet = output.join("");
    expect(packet).toContain("# AI Work Packet");
    expect(packet).toContain("Relation depth: 1");
  });

  test("core packet defaults to tiny when no size flag given", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    const output: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(main(["packet", "--task", "WBS-001-004"], root)).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }

    const packet = output.join("");
    expect(packet).toContain("# Tiny Packet");
    expect(packet).toContain("Objective:");
    expect(packet).toContain("npm run scwbs -- finish --task WBS-001-004");
  });

  test("packet context manifest is deterministic, source-free, and records import provenance", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeText(root, "src/feature.ts", "import { helper } from \"./helper.js\";\nexport const secretSourceBody = helper;\n");
    writeText(root, "src/helper.ts", "export const helper = 1;\n");
    writeText(root, "src/caller.ts", "import { secretSourceBody } from \"./feature.js\";\nvoid secretSourceBody;\n");
    writeYaml(root, "contracts/check-coverage.yaml", {
      implementationRoots: ["src"],
      rules: [{
        id: "source",
        classification: "behavior-critical",
        rationale: "Source behavior requires integration coverage.",
        paths: ["src/**"],
        requires: ["test:integration"]
      }]
    });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      allowedPaths: ["src/feature.ts"],
      requiredChecks: ["test", "typecheck"]
    }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "context fixture"], { cwd: root, stdio: "ignore" });

    const first = buildCodeContextManifestJson(root, "WBS-001-004");
    writeText(root, "src/feature.ts", "export const uncommittedSourceBody = 99;\n");
    const second = buildCodeContextManifestJson(root, "WBS-001-004");
    expect(second).toBe(first);
    expect(first).not.toContain("secretSourceBody");
    const manifest = JSON.parse(first);
    expect(manifest.mustRead.map((item: { path: string }) => item.path)).toEqual([
      "contracts/tasks/WBS-001-004.yaml"
    ]);
    expect(manifest.candidates.map((item: { path: string; editable: boolean }) => [item.path, item.editable])).toEqual([
      ["src/caller.ts", false],
      ["src/feature.ts", true],
      ["src/helper.ts", false]
    ]);
    expect(manifest.candidates.find((item: { path: string }) => item.path === "src/caller.ts").reasons[0]).toContain("reverse-importer:src/feature.ts");
    expect(manifest.candidates.find((item: { path: string }) => item.path === "src/helper.ts").reasons[0]).toContain("direct-static-import:src/feature.ts");
    expect(manifest.coverage).toEqual({ required: ["test:integration"], missing: ["test:integration"], unclassified: [] });
    expect(manifest.completeness.reasons).toContain("coverage-missing");
    expect(manifest.constraints.sourceContentIncluded).toBe(false);
  });

  test("context manifest does not expand broad or protected paths and reports incomplete analysis", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeText(root, "src/feature.ts", "import { value } from \"./barrel.js\";\nimport(\"./dynamic.js\");\nexport * from \"./barrel.js\";\nvoid value;\n");
    writeText(root, "src/barrel.ts", "export const value = 1;\n");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      allowedPaths: ["src/feature.ts", "tests/**"],
      forbiddenPaths: ["src/barrel.ts"],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "context fixture"], { cwd: root, stdio: "ignore" });

    const manifest = buildCodeContextManifest(root, "WBS-001-004");
    expect(manifest.excluded).toContainEqual({ path: "tests/**", reasons: ["broad-glob-not-expanded"], editable: false });
    expect(manifest.excluded.find((item) => item.path === "src/barrel.ts")?.reasons).toContain("protected-path-not-promoted");
    expect(manifest.candidates.map((item) => item.path)).toEqual(["src/feature.ts"]);
    expect(manifest.completeness.status).toBe("widening-required");
    expect(manifest.completeness.reasons).toEqual(expect.arrayContaining(["broad-glob", "dynamic-import", "re-export"]));
  });

  test("context manifest omits candidates deterministically when the budget is exceeded", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeText(root, "src/feature.ts", "import { helper } from \"./helper.js\";\nvoid helper;\n");
    writeText(root, "src/helper.ts", "export const helper = 1;\n");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      allowedPaths: ["src/feature.ts"],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "context fixture"], { cwd: root, stdio: "ignore" });

    const manifest = buildCodeContextManifest(root, "WBS-001-004", { maxFiles: 2, maxBytes: 100_000 });
    expect(manifest.candidates.map((item) => item.path)).toEqual(["src/feature.ts"]);
    expect(manifest.budget.omitted).toBe(1);
    expect(manifest.excluded.find((item) => item.path === "src/helper.ts")?.reasons).toContain("budget-exceeded");
    expect(manifest.completeness.reasons).toContain("budget-exceeded");
  });

  test("packet --context-json writes parseable JSON without changing tiny packet behavior", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeText(root, "src/feature.ts", "export const value = 1;\n");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ allowedPaths: ["src/feature.ts"] }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "context fixture"], { cwd: root, stdio: "ignore" });
    const output: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(main(["packet", "--task", "WBS-001-004", "--context-json"], root)).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(JSON.parse(output.join("")).schemaVersion).toBe("1.0.0");
    expect(buildTinyPacket(root, "WBS-001-004").split("\n").length).toBeLessThanOrEqual(50);
  });

  test("context manifest excludes noncurrent documents by default and supports an explicit override", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeText(root, "docs/current/index.md", "# Current\n");
    writeText(root, "docs/proposal/index.md", "# Proposal\n");
    writeJson(root, "package.json", { version: "0.1.0" });
    writeJson(root, "docs/document-lifecycle.json", {
      schemaVersion: "1.0.0",
      standardEntrypoints: ["docs/current/index.md"],
      documents: [
        {
          documentId: "current",
          status: "normative",
          version: "1.0.0",
          appliesToCli: ">=0.1.0 <0.2.0",
          entrypoint: "docs/current/index.md",
          paths: ["docs/current/**"],
          supersedes: []
        },
        {
          documentId: "proposal",
          status: "proposal",
          version: "0.1.0",
          appliesToCli: ">=0.1.0 <0.2.0",
          entrypoint: "docs/proposal/index.md",
          paths: ["docs/proposal/**"],
          supersedes: []
        }
      ]
    });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      allowedPaths: ["docs/current/index.md", "docs/proposal/index.md"],
      forbiddenPaths: [],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "document context fixture"], { cwd: root, stdio: "ignore" });

    const filtered = buildCodeContextManifest(root, "WBS-001-004");
    expect(filtered.candidates.map((item) => item.path)).toEqual(["docs/current/index.md"]);
    expect(filtered.excluded.find((item) => item.path === "docs/proposal/index.md")?.reasons)
      .toContain("document-status-proposal");
    expect(filtered.completeness.reasons).toContain("non-current-document");

    const included = buildCodeContextManifest(root, "WBS-001-004", { includeNonCurrentDocs: true });
    expect(included.candidates.map((item) => item.path)).toEqual([
      "docs/current/index.md",
      "docs/proposal/index.md"
    ]);

    const output: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(main([
        "packet",
        "--task",
        "WBS-001-004",
        "--context-json",
        "--context-include-noncurrent-docs"
      ], root)).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(JSON.parse(output.join("")).candidates.map((item: { path: string }) => item.path))
      .toContain("docs/proposal/index.md");
  });

  test("packet --context-json manifest conforms to the versioned JSON schema", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeText(root, "src/feature.ts", "import { helper } from \"./helper.js\";\nexport const value = helper;\n");
    writeText(root, "src/helper.ts", "export const helper = 1;\n");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ allowedPaths: ["src/feature.ts"] }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "context fixture"], { cwd: root, stdio: "ignore" });

    const manifest = buildCodeContextManifest(root, "WBS-001-004");
    const schema = JSON.parse(readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/code-context-manifest.schema.json"), "utf8"));
    const ajv = new Ajv2020({ strict: false });
    expect(ajv.compile(schema)(manifest)).toBe(true);
  });

  test("schema rejects manifest with missing required fields", () => {
    const schema = JSON.parse(readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/code-context-manifest.schema.json"), "utf8"));
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);

    const base = {
      schemaVersion: "1.0.0",
      task: { id: "T", contractPath: "c.yaml", contractHash: `sha256:${"a".repeat(64)}` },
      repository: { head: "h" },
      mustRead: [],
      candidates: [],
      excluded: [],
      widening: [],
      coverage: { required: [], missing: [], unclassified: [] },
      budget: { maxFiles: 10, maxBytes: 1000, selectedFiles: 0, selectedBytes: 0, omitted: 0 },
      completeness: { status: "complete", reasons: [] },
      constraints: { sourceContentIncluded: false, grantsEditAuthority: false, permitsRequiredCheckOmission: false }
    };

    expect(validate({ ...base, schemaVersion: undefined })).toBe(false);
    expect(validate({ ...base, schemaVersion: "2.0.0" })).toBe(false);
    expect(validate({ ...base, task: { id: "T" } })).toBe(false);
    expect(validate({ ...base, completeness: { status: "bogus", reasons: [] } })).toBe(false);
    expect(validate({ ...base, constraints: { sourceContentIncluded: "yes", grantsEditAuthority: false, permitsRequiredCheckOmission: false } })).toBe(false);
    expect(validate({ ...base, extraField: "should fail" })).toBe(false);
    expect(validate({ ...base, mustRead: [{ path: "x.ts", contentHash: "md5:abc", bytes: 1, lines: 1, lineRanges: [{ start: 1, end: 1 }], reasons: [], editable: false }] })).toBe(false);
  });

  test("tiny packet identifies WBS-less deny-all and broad scope risks", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      wbsNodeId: "wbs-less",
      allowedPaths: []
    }) as unknown as Record<string, unknown>);

    const denyAll = buildTinyPacket(root, "WBS-001-004");
    expect(denyAll).toContain("Node: wbs-less");
    expect(denyAll).toContain("Scope Risk:\n- deny-all draft");

    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      wbsNodeId: "wbs-less",
      allowedPaths: ["src/**"]
    }) as unknown as Record<string, unknown>);
    expect(buildTinyPacket(root, "WBS-001-004")).toContain("Scope Risk:\n- broad; explicit review required (src/**)");
  });

  test("tiny packet shows related Discovery Probe state and stop instruction", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const probe = {
      schemaVersion: "1.0.0",
      id: "PROBE-cache",
      type: "discovery-probe",
      status: "active",
      question: "Can the existing cache meet the target?",
      hypotheses: ["Existing cache is enough"],
      activities: ["Measure representative load"],
      evidenceExpected: ["p95 latency"],
      unknowns: ["Peak degradation"],
      timebox: "4h",
      costLimit: "one engineer-day",
      exitConditions: ["Representative run complete"],
      nextDecision: "Choose the delivery design",
      deliveryTaskId: "WBS-001-004"
    };
    writeYaml(root, "contracts/discovery/PROBE-cache.yaml", probe);

    const blocked = buildTinyPacket(root, "WBS-001-004");
    expect(blocked).toContain("Discovery:");
    expect(blocked).toContain("PROBE-cache: active");
    expect(blocked).toContain("Stop: related Discovery Probe is not concluded");

    writeYaml(root, "contracts/discovery/PROBE-cache.yaml", {
      ...probe,
      status: "concluded",
      concludedAt: "2026-07-26T00:00:00.000Z",
      exitConditionsMet: true,
      factsLearned: ["p95 met the target"],
      hypothesesRejected: ["A new store is required"]
    });
    expect(buildTinyPacket(root, "WBS-001-004")).not.toContain("Stop: related Discovery Probe");
  });

  test("core command aliases route to existing approval and block commands", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(main(["request-approval", "--task", "WBS-001-004", "--pr", "#42", "--note", "Needs review"], root)).toBe(0);
    expect(readApproval(root, "WBS-001-004").approval?.status).toBe("requested");
    expect(main(["approve", "--task", "WBS-001-004", "--pr", "#42", "--actor", "human", "--reason=Reviewed"], root)).toBe(0);
    expect(readApproval(root, "WBS-001-004").approval?.status).toBe("approved");
    expect(main(["block", "Human Gate required", "--task", "WBS-001-004"], root)).toBe(0);
    expect(readBlock(root, "WBS-001-004").block?.category).toBe("human-gate");
    expect(main(["block", "resolve", "--task", "WBS-001-004", "--reason", "Reviewed by a human"], root)).toBe(0);
    expect(readBlock(root, "WBS-001-004").block?.status).toBe("resolved");
  });
});
