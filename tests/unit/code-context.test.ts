import { describe, expect, test } from "vitest";
import { reverseImporterCounts, type CodeContextManifest } from "../../src/core/code-context.js";

describe("code-context helpers", () => {
  function manifestWithReasons({
    mustRead = [],
    candidates = []
  }: {
    mustRead?: string[][];
    candidates?: string[][];
  }): CodeContextManifest {
    return {
      mustRead: mustRead.map((reasons) => ({ reasons })),
      candidates: candidates.map((reasons) => ({ reasons }))
    } as unknown as CodeContextManifest;
  }

  test("reverseImporterCounts counts reverse importers per file", () => {
    const manifest = manifestWithReasons({
      candidates: [
        ["reverse-importer:src/feature.ts:1"],
        ["reverse-importer:src/feature.ts:1"],
        ["direct-static-import:src/feature.ts:1"]
      ]
    });
    const counts = reverseImporterCounts(manifest);
    expect(counts.get("src/feature.ts")).toBe(2);
    expect(counts.get("src/helper.ts")).toBeUndefined();
    expect(counts.get("src/caller.ts")).toBeUndefined();
  });

  test("reverseImporterCounts includes mustRead and candidates", () => {
    const manifest = manifestWithReasons({
      mustRead: [["reverse-importer:src/feature.ts:1"]],
      candidates: [["reverse-importer:src/feature.ts:2"]]
    });
    const counts = reverseImporterCounts(manifest);
    expect(counts.get("src/feature.ts")).toBe(2);
  });

  test("reverseImporterCounts counts unique importer files, not import statements", () => {
    const manifest = manifestWithReasons({
      candidates: [[
        "reverse-importer:src/feature.ts:1",
        "reverse-importer:src/feature.ts:2"
      ]]
    });
    const counts = reverseImporterCounts(manifest);
    expect(counts.get("src/feature.ts")).toBe(1);
  });
});
