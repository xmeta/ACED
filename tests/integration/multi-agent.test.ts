import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../../src/cli.js";
import { makeTempRepo } from "../helpers.js";

function capture(root: string, args: string[]): { exitCode: number; stdout: string } {
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  console.log = ((...args: unknown[]) => output.push(`${args.join(" ")}\n`)) as typeof console.log;
  try {
    return { exitCode: main(args, root), stdout: output.join("") };
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
  }
}

describe("multi-agent consumer lifecycle", () => {
  test("install, add, dry-run update, primary change, and remove converge idempotently", () => {
    const root = makeTempRepo();
    expect(capture(root, ["init", "--agent", "codex"]).exitCode).toBe(0);
    expect(capture(root, ["agent", "add", "claude"]).exitCode).toBe(0);
    const dryRun = capture(root, ["update", "--dry-run", "--json"]);
    expect(dryRun.exitCode).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({ version: "scwbs.agent-operation.v1" });
    expect(capture(root, ["agent", "set-primary", "claude"]).exitCode).toBe(0);
    expect(capture(root, ["update"]).exitCode).toBe(0);
    expect(capture(root, ["agent", "remove", "codex"]).exitCode).toBe(0);
    const manifest = JSON.parse(readFileSync(path.join(root, ".scwbs/agent-files.json"), "utf8")) as {
      schemaVersion: string;
      primaryAgent: string;
      agents: string[];
    };
    expect(manifest).toMatchObject({ schemaVersion: "2", primaryAgent: "claude", agents: ["claude"] });
  });
});
