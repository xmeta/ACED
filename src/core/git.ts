import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

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

export function workingTreeChangedFiles(root: string): string[] {
  const tracked = spawnSync("git", ["-c", "core.quotePath=false", "diff", "--ignore-submodules=dirty", "--name-only", "HEAD"], {
    cwd: root,
    encoding: "utf8"
  });
  if (tracked.status !== 0) {
    throw new Error(tracked.stderr || "git diff failed");
  }
  const untracked = spawnSync("git", ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8"
  });
  if (untracked.status !== 0) {
    throw new Error(untracked.stderr || "git ls-files failed");
  }
  return Array.from(new Set(`${tracked.stdout}\n${untracked.stdout}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)));
}

export function branchChangedFiles(root: string, baseRef = "origin/main"): string[] {
  return gitLines(root, ["diff", "--name-only", `${baseRef}...HEAD`], "git diff failed");
}

export function branchDiffHash(root: string, baseRef = "origin/main", excludeFiles: string[] = []): string {
  const pathspecs = excludeFiles.length > 0
    ? ["--", ".", ...excludeFiles.map((file) => `:(exclude)${file}`)]
    : [];
  const result = spawnSync("git", ["diff", "--binary", "--no-ext-diff", `${baseRef}...HEAD`, ...pathspecs], {
    cwd: root,
    encoding: "buffer"
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString("utf8") || "git diff failed");
  }
  const hash = createHash("sha256");
  hash.update(result.stdout);
  return `sha256:${hash.digest("hex")}`;
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

export function mergeBase(root: string, baseRef: string, headRef = "HEAD"): string | undefined {
  const result = spawnSync("git", ["merge-base", baseRef, headRef], {
    cwd: root,
    encoding: "utf8"
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function gitObject(root: string, ref: string, file: string): string | undefined {
  const result = spawnSync("git", ["show", `${ref}:${file}`], {
    cwd: root,
    encoding: "utf8"
  });
  return result.status === 0 ? result.stdout : undefined;
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

export function commitExists(root: string, commit: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--verify", `${commit}^{commit}`], {
    cwd: root,
    encoding: "utf8"
  });
  return result.status === 0;
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
