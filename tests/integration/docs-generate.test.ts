import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { main } from "../../src/cli.js";
import { buildGeneratedContractsMarkdown, generatedContractsDocPath } from "../../src/cli.js";
import { makeTempRepo, writeScwbsProject, writeText } from "../helpers.js";

describe("docs generate", () => {
  test("renders WBS, Task-to-Spec, and Human Gate data deterministically", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    const expected = buildGeneratedContractsMarkdown(root);
    expect(main(["docs", "generate"], root)).toBe(0);
    expect(readFileSync(`${root}/${generatedContractsDocPath}`, "utf8")).toBe(expected);
    expect(expected).toContain("# SC-WBS Contract Summary");
    expect(expected).toContain("WBS-001-004");
    expect(expected).toContain("SPEC-F001-API (approved)");
    expect(expected).toContain("src/security/**");
    expect(expected).toContain("planned: 2");
  });

  test("checks freshness without writing and rejects stale output", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(main(["docs", "generate"], root)).toBe(0);
    expect(main(["docs", "generate", "--check"], root)).toBe(0);

    const outputPath = `${root}/${generatedContractsDocPath}`;
    const before = readFileSync(outputPath, "utf8");
    writeText(root, generatedContractsDocPath, `${before}\nmanual drift\n`);
    expect(main(["docs", "generate", "--check"], root)).toBe(1);
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, "utf8")).toContain("manual drift");
  });
});
