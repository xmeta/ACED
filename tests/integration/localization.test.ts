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
    expect(guidance).toContain("Use scwbs packet --task <id>.");
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
