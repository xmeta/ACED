import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("npm bin entrypoint", () => {
  const symlinkTest = process.platform === "win32" ? it.skip : it;

  symlinkTest("runs the CLI through an npm-style symlink", () => {
    execFileSync("npm", ["run", "build"], {
      cwd: process.cwd(),
      stdio: "pipe"
    });

    const consumer = mkdtempSync(path.join(tmpdir(), "scwbs-bin-"));
    const binDir = path.join(consumer, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, "scwbs");
    const cliPath = path.join(process.cwd(), "dist", "cli.js");

    symlinkSync(cliPath, binPath);

    const linked = spawnSync(process.execPath, [binPath, "--version"], {
      cwd: consumer,
      encoding: "utf8"
    });
    const direct = spawnSync(process.execPath, [cliPath, "--version"], {
      cwd: consumer,
      encoding: "utf8"
    });

    expect(linked.status).toBe(direct.status);
    expect(linked.stdout).toBe(direct.stdout);
    expect(linked.stderr).toBe(direct.stderr);
    expect(linked.stdout.trim()).toBe("0.1.0");
  });
});
