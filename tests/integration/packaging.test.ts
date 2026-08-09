import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const standalonePackagingTimeoutMs = 60_000;
const npmStyleSymlinkTimeoutMs = 30_000;

describe("npm bin entrypoint", () => {
  const symlinkTest = process.platform === "win32" ? it.skip : it;

  symlinkTest("packs a runnable CLI without a repository checkout or WJS submodule", () => {
    const repository = process.cwd();
    const fixture = mkdtempSync(path.join(tmpdir(), "scwbs-pack-"));
    const consumer = path.join(fixture, "consumer");
    mkdirSync(consumer);

    execFileSync("npm", ["run", "build"], { cwd: repository, stdio: "pipe" });
    const packageJson = JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8")) as { version: string };

    const packed = JSON.parse(execFileSync("npm", [
      "pack",
      "--json",
      "--pack-destination",
      fixture
    ], {
      cwd: repository,
      encoding: "utf8"
    }))[0] as {
      filename: string;
      size: number;
      files: Array<{ path: string }>;
    };

    expect(packed.files.some((file) => file.path === "dist/cli.js")).toBe(true);
    expect(packed.files.length).toBeLessThan(120);
    expect(packed.size).toBeLessThan(200_000);

    const tarball = path.join(fixture, packed.filename);
    execFileSync("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball
    ], {
      cwd: consumer,
      stdio: "pipe"
    });

    const binPath = path.join(consumer, "node_modules", ".bin", "scwbs");
    expect(existsSync(binPath)).toBe(true);
    const execution = spawnSync(binPath, ["--version"], {
      cwd: consumer,
      encoding: "utf8"
    });
    expect(execution.status).toBe(0);
    expect(execution.stdout.trim()).toBe(packageJson.version);
    expect(execution.stderr).toBe("");
  }, standalonePackagingTimeoutMs);

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
    const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(linked.stdout.trim()).toBe(packageJson.version);
  }, npmStyleSymlinkTimeoutMs);
});
