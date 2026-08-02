import { describe, expect, test } from "vitest";
import { taskWbsAssociation } from "../../src/core/task-wbs-policy.js";
import type { TaskContract, WbsDocument } from "../../src/core/types.js";
import { sampleTask, sampleWbs } from "../helpers.js";

function task(overrides: Partial<TaskContract> = {}): TaskContract {
  return sampleTask(overrides);
}

describe("taskWbsAssociation", () => {
  test("classifies WBS-less tasks without resolving a node", () => {
    expect(taskWbsAssociation(sampleWbs(), task({ wbsNodeId: "wbs-less" }))).toEqual({
      kind: "wbs-less",
      nodeId: "wbs-less"
    });
  });

  test("returns the resolved node for a WBS-backed task", () => {
    const wbs = sampleWbs();
    const association = taskWbsAssociation(wbs, task({ wbsNodeId: "node-api" }));
    expect(association.kind).toBe("node");
    if (association.kind === "node") {
      expect(association.node).toBe(wbs.nodes.find((node) => node.id === "node-api"));
    }
  });

  test("keeps a missing WBS node distinct from WBS-less", () => {
    const wbs = sampleWbs() as WbsDocument;
    expect(taskWbsAssociation(wbs, task({ wbsNodeId: "node-missing" }))).toEqual({
      kind: "missing-node",
      nodeId: "node-missing"
    });
  });
});
