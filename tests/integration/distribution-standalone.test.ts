import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("standalone distribution artifact", () => {
  it("installs and exercises the packed CLI without an ACED checkout or WJS submodule", () => {
    const output = execFileSync(process.execPath, ["scripts/distribution-smoke.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    expect(output).toContain("PASS standalone distribution smoke");
  }, 180_000);
});
