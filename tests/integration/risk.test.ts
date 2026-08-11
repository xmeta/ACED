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

describe("risk CLI", () => {
  test("supports bounded add/list/show/update JSON and rejects non-human acceptance", () => {
    const root = makeTempRepo();
    const added = capture(root, ["risk", "add", "--id", "RISK-CLI", "--title", "CLI risk", "--likelihood", "3", "--impact", "4", "--owner", "team", "--actions", "control", "--tasks", "TASK-001", "--json"]);
    expect(added.exitCode).toBe(0);
    expect(JSON.parse(added.stdout)).toMatchObject({ version: "scwbs.risk-operation.v1", risk: { id: "RISK-CLI", assessment: { score: 12, level: "high" } } });
    expect(capture(root, ["risk", "list", "--json"]).stdout).toContain("scwbs.risk-list.v1");
    expect(capture(root, ["risk", "show", "RISK-CLI", "--json"]).exitCode).toBe(0);
    const updated = capture(root, ["risk", "update", "RISK-CLI", "--actions", "verify", "--json"]);
    expect(updated.exitCode).toBe(0);
    const rejected = capture(root, ["risk", "accept", "RISK-CLI", "--actor", "ai-agent", "--reason", "anything", "--json"]);
    expect(rejected.exitCode).toBe(1);
    expect(JSON.parse(rejected.stdout)).toMatchObject({ version: "scwbs.risk-error.v1", status: "error" });
  });
});
