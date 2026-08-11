import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../../src/cli.js";
import { makeTempRepo } from "../helpers.js";

function capture(root: string, args: string[]): { exitCode: number; stdout: string } {
  const output: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = ((...values: unknown[]) => output.push(`${values.join(" ")}\n`)) as typeof console.log;
  console.error = ((...values: unknown[]) => output.push(`${values.join(" ")}\n`)) as typeof console.error;
  try { return { exitCode: main(args, root), stdout: output.join("") }; }
  finally { console.log = originalLog; console.error = originalError; }
}

describe("pack CLI", () => {
  test("inspect/install/list/search/info/remove expose bounded JSON and no execution hook", () => {
    const root = makeTempRepo();
    mkdirSync(path.join(root, "fixture/guidance"), { recursive: true });
    writeFileSync(path.join(root, "fixture/pack.yaml"), `schemaVersion: scwbs.pack.v1\nid: org.example.cli\nversion: 1.0.0\ncontents:\n  files:\n    - source: guidance/common.md\nsecurity:\n  allowExecutableCode: false\n`, "utf8");
    writeFileSync(path.join(root, "fixture/guidance/common.md"), "safe\n", "utf8");
    expect(capture(root, ["pack", "inspect", "fixture", "--json"]).exitCode).toBe(0);
    expect(capture(root, ["pack", "install", "fixture", "--pin", "--json"]).exitCode).toBe(0);
    expect(JSON.parse(capture(root, ["pack", "list", "--json"]).stdout)).toMatchObject({ version: "scwbs.pack-list.v1", packs: [{ id: "org.example.cli" }] });
    expect(JSON.parse(capture(root, ["pack", "search", "cli", "--json"]).stdout)).toMatchObject({ version: "scwbs.pack-search.v1", trust: "discovery-only" });
    expect(capture(root, ["pack", "info", "org.example.cli", "--json"]).exitCode).toBe(0);
    const remove = capture(root, ["pack", "remove", "org.example.cli", "--dry-run", "--json"]);
    expect(remove.exitCode).toBe(0);
    expect(JSON.parse(remove.stdout)).toMatchObject({ version: "scwbs.pack-operation.v1", operation: "remove", dryRun: true });
  });
});
