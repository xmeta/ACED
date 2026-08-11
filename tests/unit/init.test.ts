import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runAgentAdd, runAgentRemove, runAgentSetPrimary, runAgentUpdate, runInit } from "../../src/commands/init.js";
import { assertSafeAgentPath, listAgentAdapters } from "../../src/core/agent-adapters.js";
import { validateWbsDocument } from "../../src/core/wbs.js";
import { type WbsDocument } from "../../src/core/types.js";
import { makeTempRepo, sampleWbs, writeJson } from "../helpers.js";

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
    expect(wbs.extensions?.scwbs).toMatchObject({
      profile: "Lean",
      agent: "codex",
      primaryAgent: "codex",
      agents: ["codex"],
      lang: "ja"
    });
  });

  test("init creates the selected AI tool adapter and manifest", () => {
    const root = makeTempRepo();
    expect(runInit(root, { agent: "claude", lang: "en" })).toBe(0);
    expect(readFileSync(path.join(root, ".claude/commands/scwbs.md"), "utf8")).toContain("Use English");
    expect(readFileSync(path.join(root, ".scwbs/agent-files.json"), "utf8")).toContain("claude");
  });

  test.each([
    ["codex", "AGENTS.md"],
    ["claude", ".claude/commands/scwbs.md"],
    ["cursor", ".cursor/rules/scwbs.mdc"],
    ["copilot", ".github/copilot-instructions.md"],
    ["gemini", ".gemini/commands/scwbs.md"],
    ["opencode", ".opencode/commands/scwbs.md"]
  ] as const)("renders the data-driven %s adapter fixture", (agent, relativePath) => {
    const root = makeTempRepo();
    expect(runInit(root, { agent })).toBe(0);
    expect(readFileSync(path.join(root, relativePath), "utf8")).toContain("# SC-WBS");
  });

  test("registry exposes versioned capabilities and locale metadata", () => {
    expect(listAgentAdapters()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gemini", status: "preview", capabilities: expect.objectContaining({ mcp: true, localeKeys: expect.any(Array) }) }),
      expect.objectContaining({ id: "opencode", status: "preview" })
    ]));
  });

  test("agent adapter paths fail closed for traversal and symlink escape", () => {
    const root = makeTempRepo();
    expect(() => assertSafeAgentPath(root, "../outside.md")).toThrow("Unsafe agent adapter path");
    mkdirSync(path.join(root, "external"));
    symlinkSync(path.join(root, "external"), path.join(root, ".gemini"), "dir");
    expect(() => runInit(root, { agent: "gemini" })).toThrow("symlink");
  });

  test("update preserves a divergent generated file", () => {
    const root = makeTempRepo();
    expect(runInit(root, { agent: "cursor" })).toBe(0);
    const file = path.join(root, ".cursor/rules/scwbs.mdc");
    writeJson(root, ".cursor/rules/scwbs.mdc", { custom: true });
    expect(runAgentUpdate(root, { agent: "cursor" })).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("custom");
  });

  test("init adds a second agent without losing the first agent manifest ownership", () => {
    const root = makeTempRepo();
    expect(runInit(root, { agent: "codex" })).toBe(0);
    expect(runInit(root, { agent: "claude" })).toBe(0);
    const manifest = JSON.parse(readFileSync(path.join(root, ".scwbs/agent-files.json"), "utf8")) as {
      schemaVersion: string;
      primaryAgent: string;
      agents: string[];
      files: Array<{ owner: string; path: string }>;
    };
    expect(manifest).toMatchObject({ schemaVersion: "2", primaryAgent: "codex", agents: ["codex", "claude"] });
    expect(manifest.files).toEqual(expect.arrayContaining([
      { owner: "codex", path: "AGENTS.md", sha256: expect.any(String) },
      { owner: "claude", path: ".claude/commands/scwbs.md", sha256: expect.any(String) }
    ]));
  });

  test("v1 migration preserves divergent files and dry-run does not write", () => {
    const root = makeTempRepo();
    expect(runInit(root, { agent: "codex" })).toBe(0);
    const manifestPath = path.join(root, ".scwbs/agent-files.json");
    const legacy = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: Array<{ path: string; sha256: string }> };
    writeJson(root, ".scwbs/agent-files.json", { schemaVersion: "1", agent: "codex", files: legacy.files });
    writeJson(root, "AGENTS.md", { custom: true });
    const before = readFileSync(manifestPath, "utf8");
    expect(runAgentUpdate(root, { dryRun: true, json: true })).toBe(0);
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
    expect(runAgentUpdate(root, { json: true })).toBe(0);
    const migrated = JSON.parse(readFileSync(manifestPath, "utf8")) as { schemaVersion: string };
    expect(migrated.schemaVersion).toBe("2");
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain("custom");
  });

  test("agent commands converge primary state and never delete divergent files", () => {
    const root = makeTempRepo();
    expect(runInit(root, { agent: "codex" })).toBe(0);
    expect(runAgentSetPrimary(root, "claude")).toBe(2);
    expect(runAgentAdd(root, "claude")).toBe(0);
    expect(runAgentSetPrimary(root, "claude")).toBe(0);
    writeJson(root, ".claude/commands/scwbs.md", { custom: true });
    expect(runAgentRemove(root, "claude")).toBe(0);
    expect(readFileSync(path.join(root, ".claude/commands/scwbs.md"), "utf8")).toContain("custom");
    const wbs = JSON.parse(readFileSync(path.join(root, "contracts/wbs/project.wbs.json"), "utf8")) as WbsDocument;
    expect(wbs.extensions?.scwbs).toMatchObject({ agent: "codex", primaryAgent: "codex", agents: ["codex"] });
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
