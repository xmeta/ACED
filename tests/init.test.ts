import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runInit } from "../src/commands/init.js";
import { validateWbsDocument } from "../src/core/wbs.js";
import { type WbsDocument } from "../src/core/types.js";
import { makeTempRepo, sampleWbs, writeJson } from "./helpers.js";

describe("init + WBS validation", () => {
  test("init creates a valid minimal WJS document", () => {
    const root = makeTempRepo();
    expect(runInit(root)).toBe(0);
    expect(validateWbsDocument(root)).toEqual([]);
  });

  test("init stores profile agent and language options", () => {
    const root = makeTempRepo();
    expect(runInit(root, { profile: "lean", agent: "codex", lang: "ja" })).toBe(0);
    const wbs = JSON.parse(readFileSync(path.join(root, "contracts/wbs/project.wbs.json"), "utf8")) as WbsDocument;
    expect(wbs.metadata?.language).toBe("ja-JP");
    expect(wbs.extensions?.scwbs).toEqual({
      profile: "Lean",
      agent: "codex",
      lang: "ja"
    });
  });

  test("invalid WBS document reports validation errors", () => {
    const root = makeTempRepo();
    writeJson(root, "contracts/wbs/project.wbs.json", { schemaVersion: "0.1.0", id: "bad" });
    const issues = validateWbsDocument(root);
    expect(issues.some((issue) => issue.code.startsWith("wbs."))).toBe(true);
  });

  test("WBS document duplicate code validation", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs();
    wbs.nodes.push({
      id: "node-duplicate-code",
      parentId: wbs.rootId,
      code: wbs.nodes[0].code,
      name: "Duplicate Code Node",
      type: "workPackage",
      status: "planned"
    });
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    const issues = validateWbsDocument(root);
    expect(issues.some((issue) => issue.code === "wbs.code.duplicate")).toBe(true);
  });

  test("WBS document status and progress mismatch validation", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs();
    wbs.nodes[0].status = "completed";
    wbs.nodes[0].progressPercent = 50;
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    let issues = validateWbsDocument(root);
    expect(issues.some((issue) => issue.code === "wbs.status.progress.mismatch")).toBe(true);

    wbs.nodes[0].status = "inProgress";
    wbs.nodes[0].progressPercent = 100;
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    issues = validateWbsDocument(root);
    expect(issues.some((issue) => issue.code === "wbs.status.progress.mismatch")).toBe(true);
  });

  test("WBS document parent completed with incomplete child validation", () => {
    const root = makeTempRepo();
    const wbs = sampleWbs();
    const parentNode = wbs.nodes.find(n => n.id === wbs.rootId);
    if (parentNode) {
      parentNode.status = "completed";
      parentNode.progressPercent = 100;
    }
    writeJson(root, "contracts/wbs/project.wbs.json", wbs);
    const issues = validateWbsDocument(root);
    expect(issues.some((issue) => issue.code === "wbs.hierarchy.incomplete_child")).toBe(true);
  });
});
