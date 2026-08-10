#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

  runScwbs(bin, ["init", "--profile", "lean", "--agent", "codex", "--lang", "en"], consumer);
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
