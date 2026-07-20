import { describe, expect, test } from "vitest";
import { buildCodeContextManifest, reverseImporterCounts } from "../../src/core/code-context.js";
import { makeTempRepo, sampleTask, writeScwbsProject, writeText, writeYaml } from "../helpers.js";
import { execFileSync } from "node:child_process";

describe("code-context helpers", () => {
  function commit(root: string, message: string): void {
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", message], { cwd: root, stdio: "ignore" });
  }

  test("reverseImporterCounts counts reverse importers per file", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeText(root, "src/feature.ts", "import { helper } from \"./helper.js\";\nexport const secretSourceBody = helper;\n");
    writeText(root, "src/helper.ts", "export const helper = 1;\n");
    writeText(root, "src/caller.ts", "import { secretSourceBody } from \"./feature.js\";\nvoid secretSourceBody;\n");
    writeText(root, "src/another.ts", "import { secretSourceBody } from \"./feature.js\";\nvoid secretSourceBody;\n");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      allowedPaths: ["src/feature.ts"],
      requiredChecks: ["test", "typecheck"]
    }) as unknown as Record<string, unknown>);
    commit(root, "context fixture");

    const manifest = buildCodeContextManifest(root, "WBS-001-004");
    const counts = reverseImporterCounts(manifest);
    expect(counts.get("src/feature.ts")).toBe(2);
    expect(counts.get("src/helper.ts")).toBeUndefined();
    expect(counts.get("src/caller.ts")).toBeUndefined();
  });

  test("reverseImporterCounts includes mustRead and candidates", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeText(root, "src/feature.ts", "export const value = 1;\n");
    writeText(root, "src/caller.ts", "import { value } from \"./feature.js\";\nvoid value;\n");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      allowedPaths: ["src/feature.ts"],
      requiredChecks: ["test", "typecheck"]
    }) as unknown as Record<string, unknown>);
    commit(root, "context fixture");

    const manifest = buildCodeContextManifest(root, "WBS-001-004");
    const counts = reverseImporterCounts(manifest);
    expect(counts.get("src/feature.ts")).toBe(1);
  });

  test("reverseImporterCounts counts unique importer files, not import statements", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeText(root, "src/feature.ts", "export const a = 1;\nexport const b = 2;\n");
    writeText(root, "src/caller.ts", "import { a } from \"./feature.js\";\nimport { b } from \"./feature.js\";\nvoid a;\nvoid b;\n");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      allowedPaths: ["src/feature.ts"],
      requiredChecks: ["test", "typecheck"]
    }) as unknown as Record<string, unknown>);
    commit(root, "context fixture");

    const manifest = buildCodeContextManifest(root, "WBS-001-004");
    const counts = reverseImporterCounts(manifest);
    expect(counts.get("src/feature.ts")).toBe(1);
  });
});
