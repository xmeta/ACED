import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { main } from "../../src/cli.js";
import { makeTempRepo, writeScwbsProject } from "../helpers.js";

function captureError(action: () => number): { result: number; stderr: string } {
  const stderr: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  });
  try {
    return { result: action(), stderr: stderr.join("\n") };
  } finally {
    spy.mockRestore();
  }
}

describe("Task ID security boundary", () => {
  test.each([
    ["packet", ["packet", "--task", "../outside"]],
    ["block", ["block", "poc", "--task", "../outside"]],
    ["approval", ["approval", "request", "--task", String.raw`..\..\outside`]],
    ["review", ["review", "request", "--task", "/tmp/outside"]],
    ["evidence", ["evidence", "collect", "--task=%2e%2e%2foutside", "--force"]]
  ])("%s rejects an unsafe --task before any read or write", (_name, args) => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const outside = path.resolve(root, "../outside.yaml");

    const result = captureError(() => main(args, root));

    expect(result.result).toBe(2);
    expect(result.stderr).toBe("ERROR task.id.invalid: Invalid task id");
    expect(existsSync(outside)).toBe(false);
  });

  test("JSON commands return the same bounded diagnostic and exit code", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    const result = captureError(() => main([
      "check-diff",
      "--task",
      "../../outside",
      "--json"
    ], root));

    expect(result.result).toBe(2);
    expect(JSON.parse(result.stderr)).toEqual({
      version: "scwbs.error.v1",
      status: "error",
      code: "task.id.invalid",
      message: "Invalid task id"
    });
  });
});
