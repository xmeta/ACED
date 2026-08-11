import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { indexStatus, queryIndex, rebuildIndex, verifyIndex } from "../../src/core/local-index.js";
import { makeTempRepo, writeText } from "../helpers.js";

describe("local SQLite index", () => {
  test("rebuilds canonical records with provenance and bounded query output", () => {
    const root = makeTempRepo();
    writeText(root, "contracts/specs/SPEC-A.yaml", "id: SPEC-A\ntype: spec-contract\nversion: 1.0.0\ntitle: Auth policy\nstatus: approved\nacceptanceCriteria:\n  - Verify auth\n");
    const rebuilt = rebuildIndex(root) as { recordCount: number; status: string };
    expect(rebuilt).toMatchObject({ status: "pass" });
    expect(rebuilt.recordCount).toBeGreaterThanOrEqual(2);
    expect(indexStatus(root)).toMatchObject({ status: "ready", path: ".scwbs/cache/index.sqlite" });
    expect(queryIndex(root, { text: "auth", limit: 1 })).toMatchObject({ version: "scwbs.query.v1", status: "ready", results: [{ sourcePath: "contracts/specs/SPEC-A.yaml", sourceHash: expect.stringMatching(/^sha256:/), locator: expect.stringMatching(/^contracts\/specs\/SPEC-A.yaml/) }] });
    expect((queryIndex(root, { text: "auth", limit: 100 }).results[0]?.snippet.length ?? 0)).toBeLessThanOrEqual(500);
    expect(verifyIndex(root)).toMatchObject({ version: "scwbs.index-verify.v1", status: "ready" });
  });

  test("detects stale sources and recovers corrupt cache by rebuild", () => {
    const root = makeTempRepo();
    writeText(root, "contracts/specs/SPEC-A.yaml", "id: SPEC-A\ntype: spec-contract\nversion: 1.0.0\ntitle: Initial\nstatus: approved\nacceptanceCriteria: []\n");
    rebuildIndex(root);
    writeText(root, "contracts/specs/SPEC-A.yaml", "id: SPEC-A\ntype: spec-contract\nversion: 1.0.0\ntitle: Changed auth\nstatus: approved\nacceptanceCriteria: []\n");
    expect(indexStatus(root)).toMatchObject({ status: "stale", reasons: expect.arrayContaining(["index.source.stale"]) });
    expect(queryIndex(root, { kinds: ["spec"], stale: true }).results).toHaveLength(1);
    writeFileSync(path.join(root, ".scwbs/cache/index.sqlite"), "corrupt", "utf8");
    expect(indexStatus(root)).toMatchObject({ status: "corrupt" });
    expect(rebuildIndex(root)).toMatchObject({ status: "pass" });
    expect(indexStatus(root)).toMatchObject({ status: "ready" });
  });

  test("missing cache is a non-authoritative fallback", () => {
    const root = makeTempRepo();
    mkdirSync(path.join(root, "contracts"), { recursive: true });
    expect(queryIndex(root, { text: "anything" })).toMatchObject({ status: "missing", total: 0, results: [] });
  });
});
