import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildWbsMergeChangeset, buildWbsMergePlan } from "../../src/core/wbs.js";
import { runWbsMergePlan } from "../../src/commands/wbs.js";
import { makeTempRepo, sampleWbs, writeJson } from "../helpers.js";
import type { WbsDocument } from "../../src/core/types.js";

function clone(document: WbsDocument): WbsDocument {
  return JSON.parse(JSON.stringify(document)) as WbsDocument;
}

describe("WBS semantic merge plan", () => {
  test("classifies independent node edits as clean and emits WJS operations", () => {
    const base = sampleWbs();
    const ours = clone(base);
    ours.nodes.push({
      id: "node-design",
      parentId: "node-root",
      code: "1.2",
      name: "Design",
      type: "activity",
      status: "planned"
    });
    const theirs = clone(base);
    theirs.nodes.find((node) => node.id === "node-api")!.name = "API v2";

    const plan = buildWbsMergePlan(base, ours, theirs);

    expect(plan.status).toBe("clean");
    expect(plan.conflicts).toEqual([]);
    expect(plan.autoMergeableOperations.map((operation) => operation.operation).sort()).toEqual(["addNode", "updateNode"]);
    expect(buildWbsMergeChangeset(plan, base.id).operations).toHaveLength(2);
  });

  test("reports concurrent field edits and delete-vs-modify without choosing a winner", () => {
    const base = sampleWbs();
    const ours = clone(base);
    ours.nodes.find((node) => node.id === "node-api")!.name = "API ours";
    const theirs = clone(base);
    theirs.nodes.find((node) => node.id === "node-api")!.name = "API theirs";

    const concurrent = buildWbsMergePlan(base, ours, theirs);
    expect(concurrent.status).toBe("conflicted");
    expect(concurrent.conflicts).toEqual([
      expect.objectContaining({ class: "node.field.concurrent-edit", path: "node[node-api].name" })
    ]);
    expect(concurrent.autoMergeableOperations).toEqual([]);
    expect(() => buildWbsMergeChangeset(concurrent, base.id)).toThrow(/conflicted/);

    const deleted = clone(base);
    deleted.nodes = deleted.nodes.filter((node) => node.id !== "node-api");
    const modified = clone(base);
    modified.nodes.find((node) => node.id === "node-api")!.status = "blocked";
    const deleteVsModify = buildWbsMergePlan(base, deleted, modified);
    expect(deleteVsModify.conflicts).toEqual([
      expect.objectContaining({ class: "node.delete-vs-modify", identity: "node-api" })
    ]);
  });

  test("ignores formatting and collection order while rejecting identity collisions", () => {
    const base = sampleWbs();
    const ours = clone(base);
    ours.nodes.reverse();
    const theirs = clone(base);
    theirs.nodes = [...theirs.nodes].reverse();
    const formattingOnly = buildWbsMergePlan(base, ours, theirs);
    expect(formattingOnly.status).toBe("clean");
    expect(formattingOnly.autoMergeableOperations).toEqual([]);

    const addedOurs = clone(base);
    addedOurs.nodes.push({ id: "node-collision", parentId: "node-root", code: "1.3", name: "Ours", type: "activity" });
    const addedTheirs = clone(base);
    addedTheirs.nodes.push({ id: "node-collision", parentId: "node-root", code: "1.4", name: "Theirs", type: "activity" });
    const collision = buildWbsMergePlan(base, addedOurs, addedTheirs);
    expect(collision.conflicts).toEqual([
      expect.objectContaining({ class: "node.id.collision", identity: "node-collision" })
    ]);
  });

  test("writes only an explicit clean-plan changeset and never edits canonical WBS", () => {
    const root = makeTempRepo();
    const base = sampleWbs();
    const ours = clone(base);
    ours.nodes.find((node) => node.id === "node-api")!.status = "blocked";
    const theirs = clone(base);
    writeJson(root, "base.json", base);
    writeJson(root, "ours.json", ours);
    writeJson(root, "theirs.json", theirs);
    writeJson(root, "contracts/wbs/project.wbs.json", base);
    const before = readFileSync(`${root}/contracts/wbs/project.wbs.json`, "utf8");

    expect(runWbsMergePlan(root, {
      base: "base.json",
      ours: "ours.json",
      theirs: "theirs.json",
      writeChangeset: "out/merge.json"
    })).toBe(0);
    expect(existsSync(`${root}/out/merge.json`)).toBe(true);
    expect(readFileSync(`${root}/contracts/wbs/project.wbs.json`, "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(`${root}/out/merge.json`, "utf8"))).toEqual(expect.objectContaining({
      schemaVersion: "0.1.0",
      targetWbsId: "test-wbs",
      dryRun: true
    }));
  });
});
