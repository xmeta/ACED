#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const DEFAULT_REPOSITORY = "xmeta/ACED";
export const MAX_FETCH_ATTEMPTS = 12;
export const FETCH_RETRY_DELAY_MS = 2_000;

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function runJson(command, args, cwd) {
  return JSON.parse(run(command, args, cwd));
}

/** @param {{repository?: string, packageVersion: string}} options */
export function buildRemoteSmokePlan({ repository = DEFAULT_REPOSITORY, packageVersion }) {
  const tag = `v${packageVersion}`;
  const tarball = `scwbs-${packageVersion}.tgz`;
  return {
    tag,
    tarballUrl: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(tarball)}`,
    bootstrapUrl: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/scwbs-bootstrap.mjs`,
    commands: ["--version", "init", "doctor", "task preflight"]
  };
}

async function fetchBytes(url) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "scwbs-release-smoke" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < MAX_FETCH_ATTEMPTS) await delay(FETCH_RETRY_DELAY_MS);
    }
  }
  throw new Error(`failed to download ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function installConsumer({ root, packageVersion, plan, mode }) {
  run("npm", ["init", "-y"], root);
  if (mode === "direct") {
    run("npm", ["install", "--save-dev", "--ignore-scripts", "--no-audit", "--no-fund", plan.tarballUrl], root);
  } else {
    const bootstrapPath = path.join(root, "scwbs-bootstrap.mjs");
    writeFileSync(bootstrapPath, await fetchBytes(plan.bootstrapUrl));
    const bootstrap = runJson(process.execPath, [bootstrapPath, "install", "--save-dev", "--json"], root);
    assert.equal(bootstrap.status, "pass", `bootstrap failed: ${JSON.stringify(bootstrap)}`);
    assert.equal(bootstrap.artifactUrl, plan.tarballUrl);
    const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    assert.equal(packageJson.devDependencies?.scwbs, plan.tarballUrl);
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], root);
  }

  assert.equal(run("npx", ["--no-install", "scwbs", "--version"], root), packageVersion);
  run("npx", ["--no-install", "scwbs", "init", "--profile", "lean", "--agent", "codex", "--lang", "en"], root);
  run("npx", ["--no-install", "scwbs", "doctor"], root);
  const preflight = runJson(
    "npx",
    [
      "--no-install",
      "scwbs",
      "task",
      "preflight",
      "--title",
      "Improve a consumer-facing document",
      "--paths",
      "docs/example.md",
      "--profile",
      "lean",
      "--json"
    ],
    root
  );
  assert.equal(preflight.status, "pass", `consumer task preflight failed: ${JSON.stringify(preflight)}`);
}

/** @param {{repository?: string, packageVersion?: string}} [options] */
export async function runRemoteSmoke({ repository = DEFAULT_REPOSITORY, packageVersion } = {}) {
  const version = String(packageVersion ?? "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("packageVersion must be a stable semantic version");
  const plan = buildRemoteSmokePlan({ repository, packageVersion: version });
  const root = mkdtempSync(path.join(os.tmpdir(), "scwbs-remote-smoke-"));
  const direct = path.join(root, "direct-consumer");
  const bootstrap = path.join(root, "bootstrap-consumer");
  mkdirSync(direct);
  mkdirSync(bootstrap);
  await installConsumer({ root: direct, packageVersion: version, plan, mode: "direct" });
  await installConsumer({ root: bootstrap, packageVersion: version, plan, mode: "bootstrap" });
  console.log(`PASS remote distribution smoke ${plan.tag} (${root})`);
  return { status: "pass", packageVersion: version, tag: plan.tag, root };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const tag = process.env.SCWBS_RELEASE_TAG ?? "";
  const packageVersion = tag.replace(/^v/, "");
  await runRemoteSmoke({
    repository: process.env.SCWBS_RELEASE_REPOSITORY ?? DEFAULT_REPOSITORY,
    packageVersion
  });
}
