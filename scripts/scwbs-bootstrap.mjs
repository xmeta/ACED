#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const BOOTSTRAP_VERSION = "scwbs.bootstrap-install.v1";
export const DEFAULT_REPOSITORY = "xmeta/ACED";
export const RELEASE_MANIFEST_NAME = "release-manifest.json";
export const BOOTSTRAP_ASSET_NAME = "scwbs-bootstrap.mjs";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REASON_LENGTH = 512;
const RELEASE_WORKFLOW = ".github/workflows/scwbs.yml";
const REQUIRED_CHECKS = ["core", "integration", "wjs", "distribution", "validate"];

/** @typedef {{version: string, status: string, mode: string, repository: string, releaseTag: string|null, packageVersion: string|null, artifactUrl: string|null, mutation: {target: string, field: string, changed: boolean}, reasons: Array<{code: string, message: string}>}} BootstrapOutput */
/** @typedef {{exitCode: number, output: BootstrapOutput|null, json: boolean, help: boolean}} BootstrapResult */

export class BootstrapUsageError extends Error {
  constructor(message, json = false) {
    super(message);
    this.name = "BootstrapUsageError";
    this.json = json;
  }
}

function bounded(value) {
  return String(value).slice(0, MAX_REASON_LENGTH);
}

/** @returns {{code: string, message: string}} */
function reason(code, message) {
  return { code, message: bounded(message) };
}

function parseSemver(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value ?? "").trim());
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function assertRepository(repository) {
  if (!/^[^/]+\/[^/]+$/.test(repository)) throw new BootstrapUsageError("--repo must be owner/name");
  return repository;
}

function assertTag(tag) {
  if (!/^v\d+\.\d+\.\d+(?:[-+].*)?$/.test(tag)) throw new BootstrapUsageError("--tag must be v<major>.<minor>.<patch>");
  return tag;
}

export function parseBootstrapArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const options = {
    command,
    repository: DEFAULT_REPOSITORY,
    tag: null,
    manifestPath: null,
    artifactPath: null,
    dryRun: false,
    saveDev: false,
    json: false,
    help: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--save-dev") options.saveDev = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (["--repo", "--tag", "--manifest", "--artifact"].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new BootstrapUsageError(`${argument} requires a value`, options.json);
      if (argument === "--repo") options.repository = assertRepository(value);
      if (argument === "--tag") options.tag = assertTag(value);
      if (argument === "--manifest") options.manifestPath = value;
      if (argument === "--artifact") options.artifactPath = value;
    } else if (argument.startsWith("--repo=")) options.repository = assertRepository(argument.slice(7));
    else if (argument.startsWith("--tag=")) options.tag = assertTag(argument.slice(6));
    else if (argument.startsWith("--manifest=")) options.manifestPath = argument.slice(11);
    else if (argument.startsWith("--artifact=")) options.artifactPath = argument.slice(10);
    else throw new BootstrapUsageError(`unknown option '${argument}'`, options.json);
  }
  if (!options.command || options.command === "help" || options.help) {
    options.help = true;
    return options;
  }
  if (options.command !== "install") throw new BootstrapUsageError(`unknown command '${options.command}'`, options.json);
  if (!options.dryRun && !options.saveDev) throw new BootstrapUsageError("install requires --save-dev or --dry-run", options.json);
  if (options.dryRun && options.saveDev) throw new BootstrapUsageError("--dry-run and --save-dev cannot be combined", options.json);
  return options;
}

/** @param {unknown} manifest @param {string|null} [expectedTag] */
export function validateBootstrapManifest(manifest, expectedTag = null) {
  /** @type {Record<string, any>} */
  const value = manifest && typeof manifest === "object" ? manifest : {};
  const packageVersion = typeof value.packageVersion === "string" ? value.packageVersion : "";
  const tag = typeof value.tag === "string" ? value.tag : "";
  const tarball = typeof value.tarball === "string" ? value.tarball : "";
  const digest = typeof value.sha256 === "string" ? value.sha256 : "";
  const commit = typeof value.commit === "string" ? value.commit : "";
  const validation = value.validation && typeof value.validation === "object" ? value.validation : {};
  const checks = Array.isArray(validation.checks) ? validation.checks : [];
  const reasons = [];
  if (value.schemaVersion !== "1.0.0") reasons.push(reason("bootstrap.manifest.schema", "release manifest schemaVersion must be 1.0.0"));
  if (!parseSemver(packageVersion)) reasons.push(reason("bootstrap.version.invalid", "release manifest packageVersion must be semantic version"));
  if (tag !== `v${packageVersion}`) reasons.push(reason("bootstrap.subject.tag-mismatch", "release tag must equal v<packageVersion>"));
  if (expectedTag && tag !== expectedTag) reasons.push(reason("bootstrap.subject.requested-tag-mismatch", "requested release tag does not match the manifest"));
  if (tarball !== `scwbs-${packageVersion}.tgz`) reasons.push(reason("bootstrap.subject.tarball-mismatch", "tarball filename must bind to packageVersion"));
  if (!/^[0-9a-f]{64}$/.test(digest)) reasons.push(reason("bootstrap.digest.invalid", "release manifest sha256 must be a 64 character lowercase hex digest"));
  if (!/^[0-9a-f]{7,64}$/.test(commit)) reasons.push(reason("bootstrap.subject.commit-missing", "release manifest commit must be a commit SHA"));
  if (validation.workflow !== RELEASE_WORKFLOW) reasons.push(reason("bootstrap.validation.workflow-mismatch", "release manifest validation workflow is not the trusted SC-WBS workflow"));
  if (!Number.isInteger(validation.workflowRunId) || validation.workflowRunId <= 0) reasons.push(reason("bootstrap.validation.run-missing", "release manifest is missing a trusted validation workflow run id"));
  for (const required of REQUIRED_CHECKS) {
    if (!checks.some((check) => check?.name === required && check?.conclusion === "success")) reasons.push(reason("bootstrap.validation.check-missing", `release manifest is missing passed check ${required}`));
  }
  return {
    status: reasons.length === 0 ? "pass" : "fail",
    packageVersion,
    tag,
    tarball,
    digest,
    commit,
    reasons
  };
}

function releaseUrl(repository, tag, asset) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
}

function apiUrl(repository, tag) {
  return tag
    ? `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`
    : `https://api.github.com/repos/${repository}/releases/latest`;
}

async function responseBytes(response) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const length = Number(response.headers?.get?.("content-length") ?? 0);
  if (length > MAX_RESPONSE_BYTES) throw new Error("response exceeds the bootstrap size limit");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("response exceeds the bootstrap size limit");
  return bytes;
}

async function fetchBytes(fetchImpl, url, accept) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(url, {
      headers: { accept, "user-agent": "scwbs-bootstrap" },
      signal: controller.signal
    });
    return await responseBytes(response);
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonBytes(bytes) {
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readLocalJson(filePath) {
  return JSON.parse(readFileSync(path.resolve(filePath), "utf8"));
}

function readPackageJson(cwd) {
  const packagePath = path.join(cwd, "package.json");
  return { packagePath, source: readFileSync(packagePath, "utf8"), value: JSON.parse(readFileSync(packagePath, "utf8")) };
}

function dependencyPlan(packageJson, artifactUrl) {
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) throw new Error("package.json must contain an object");
  const dependencies = packageJson.dependencies;
  if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies) && Object.hasOwn(dependencies, "scwbs")) {
    throw new Error("package.json already contains scwbs under dependencies; refusing to move it to devDependencies");
  }
  const devDependencies = packageJson.devDependencies && typeof packageJson.devDependencies === "object" && !Array.isArray(packageJson.devDependencies)
    ? { ...packageJson.devDependencies }
    : {};
  devDependencies.scwbs = artifactUrl;
  return { ...packageJson, devDependencies };
}

/** @returns {BootstrapOutput} */
function outputBase(options) {
  return {
    version: BOOTSTRAP_VERSION,
    status: "fail",
    mode: options.dryRun ? "dry-run" : "install",
    repository: options.repository,
    releaseTag: null,
    packageVersion: null,
    artifactUrl: null,
    mutation: { target: "package.json", field: "devDependencies.scwbs", changed: false },
    reasons: []
  };
}

/** @param {{argv?: string[], cwd?: string, fetchImpl?: typeof fetch}} [options] @returns {Promise<BootstrapResult>} */
export async function runBootstrap({ argv, cwd = process.cwd(), fetchImpl = fetch } = {}) {
  let options;
  try {
    options = parseBootstrapArgs(argv ?? []);
  } catch (error) {
    const json = error instanceof BootstrapUsageError && error.json;
    const fallback = { ...outputBase({ dryRun: false, repository: DEFAULT_REPOSITORY }), status: "blocked", reasons: [reason("bootstrap.usage", error instanceof Error ? error.message : String(error))] };
    return { exitCode: 2, output: fallback, json: Boolean(json), help: false };
  }
  if (options.help) return { exitCode: 0, output: null, json: options.json, help: true };
  const output = outputBase(options);
  try {
    let manifest;
    let releaseApi;
    if (options.manifestPath) manifest = readLocalJson(options.manifestPath);
    else {
      const apiBytes = await fetchBytes(fetchImpl, apiUrl(options.repository, options.tag), "application/vnd.github+json");
      releaseApi = parseJsonBytes(apiBytes);
      if (releaseApi.draft === true || releaseApi.prerelease === true) throw new Error("release is not a stable published release");
      if (typeof releaseApi.tag_name !== "string") throw new Error("GitHub release is missing tag_name");
      if (options.tag && releaseApi.tag_name !== options.tag) throw new Error("GitHub release tag does not match the requested tag");
      manifest = parseJsonBytes(await fetchBytes(fetchImpl, releaseUrl(options.repository, releaseApi.tag_name, RELEASE_MANIFEST_NAME), "application/json"));
    }
    const integrity = validateBootstrapManifest(manifest, options.tag);
    if (integrity.status !== "pass") {
      output.releaseTag = integrity.tag || null;
      output.packageVersion = integrity.packageVersion || null;
      output.reasons = integrity.reasons;
      return { exitCode: 1, output, json: options.json, help: false };
    }
    const tag = integrity.tag;
    const artifactUrl = releaseUrl(options.repository, tag, integrity.tarball);
    let artifactBytes;
    if (options.artifactPath) artifactBytes = new Uint8Array(readFileSync(path.resolve(options.artifactPath)));
    else artifactBytes = await fetchBytes(fetchImpl, artifactUrl, "application/octet-stream");
    if (digestBytes(artifactBytes) !== integrity.digest) {
      output.releaseTag = tag;
      output.packageVersion = integrity.packageVersion;
      output.artifactUrl = artifactUrl;
      output.reasons = [reason("bootstrap.digest.mismatch", "downloaded tarball SHA-256 does not match release manifest")];
      return { exitCode: 1, output, json: options.json, help: false };
    }
    if (releaseApi?.tag_name && releaseApi.tag_name !== tag) throw new Error("GitHub release API tag does not match the manifest");
    output.releaseTag = tag;
    output.packageVersion = integrity.packageVersion;
    output.artifactUrl = artifactUrl;
    const packageFile = readPackageJson(cwd);
    const nextPackage = dependencyPlan(packageFile.value, artifactUrl);
    if (!options.dryRun) {
      writeFileSync(packageFile.packagePath, `${JSON.stringify(nextPackage, null, 2)}\n`, "utf8");
      output.mutation.changed = packageFile.source !== `${JSON.stringify(nextPackage, null, 2)}\n`;
    }
    output.status = "pass";
    output.reasons = [];
    return { exitCode: 0, output, json: options.json, help: false };
  } catch (error) {
    output.status = "unavailable";
    output.reasons = [reason("bootstrap.failed", error instanceof Error ? error.message : String(error))];
    return { exitCode: 1, output, json: options.json, help: false };
  }
}

function helpText() {
  return `Usage: node scwbs-bootstrap.mjs install --save-dev [options]\n\nOptions:\n  --dry-run             verify and propose without changing package.json\n  --save-dev            write an exact GitHub Release tarball URL to devDependencies.scwbs\n  --tag <tag>           use an explicit immutable release tag\n  --repo <owner/name>   GitHub repository (default: ${DEFAULT_REPOSITORY})\n  --manifest <path>     use a local release-manifest.json\n  --artifact <path>     use a local tarball for offline verification\n  --json                print scwbs.bootstrap-install.v1\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const result = await runBootstrap({ argv: process.argv.slice(2) });
  if (result.help) process.stdout.write(helpText());
  else if (result.output) process.stdout.write(result.json ? `${JSON.stringify(result.output)}\n` : `${result.output.status} ${result.output.mode}\n${result.output.reasons.map((item) => `${item.code}: ${item.message}`).join("\n")}${result.output.reasons.length > 0 ? "\n" : ""}`);
  process.exitCode = result.exitCode;
}
