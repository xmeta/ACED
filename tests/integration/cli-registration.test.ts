import { describe, expect, test } from "vitest";
import { main } from "../../src/cli.js";
import { makeTempRepo } from "../helpers.js";

function captureHelp(args: string[], root: string): { exitCode: number; stdout: string } {
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { exitCode: main(args, root), stdout: output.join("") };
  } finally {
    process.stdout.write = originalWrite;
  }
}

describe("domain CLI registration", () => {
  test("keeps every extracted top-level command visible", () => {
    const output = captureHelp(["--help"], makeTempRepo());
    expect(output.exitCode).toBe(0);
    for (const command of [
      "discovery",
      "ai",
      "approval",
      "completion",
      "evidence",
      "spec-change",
      "registry",
      "profile",
      "review",
      "lite",
      "task",
      "wbs"
    ]) {
      expect(output.stdout).toMatch(new RegExp(`\\n  ${command}(?: \\S+)?\\s`));
    }
  });

  test("preserves discovery and governance subcommands and options", () => {
    const root = makeTempRepo();
    expect(captureHelp(["discovery", "--help"], root).stdout).toContain("new [options]");
    expect(captureHelp(["update", "--help"], root).stdout).toContain("--agent <agent>");
    expect(captureHelp(["discovery", "--help"], root).stdout).toContain("conclude [options]");
    expect(captureHelp(["approval", "approve", "--help"], root).stdout).toContain("--scope <scope>");
    expect(captureHelp(["spec-change", "new", "--help"], root).stdout).toContain("--proposed-version <version>");
    expect(captureHelp(["evidence", "collect", "--help"], root).stdout).toContain("--output <target>");
    expect(captureHelp(["evidence", "import-ci", "--help"], root).stdout).toContain("--readiness <path>");
    expect(captureHelp(["review", "request", "--help"], root).stdout).toContain("--json");
  });

  test("preserves task and WBS subcommands and options", () => {
    const root = makeTempRepo();
    expect(captureHelp(["task", "new", "--help"], root).stdout).toContain("--no-stop-conditions");
    expect(captureHelp(["task", "index", "rebuild", "--help"], root).stdout).toContain("--force");
    expect(captureHelp(["wbs", "verify-changesets", "--help"], root).stdout).toContain("--changeset <path>");
    expect(captureHelp(["wbs", "apply", "--help"], root).stdout).toContain("-o <file>");
  });

  test("rejects unexpected positional arguments for strict commands", () => {
    const root = makeTempRepo();
    for (const command of ["status", "health", "finish"]) {
      expect(captureHelp([command, "unexpected"], root).exitCode, command).not.toBe(0);
    }
  });

  test("documents intended variadic arguments", () => {
    const root = makeTempRepo();
    expect(captureHelp(["block", "--help"], root).stdout).toContain("[reason...]");
    expect(captureHelp(["task", "new", "--help"], root).stdout).toContain("[title...]");
    expect(captureHelp(["lite", "task", "--help"], root).stdout).toContain("[title...]");
    expect(captureHelp(["approval", "request", "--help"], root).stdout).toContain("[note...]");
  });
});
