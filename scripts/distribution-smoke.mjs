#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function runScwbs(bin, args, cwd) {
  return run(bin, args, cwd).trim();
}

export function runDistributionSmoke(repository = process.cwd()) {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "scwbs-distribution-"));
  const consumer = path.join(fixture, "consumer");
  mkdirSync(consumer);

  const packageJson = JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8"));
  const quickstartCommands = JSON.parse(readFileSync(path.join(repository, "docs/scwbs/quickstart-commands.json"), "utf8"));
  assert.equal(quickstartCommands.schemaVersion, "1.0.0");
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", fixture], repository))[0];
  const packedPaths = new Set(packed.files.map((file) => file.path));
  for (const required of [
    "dist/cli.js",
    "dist/wjs-runtime/tools/validate.mjs",
    "dist/wjs-runtime/tools/apply.mjs",
    "dist/wjs-runtime/schema/wbs-json.schema.json",
    "dist/wjs-runtime/schema/wbs-operations.schema.json"
  ]) {
    assert(packedPaths.has(required), `packed artifact is missing ${required}`);
  }

  const tarball = path.join(fixture, packed.filename);
  run("npm", ["init", "-y"], consumer);
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumer);
  const bin = path.join(consumer, "node_modules", ".bin", "scwbs");
  assert(existsSync(bin), "installed scwbs bin is missing");
  assert.equal(runScwbs(bin, ["--version"], consumer), packageJson.version);

  const tarballDigest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  const currentManifest = path.join(fixture, "release-manifest.json");
  writeFileSync(currentManifest, `${JSON.stringify({
    schemaVersion: "1.0.0",
    packageVersion: packageJson.version,
    tag: `v${packageJson.version}`,
    commit: run("git", ["rev-parse", "HEAD"], repository).trim(),
    tarball: packed.filename,
    sha256: tarballDigest,
    validation: { workflow: ".github/workflows/scwbs.yml", workflowRunId: 1, checks: [] }
  }, null, 2)}\n`, "utf8");
  const versionCheck = JSON.parse(runScwbs(bin, ["version", "check", "--manifest", currentManifest, "--artifact", tarball, "--json"], consumer));
  assert.equal(versionCheck.status, "pass", `version check failed: ${JSON.stringify(versionCheck)}`);
  assert.equal(versionCheck.support, "current");

  const nextManifest = path.join(fixture, "next-release-manifest.json");
  writeFileSync(nextManifest, `${JSON.stringify({
    schemaVersion: "1.0.0",
    packageVersion: "0.1.1",
    tag: "v0.1.1",
    commit: "0123456789abcdef0123456789abcdef01234567",
    tarball: "scwbs-0.1.1.tgz",
    sha256: "a".repeat(64),
    validation: { workflow: ".github/workflows/scwbs.yml", workflowRunId: 2, checks: [] }
  }, null, 2)}\n`, "utf8");
  const upgrade = JSON.parse(runScwbs(bin, ["upgrade", "--dry-run", "--manifest", nextManifest, "--json"], consumer));
  assert.equal(upgrade.status, "pass", `upgrade dry-run failed: ${JSON.stringify(upgrade)}`);
  assert.equal(upgrade.proposed.packageVersion, "0.1.1");
  const unattended = spawnSync(bin, ["upgrade", "--json"], { cwd: consumer, encoding: "utf8" });
  assert.equal(unattended.status, 2);
  assert.equal(JSON.parse(unattended.stdout).status, "blocked");

  for (const command of quickstartCommands.commands) {
    assert(["help", "run"].includes(command.mode), `quickstart command has an invalid mode: ${command.id}`);
    const output = runScwbs(bin, command.argv, consumer);
    assert(output.length > 0, `quickstart command produced no output: ${command.id}`);
    if (command.expectJson) {
      assert.doesNotThrow(() => JSON.parse(output), `quickstart command returned invalid JSON: ${command.id}`);
    }
    for (const expected of command.expectContains ?? []) {
      assert(output.includes(expected), `quickstart command ${command.id} omitted ${expected}`);
    }
  }
  const doctor = JSON.parse(runScwbs(bin, ["doctor", "--json"], consumer));
  assert.equal(doctor.status, "pass", `standalone doctor failed: ${JSON.stringify(doctor)}`);
  runScwbs(bin, ["check"], consumer);
  runScwbs(bin, ["wbs", "validate"], consumer);

  const changeSetPath = path.join(consumer, "change-set.json");
  const appliedPath = path.join(consumer, "contracts", "wbs", "applied.json");
  writeFileSync(changeSetPath, `${JSON.stringify({
    schemaVersion: "0.1.0",
    targetWbsId: "scwbs-project",
    changeSetId: "distribution-smoke",
    author: "scwbs-distribution-smoke",
    reason: "Verify the bundled WJS apply runtime",
    operations: [{
      operationId: "distribution-smoke-status",
      operation: "changeNodeStatus",
      nodeId: "node-project",
      status: "ready"
    }]
  }, null, 2)}\n`, "utf8");
  runScwbs(bin, ["wbs", "apply", "change-set.json", "--force", "--output", "contracts/wbs/applied.json"], consumer);
  assert(existsSync(appliedPath), "standalone WJS apply did not write its output");
  assert.equal(JSON.parse(readFileSync(appliedPath, "utf8")).nodes[0].status, "ready");
  assert(!existsSync(path.join(consumer, "wjs")), "standalone consumer unexpectedly contains the wjs submodule");

  console.log(`PASS standalone distribution smoke (${packed.filename})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) runDistributionSmoke();
