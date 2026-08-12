import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { installPack, inspectPack, listPacks, removePack, searchPacks, updatePack } from "../../src/core/packs.js";
import { makeTempRepo, writeText } from "../helpers.js";

function packYaml(extra = "", version = "1.2.0"): string {
  return `schemaVersion: scwbs.pack.v1
id: org.example.secure-node
version: ${version}
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
    expect(updatePack(root, "org.example.secure-node", { dryRun: true })).toMatchObject({ operation: "update", dryRun: true, noOp: true, old: { version: "1.2.0" }, new: { version: "1.2.0" }, decisions: [] });
    const beforeNoOpLock = readFileSync(path.join(root, ".scwbs/packs.lock.json"), "utf8");
    expect(updatePack(root, "org.example.secure-node", { now: "2026-08-12T00:00:00Z" })).toMatchObject({ operation: "update", noOp: true, decisions: [] });
    expect(readFileSync(path.join(root, ".scwbs/packs.lock.json"), "utf8")).toBe(beforeNoOpLock);
    expect(removePack(root, "org.example.secure-node", { dryRun: true })).toMatchObject({ operation: "remove", dryRun: true, decisions: [{ action: "policy-downgrade-blocked" }] });
  });

  test("updates v1 to v2, reports old/new provenance, and preserves the old version", () => {
    const root = makeTempRepo();
    writeText(root, "fixture/pack.yaml", packYaml("", "1.0.0"));
    writeText(root, "fixture/guidance/common.md", "v1\n");
    installPack(root, "fixture", { pin: true, now: "2026-08-11T00:00:00Z" });
    writeText(root, "fixture/pack.yaml", packYaml("", "2.0.0"));
    writeText(root, "fixture/guidance/common.md", "v2\n");

    const beforeLock = readFileSync(path.join(root, ".scwbs/packs.lock.json"), "utf8");
    const dryRun = updatePack(root, "org.example.secure-node", { dryRun: true });
    expect(dryRun).toMatchObject({ operation: "update", dryRun: true, old: { version: "1.0.0", source: "fixture" }, new: { version: "2.0.0", source: "fixture" }, decisions: [{ action: "create" }] });
    expect(readFileSync(path.join(root, ".scwbs/packs.lock.json"), "utf8")).toBe(beforeLock);
    expect(existsSync(path.join(root, ".scwbs/packs/org.example.secure-node/2.0.0/guidance/common.md"))).toBe(false);

    const result = updatePack(root, "org.example.secure-node", { now: "2026-08-12T00:00:00Z" });
    expect(result).toMatchObject({ operation: "update", old: { version: "1.0.0", digest: expect.stringMatching(/^sha256:/) }, new: { version: "2.0.0", digest: expect.stringMatching(/^sha256:/) } });
    expect(readFileSync(path.join(root, ".scwbs/packs/org.example.secure-node/1.0.0/guidance/common.md"), "utf8")).toBe("v1\n");
    expect(readFileSync(path.join(root, ".scwbs/packs/org.example.secure-node/2.0.0/guidance/common.md"), "utf8")).toBe("v2\n");
    expect(JSON.parse(readFileSync(path.join(root, ".scwbs/packs.lock.json"), "utf8"))).toMatchObject({ packs: [{ version: "2.0.0", source: "fixture" }] });
  });

  test("applies digest-only updates when the installed file is still managed", () => {
    const root = makeTempRepo();
    writeText(root, "fixture/pack.yaml", packYaml());
    writeText(root, "fixture/guidance/common.md", "before\n");
    installPack(root, "fixture", { pin: true });
    writeText(root, "fixture/guidance/common.md", "after\n");

    const result = updatePack(root, "org.example.secure-node");
    expect(result).toMatchObject({ operation: "update", old: { version: "1.2.0" }, new: { version: "1.2.0" }, decisions: [{ action: "update" }] });
    expect(readFileSync(path.join(root, ".scwbs/packs/org.example.secure-node/1.2.0/guidance/common.md"), "utf8")).toBe("after\n");
  });

  test("rejects an update source whose Pack ID differs", () => {
    const root = makeTempRepo();
    writeText(root, "fixture/pack.yaml", packYaml());
    writeText(root, "fixture/guidance/common.md", "installed\n");
    installPack(root, "fixture", { pin: true });
    const beforeLock = readFileSync(path.join(root, ".scwbs/packs.lock.json"), "utf8");
    writeText(root, "fixture/pack.yaml", packYaml().replace("org.example.secure-node", "org.example.other"));

    expect(() => updatePack(root, "org.example.secure-node")).toThrow("Pack update source ID mismatch");
    expect(readFileSync(path.join(root, ".scwbs/packs.lock.json"), "utf8")).toBe(beforeLock);
    expect(readFileSync(path.join(root, ".scwbs/packs/org.example.secure-node/1.2.0/guidance/common.md"), "utf8")).toBe("installed\n");
  });

  test("keeps policy downgrade rejection on update", () => {
    const root = makeTempRepo();
    writeText(root, "fixture/pack.yaml", packYaml());
    writeText(root, "fixture/guidance/common.md", "installed\n");
    installPack(root, "fixture", { pin: true });
    writeText(root, "fixture/pack.yaml", packYaml("", "2.0.0").replace("security:\n  allowExecutableCode", "  removeRequiredChecks:\n    - security\nsecurity:\n  allowExecutableCode"));

    expect(() => updatePack(root, "org.example.secure-node")).toThrow("Pack policy downgrade rejected");
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

  test("does not partially apply an update when a later target path is unsafe", () => {
    const root = makeTempRepo();
    writeText(root, "fixture/pack.yaml", packYaml("", "1.0.0"));
    writeText(root, "fixture/guidance/common.md", "v1\n");
    installPack(root, "fixture", { pin: true });
    writeText(root, "fixture/pack.yaml", `schemaVersion: scwbs.pack.v1
id: org.example.secure-node
version: 2.0.0
contents:
  files:
    - source: guidance/common.md
    - source: second.md
      target: nested/second.md
security:
  allowExecutableCode: false
`);
    writeText(root, "fixture/second.md", "second\n");
    const outside = path.join(path.dirname(root), "scwbs-pack-update-outside");
    mkdirSync(outside, { recursive: true });
    mkdirSync(path.join(root, ".scwbs/packs/org.example.secure-node/2.0.0"), { recursive: true });
    symlinkSync(outside, path.join(root, ".scwbs/packs/org.example.secure-node/2.0.0/nested"), "dir");
    const beforeLock = readFileSync(path.join(root, ".scwbs/packs.lock.json"), "utf8");

    expect(() => updatePack(root, "org.example.secure-node")).toThrow("symlink");
    expect(readFileSync(path.join(root, ".scwbs/packs.lock.json"), "utf8")).toBe(beforeLock);
    expect(existsSync(path.join(root, ".scwbs/packs/org.example.secure-node/2.0.0/guidance/common.md"))).toBe(false);
  });

  test("rolls back to an earlier version while keeping later files", () => {
    const root = makeTempRepo();
    writeText(root, "fixture/pack.yaml", packYaml("", "1.0.0"));
    writeText(root, "fixture/guidance/common.md", "v1\n");
    installPack(root, "fixture", { pin: true });
    writeText(root, "fixture/pack.yaml", packYaml("", "2.0.0"));
    writeText(root, "fixture/guidance/common.md", "v2\n");
    updatePack(root, "org.example.secure-node");
    writeText(root, "fixture/pack.yaml", packYaml("", "1.0.0"));
    writeText(root, "fixture/guidance/common.md", "v1\n");

    const result = updatePack(root, "org.example.secure-node");
    expect(result).toMatchObject({ operation: "update", old: { version: "2.0.0" }, new: { version: "1.0.0" } });
    expect(JSON.parse(readFileSync(path.join(root, ".scwbs/packs.lock.json"), "utf8"))).toMatchObject({ packs: [{ version: "1.0.0", source: "fixture" }] });
    expect(readFileSync(path.join(root, ".scwbs/packs/org.example.secure-node/2.0.0/guidance/common.md"), "utf8")).toBe("v2\n");
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
