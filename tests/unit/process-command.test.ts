import { describe, expect, it } from "vitest";
import { resolveSpawnCommand } from "../../src/commands/checks-run.js";

describe("resolveSpawnCommand", () => {
  it("uses directly executable Windows entry points without changing arguments", () => {
    const branchName = "feature&echo injected";
    expect(resolveSpawnCommand(["gh", "pr", "list", "--head", branchName], "win32")).toEqual([
      "gh.exe",
      "pr",
      "list",
      "--head",
      branchName
    ]);
    expect(resolveSpawnCommand(["npm", "run", "test&echo injected"], "win32")).toEqual([
      "npm.cmd",
      "run",
      "test&echo injected"
    ]);
  });

  it("keeps POSIX commands unchanged", () => {
    const command = ["npm", "run", "test&echo injected"];
    expect(resolveSpawnCommand(command, "linux")).toEqual(command);
    expect(command).toEqual(["npm", "run", "test&echo injected"]);
  });
});
