import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runAgentUpdate, runInit } from "../../src/commands/init.js";
import { makeTempRepo } from "../helpers.js";

describe("localization integration", () => {
  test("init renders an additional locale and preserves stable adapter commands", () => {
    const root = makeTempRepo();
    expect(runInit(root, { agent: "codex", lang: "fr" })).toBe(0);
    const guidance = readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(guidance).toContain("Suivez AGENTS.md");
    expect(guidance).toContain("Utilisez scwbs packet --task <id>.");
  });

  test("existing projects can switch locale explicitly without rewriting divergent files", () => {
    const root = makeTempRepo();
    expect(runInit(root, { agent: "codex", lang: "en" })).toBe(0);
    expect(runInit(root, { agent: "codex", lang: "ja" })).toBe(0);
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain("AGENTS.md と Task Contract に従ってください。");
    const wbs = JSON.parse(readFileSync(path.join(root, "contracts/wbs/project.wbs.json"), "utf8")) as { metadata?: { language?: string }; extensions?: { scwbs?: { lang?: string } } };
    expect(wbs.metadata?.language).toBe("ja-JP");
    expect(wbs.extensions?.scwbs?.lang).toBe("ja");
    writeFileSync(path.join(root, "AGENTS.md"), "# user-owned translation\n", "utf8");
    expect(runAgentUpdate(root, { lang: "fr" })).toBe(0);
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe("# user-owned translation\n");
    expect(JSON.parse(readFileSync(path.join(root, "contracts/wbs/project.wbs.json"), "utf8")).extensions.scwbs.lang).toBe("fr");
  });

  test("agent update supports locale switching and dry-run without writing", () => {
    const root = makeTempRepo();
    expect(runInit(root, { agent: "codex", lang: "en" })).toBe(0);
    const before = readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(runAgentUpdate(root, { lang: "fr", dryRun: true, json: true })).toBe(0);
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe(before);
    expect(runAgentUpdate(root, { lang: "fr" })).toBe(0);
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain("Utilisez le workflow SC-WBS.");
  });

  test("locale update never overwrites a user-owned divergent file", () => {
    const root = makeTempRepo();
    expect(runInit(root, { agent: "codex", lang: "ja" })).toBe(0);
    const file = path.join(root, "AGENTS.md");
    writeFileSync(file, "# user-owned translation\n", "utf8");
    expect(runAgentUpdate(root, { agent: "codex" })).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("# user-owned translation\n");
  });
});
