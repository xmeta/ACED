import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { taskLifecycleMetadataPaths } from "./managed-contract-paths.js";
import { evidencePayloadPath, resolveFrom } from "./paths.js";
import type { Evidence } from "./types.js";

const TEXT_FILE_PATTERN = /\.(cjs|js|json|md|ts|tsx|yaml|yml)$/;

function gitLines(root: string, args: string[], errorMessage: string): string[] {
  const result = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || errorMessage);
  }
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export type WorkingTreeState = {
  staged: string[];
  unstaged: string[];
  untracked: string[];
  submodules: string[];
  changedFiles: string[];
};

function normalizeGitPath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function workingTreeState(root: string, excludedFiles: string[] = []): WorkingTreeState {
  const excluded = new Set(excludedFiles.map(normalizeGitPath));
  const include = (file: string) => !excluded.has(normalizeGitPath(file));
  const staged = gitLines(
    root,
    ["diff", "--cached", "--name-only", "--ignore-submodules=dirty", "HEAD"],
    "git diff --cached failed"
  ).filter(include);
  const unstaged = gitLines(
    root,
    ["diff", "--name-only", "--ignore-submodules=dirty"],
    "git diff failed"
  ).filter(include);
  const untracked = gitLines(
    root,
    ["ls-files", "--others", "--exclude-standard"],
    "git ls-files failed"
  ).filter(include);
  const submodules = dirtySubmodulePaths(root).filter(include);
  return {
    staged,
    unstaged,
    untracked,
    submodules,
    changedFiles: Array.from(new Set([...staged, ...unstaged, ...untracked, ...submodules]))
  };
}

export function workingTreeChangedFiles(root: string): string[] {
  return workingTreeState(root).changedFiles;
}

export function branchChangedFiles(root: string, baseRef = "origin/main"): string[] {
  return gitLines(root, ["diff", "--name-only", `${baseRef}...HEAD`], "git diff failed");
}

function diffPathspecs(excludeFiles: string[]): string[] {
  return excludeFiles.length > 0
    ? ["--", ".", ...excludeFiles.map((file) => `:(exclude)${file}`)]
    : [];
}

export function diffBinary(root: string, fromRef: string, toRef: string, excludeFiles: string[] = []): Buffer {
  const result = spawnSync(
    "git",
    [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      fromRef,
      toRef,
      ...diffPathspecs(excludeFiles)
    ],
    { cwd: root, encoding: "buffer" }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString("utf8") || "git diff failed");
  }
  return result.stdout;
}

export function changedFilesBetweenRefs(root: string, fromRef: string, toRef: string, excludeFiles: string[] = []): string[] {
  return gitLines(
    root,
    ["diff", "--name-only", fromRef, toRef, ...diffPathspecs(excludeFiles)],
    "git diff failed"
  );
}

export function branchDiffBinary(root: string, baseRef = "origin/main", excludeFiles: string[] = []): Buffer {
  const result = spawnSync(
    "git",
    [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      `${baseRef}...HEAD`,
      ...diffPathspecs(excludeFiles)
    ],
    { cwd: root, encoding: "buffer" }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString("utf8") || "git diff failed");
  }
  return result.stdout;
}

export function hashDiffBinary(bytes: Buffer): string {
  const hash = createHash("sha256");
  hash.update(bytes);
  return `sha256:${hash.digest("hex")}`;
}

export function branchDiffHash(root: string, baseRef = "origin/main", excludeFiles: string[] = []): string {
  return hashDiffBinary(branchDiffBinary(root, baseRef, excludeFiles));
}

export function changedFilesSince(root: string, ref: string): string[] {
  return gitLines(root, ["diff", "--name-only", `${ref}..HEAD`], "git diff failed");
}

export function changedFilesBetween(root: string, fromRef: string, toRef: string): string[] {
  return Array.from(new Set(gitLines(root, ["log", "--format=", "--name-only", `${fromRef}..${toRef}`], "git log failed")));
}

export function isCommitAncestor(root: string, ancestorRef: string, descendantRef: string): boolean {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestorRef, descendantRef], {
    cwd: root,
    encoding: "utf8"
  });
  return result.status === 0;
}

export function resolveCommit(root: string, ref: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: root,
    encoding: "utf8"
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

export function commitTreeHash(root: string, commit: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--verify", `${commit}^{tree}`], {
    cwd: root,
    encoding: "utf8"
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

export function mergeBase(root: string, baseRef: string, headRef = "HEAD"): string | undefined {
  const result = spawnSync("git", ["merge-base", baseRef, headRef], {
    cwd: root,
    encoding: "utf8"
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

export function gitObject(root: string, ref: string, file: string): string | undefined {
  const result = spawnSync("git", ["show", `${ref}:${file}`], {
    cwd: root,
    encoding: "utf8"
  });
  return result.status === 0 ? result.stdout : undefined;
}

export function fileIntroductionCommit(root: string, baseRef: string, headRef: string, file: string): string | undefined {
  const commits = gitLines(root, ["log", "--reverse", "--diff-filter=A", "--format=%H", `${baseRef}..${headRef}`, "--", file], "git log failed");
  return commits[0];
}

export function commitChangedFiles(root: string, commit: string): string[] {
  return gitLines(root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", commit], "git diff-tree failed");
}

export function baseBranchStatus(root: string, baseRef = "origin/main"): { baseRef: string; baseCommit?: string; mergeBase?: string; headCommit?: string; isBehind: boolean } {
  const baseCommit = resolveCommit(root, baseRef);
  const currentHead = headCommit(root);
  const commonBase = baseCommit && currentHead ? mergeBase(root, baseRef, "HEAD") : undefined;
  return {
    baseRef,
    baseCommit,
    mergeBase: commonBase,
    headCommit: currentHead,
    isBehind: Boolean(baseCommit && commonBase && baseCommit !== commonBase)
  };
}

export function filesAddedOnBothSides(root: string, baseRef = "origin/main"): string[] {
  const commonBase = mergeBase(root, baseRef, "HEAD");
  if (!commonBase) return [];
  const addedInHead = gitLines(root, ["diff", "--name-only", "--diff-filter=A", `${commonBase}..HEAD`], "git diff failed");
  return addedInHead.filter((file) => {
    const baseContent = gitObject(root, baseRef, file);
    if (baseContent === undefined) return false;
    const commonBaseContent = gitObject(root, commonBase, file);
    if (commonBaseContent !== undefined) return false;
    const headContent = gitObject(root, "HEAD", file);
    return headContent !== baseContent;
  });
}

export function currentBranch(root: string): string | undefined {
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd: root,
    encoding: "utf8"
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

export function headCommit(root: string): string | undefined {
  return resolveCommit(root, "HEAD");
}

export function isShallowRepository(root: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
    cwd: root,
    encoding: "utf8"
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

export function commitExists(root: string, commit: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--verify", `${commit}^{commit}`], {
    cwd: root,
    encoding: "utf8"
  });
  return result.status === 0;
}

export type PatchArtifact = {
  relativePath: string;
  locator: string;
  bytes: Buffer;
  manifestHash: string;
  treeHash: string;
};

export type PatchVerification =
  | { status: "verified"; reconstructedTreeHash: string; changedFiles: string[] }
  | { status: "not-evaluated"; code: string; message: string }
  | { status: "unverifiable"; code: string; message: string };

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sortedPaths(values: string[]): string[] {
  return [...new Set(values.map((value) => value.replace(/\\/g, "/")))].sort();
}

function patchFailure(code: string, message: string): PatchVerification {
  return { status: "unverifiable", code, message };
}

function reconstructPatchTree(root: string, baseCommit: string, bytes: Buffer): string | undefined {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "scwbs-evidence-patch-"));
  const indexPath = path.join(temporaryDirectory, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    const readTree = spawnSync("git", ["read-tree", baseCommit], { cwd: root, env, encoding: "utf8" });
    if (readTree.status !== 0) return undefined;
    if (bytes.length > 0) {
      const apply = spawnSync(
        "git",
        ["apply", "--cached", "--binary", "--whitespace=nowarn", "--recount"],
        { cwd: root, env, input: bytes, encoding: "buffer" }
      );
      if (apply.status !== 0) return undefined;
    }
    const writeTree = spawnSync("git", ["write-tree"], { cwd: root, env, encoding: "utf8" });
    return writeTree.status === 0 ? writeTree.stdout.trim() || undefined : undefined;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function buildPatchArtifact(
  root: string,
  taskId: string,
  baseCommit: string,
  subjectCommit: string
): PatchArtifact {
  const relativePath = evidencePayloadPath(taskId);
  const bytes = diffBinary(root, baseCommit, subjectCommit, taskLifecycleMetadataPaths(taskId));
  const treeHash = reconstructPatchTree(root, baseCommit, bytes);
  if (!treeHash) throw new Error(`${taskId} canonical patch could not be applied to its base tree`);
  return {
    relativePath,
    locator: `repo:${relativePath}`,
    bytes,
    manifestHash: sha256(bytes),
    treeHash
  };
}

export function verifyPatchArtifact(
  root: string,
  taskId: string,
  evidence: Evidence,
  options: { shallow: boolean }
): PatchVerification {
  const provenance = evidence.provenance;
  if (!provenance || provenance.retention.mode !== "patch-artifact") {
    return patchFailure("mode", `${taskId} Evidence does not declare patch-artifact retention`);
  }
  const expectedRelativePath = evidencePayloadPath(taskId);
  const expectedLocator = `repo:${expectedRelativePath}`;
  if (provenance.retention.locator !== expectedLocator) {
    return patchFailure("locator", `${taskId} patch locator must be ${expectedLocator}`);
  }
  const fullPath = resolveFrom(root, expectedRelativePath);
  const relative = path.relative(path.resolve(root), fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return patchFailure("locator", `${taskId} patch locator escapes the repository`);
  }
  if (!existsSync(fullPath)) {
    return patchFailure("payload.missing", `${taskId} patch payload was not found: ${expectedRelativePath}`);
  }
  const bytes = readFileSync(fullPath);
  if (!provenance.retention.manifestHash) {
    return patchFailure("payload.manifestHash", `${taskId} patch payload has no manifestHash`);
  }
  if (sha256(bytes) !== provenance.retention.manifestHash) {
    return patchFailure("payload.hash", `${taskId} patch payload hash does not match Evidence`);
  }
  const baseCommit = evidence.git?.baseCommit;
  if (!baseCommit) return patchFailure("base.missing", `${taskId} patch Evidence has no git.baseCommit`);
  if (!commitExists(root, baseCommit)) {
    return options.shallow
      ? { status: "not-evaluated", code: "base.unavailable", message: `${taskId} patch baseCommit is unavailable in this shallow repository` }
      : patchFailure("base.unavailable", `${taskId} patch baseCommit was not found: ${baseCommit}`);
  }

  const reconstructedTreeHash = reconstructPatchTree(root, baseCommit, bytes);
  if (!reconstructedTreeHash) {
    return patchFailure("apply", `${taskId} patch payload could not be applied to its base tree`);
  }
  if (reconstructedTreeHash !== provenance.subject.treeHash) {
    return patchFailure("tree", `${taskId} reconstructed tree hash does not match Evidence`);
  }
  const metadataFiles = taskLifecycleMetadataPaths(taskId);
  const reconstructedDiff = diffBinary(root, baseCommit, reconstructedTreeHash, metadataFiles);
  if (hashDiffBinary(reconstructedDiff) !== provenance.subject.diffHash) {
    return patchFailure("diffHash", `${taskId} reconstructed implementation diffHash does not match Evidence`);
  }
  const changedFiles = changedFilesBetweenRefs(root, baseCommit, reconstructedTreeHash, metadataFiles);
  const expectedChangedFiles = evidence.changedFiles.filter((file) => !metadataFiles.includes(file.replace(/\\/g, "/")));
  if (JSON.stringify(sortedPaths(changedFiles)) !== JSON.stringify(sortedPaths(expectedChangedFiles))) {
    return patchFailure("changedFiles", `${taskId} reconstructed changed files do not match Evidence`);
  }
  return { status: "verified", reconstructedTreeHash, changedFiles: sortedPaths(changedFiles) };
}

export function trackedTextFiles(root: string): string[] {
  return gitLines(root, ["ls-files"], "git ls-files failed").filter((file) => TEXT_FILE_PATTERN.test(file));
}

export function filesWithCrlf(root: string): string[] {
  return trackedTextFiles(root).filter((file) => readFileSync(`${root}/${file}`, "utf8").includes("\r\n"));
}

function submoduleHasDirtyState(root: string, submodulePath: string): boolean {
  const status = spawnSync("git", ["-C", submodulePath, "status", "--short"], {
    cwd: root,
    encoding: "utf8"
  });
  const eol = spawnSync("git", ["-C", submodulePath, "ls-files", "--eol"], {
    cwd: root,
    encoding: "utf8"
  });
  return (status.status === 0 && status.stdout.trim().length > 0)
    || (eol.status === 0 && /\bw\/crlf\b/.test(eol.stdout));
}

export function dirtySubmodulePaths(root: string): string[] {
  const status = spawnSync("git", ["-c", "core.quotePath=false", "submodule", "status", "--recursive"], {
    cwd: root,
    encoding: "utf8"
  });
  if (status.status !== 0) return [];
  const paths = status.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1])
    .filter((path): path is string => Boolean(path));
  return paths.filter((submodulePath) => submoduleHasDirtyState(root, submodulePath));
}
