import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildAiPacket, buildTinyPacket } from "../../src/commands/ai-packet.js";
import { buildBlockChangeSet, buildNextTask } from "../../src/commands/ai-queue.js";
import { buildNextAction } from "../../src/commands/next.js";
import { main } from "../../src/cli.js";
import { readApproval, readBlock } from "../../src/core/contracts.js";
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

  test("the legacy positional reason resolve remains a normal block reason", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(main(["block", "resolve", "--task", "WBS-001-004"], root)).toBe(0);
    expect(readBlock(root, "WBS-001-004").block).toMatchObject({ status: "blocked", reason: "resolve" });
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
