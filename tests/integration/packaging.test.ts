import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cleanCheckoutPackagingTimeoutMs = 60_000;
const npmStyleSymlinkTimeoutMs = 30_000;

describe("npm bin entrypoint", () => {
  const symlinkTest = process.platform === "win32" ? it.skip : it;

  symlinkTest("packs a runnable CLI from a clean checkout", () => {
    const repository = process.cwd();
    const fixture = mkdtempSync(path.join(tmpdir(), "scwbs-pack-"));
    const packageRoot = path.join(fixture, "package");
    const consumer = path.join(fixture, "consumer");
    const archive = path.join(fixture, "repository.tar");
    mkdirSync(packageRoot);
    mkdirSync(consumer);

    execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, "HEAD"], {
      cwd: repository,
      stdio: "pipe"
    });
    execFileSync("tar", ["-xf", archive, "-C", packageRoot], { stdio: "pipe" });
    copyFileSync(path.join(repository, "package.json"), path.join(packageRoot, "package.json"));
    symlinkSync(path.join(repository, "node_modules"), path.join(packageRoot, "node_modules"), "dir");

    const packed = JSON.parse(execFileSync("npm", [
      "pack",
      "--json",
      "--pack-destination",
      fixture
    ], {
      cwd: packageRoot,
      encoding: "utf8"
    }))[0] as {
      filename: string;
      size: number;
      files: Array<{ path: string }>;
    };

    expect(packed.files.some((file) => file.path === "dist/cli.js")).toBe(true);
    expect(packed.files.length).toBeLessThan(100);
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
    expect(execution.stdout.trim()).toBe("0.1.0");
    expect(execution.stderr).toBe("");
  }, cleanCheckoutPackagingTimeoutMs);

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
  }, npmStyleSymlinkTimeoutMs);
});
