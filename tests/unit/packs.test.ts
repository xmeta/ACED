import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { installPack, inspectPack, listPacks, removePack, searchPacks, updatePack } from "../../src/core/packs.js";
import { makeTempRepo, writeText } from "../helpers.js";

function packYaml(extra = ""): string {
  return `schemaVersion: scwbs.pack.v1
id: org.example.secure-node
version: 1.2.0
description: Secure Node baseline
contents:
  files:
    - source: guidance/common.md
      target: guidance/common.md
policy:
  requiredChecks:
    - security
  humanGatePaths:
    - src/security/**
  forbiddenPaths:
    - secrets/**
security:
  allowExecutableCode: false
${extra}`;
}

describe("Governance Pack v1", () => {
  test("inspects and installs a pinned local pack with a rebuildable lock", () => {
    const root = makeTempRepo();
    writeText(root, "fixture/pack.yaml", packYaml());
    writeText(root, "fixture/guidance/common.md", "# Secure guidance\n");

    const inspected = inspectPack(root, "fixture");
    expect(inspected).toMatchObject({ version: "scwbs.pack-inspect.v1", pack: { id: "org.example.secure-node", version: "1.2.0" }, effectivePolicyDelta: { additions: { requiredChecks: ["security"] }, rejectedDowngrades: [] } });
    const dryRun = installPack(root, "fixture", { pin: true, dryRun: true });
    expect(dryRun).toMatchObject({ version: "scwbs.pack-operation.v1", dryRun: true, decisions: [{ action: "create" }] });
    expect(installPack(root, "fixture", { pin: true, now: "2026-08-11T00:00:00Z" })).toMatchObject({ operation: "install", dryRun: false });
    expect(readFileSync(path.join(root, ".scwbs/packs/org.example.secure-node/1.2.0/guidance/common.md"), "utf8")).toContain("Secure guidance");
    expect(JSON.parse(readFileSync(path.join(root, ".scwbs/packs.lock.json"), "utf8"))).toMatchObject({ schemaVersion: "scwbs.packs-lock.v1", packs: [{ id: "org.example.secure-node", digest: expect.stringMatching(/^sha256:/) }] });
    expect(listPacks(root)).toMatchObject({ version: "scwbs.pack-list.v1", packs: [{ id: "org.example.secure-node" }] });
    expect(searchPacks(root, "secure-node")).toMatchObject({ version: "scwbs.pack-search.v1", trust: "discovery-only", packs: [{ id: "org.example.secure-node" }] });
    expect(updatePack(root, "org.example.secure-node", { dryRun: true })).toMatchObject({ operation: "install", dryRun: true });
    expect(removePack(root, "org.example.secure-node", { dryRun: true })).toMatchObject({ operation: "remove", dryRun: true, decisions: [{ action: "policy-downgrade-blocked" }] });
  });

  test("supports a pinned local Git ref without executing pack content", () => {
    const root = makeTempRepo();
    writeText(root, "pack.yaml", packYaml());
    writeText(root, "guidance/common.md", "# Git guidance\n");
    execFileSync("git", ["add", "pack.yaml", "guidance/common.md"], { cwd: root });
    execFileSync("git", ["commit", "-m", "pack fixture"], { cwd: root, stdio: "ignore" });
    expect(inspectPack(root, ".", "HEAD")).toMatchObject({ source: ".#HEAD", digest: expect.stringMatching(/^sha256:/) });
  });

  test.each([
    ["executable hook", "contents:\n  scripts:\n    - run.sh\n"],
    ["policy downgrade", "policy:\n  removeRequiredChecks:\n    - test\n"]
  ])("fails closed for %s", (_name, extra) => {
    const root = makeTempRepo();
    writeText(root, "fixture/pack.yaml", packYaml(extra));
    writeText(root, "fixture/guidance/common.md", "safe\n");
    expect(() => inspectPack(root, "fixture")).toThrow();
  });

  test("preserves divergent user-owned installed files", () => {
    const root = makeTempRepo();
    writeText(root, "fixture/pack.yaml", packYaml());
    writeText(root, "fixture/guidance/common.md", "generated\n");
    installPack(root, "fixture", { pin: true });
    writeText(root, ".scwbs/packs/org.example.secure-node/1.2.0/guidance/common.md", "user-owned\n");
    const result = installPack(root, "fixture", { pin: true });
    expect(result).toMatchObject({ decisions: [{ action: "divergent-preserved" }] });
    expect(readFileSync(path.join(root, ".scwbs/packs/org.example.secure-node/1.2.0/guidance/common.md"), "utf8")).toBe("user-owned\n");
  });

  test("rejects source traversal and symlink escape", () => {
    const root = makeTempRepo();
    expect(() => inspectPack(root, "../outside")).toThrow("inside the repository");
    const outside = path.join(path.dirname(root), "scwbs-pack-outside");
    mkdirSync(outside, { recursive: true });
    writeText(outside, "pack.yaml", packYaml());
    symlinkSync(outside, path.join(root, "linked-pack"), "dir");
    expect(() => inspectPack(root, "linked-pack")).toThrow("symlink boundary");
  });
});
