import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { branchDiffHash, dirtySubmodulePaths } from "./git.js";

const dependencyLockfiles = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb"
];

function gitOutput(root: string, args: string[], encoding: "buffer" | "utf8" = "buffer"): Buffer | string {
  const result = spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd: root, encoding });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function untrackedFingerprint(root: string, excludedFiles: Set<string>): string {
  const output = gitOutput(root, ["ls-files", "--others", "--exclude-standard"], "utf8") as string;
  const hash = createHash("sha256");
  for (const relativePath of output.split(/\r?\n/).filter(Boolean).sort()) {
    if (excludedFiles.has(relativePath)) continue;
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(path.join(root, relativePath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function lockfileFingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const relativePath of dependencyLockfiles) {
    hash.update(relativePath);
    hash.update("\0");
    const fullPath = path.join(root, relativePath);
    hash.update(existsSync(fullPath) ? readFileSync(fullPath) : "missing");
    hash.update("\0");
  }
  return hash.digest("hex");
}

export type CheckCacheSubject = {
  fingerprint: string;
  reusable: boolean;
};

export function buildCheckCacheSubject(root: string, options: {
  baseRef: string;
  excludedMetadataFiles: string[];
}): CheckCacheSubject {
  const excludedFiles = new Set(options.excludedMetadataFiles);
  const pathspecs = ["--", ".", ...options.excludedMetadataFiles.map((file) => `:(exclude)${file}`)];
  const workingTreeDiff = gitOutput(root, ["diff", "--binary", "--no-ext-diff", "HEAD", ...pathspecs]) as Buffer;
  const submodules = gitOutput(root, ["submodule", "status", "--recursive"], "utf8") as string;
  const hash = createHash("sha256");
  hash.update("scwbs-check-cache-subject-v1\0");
  hash.update(branchDiffHash(root, options.baseRef, options.excludedMetadataFiles));
  hash.update("\0");
  hash.update(lockfileFingerprint(root));
  hash.update("\0");
  hash.update(submodules);
  hash.update("\0");
  hash.update(workingTreeDiff);
  hash.update("\0");
  hash.update(untrackedFingerprint(root, excludedFiles));
  return {
    fingerprint: `sha256:${hash.digest("hex")}`,
    reusable: dirtySubmodulePaths(root).length === 0
  };
}

export function buildCheckCacheKey(subject: CheckCacheSubject, check: string, command: string[]): string {
  const hash = createHash("sha256");
  hash.update("scwbs-check-cache-key-v1\0");
  hash.update(subject.fingerprint);
  hash.update("\0");
  hash.update(check);
  hash.update("\0");
  hash.update(JSON.stringify(command));
  return `sha256:${hash.digest("hex")}`;
}
