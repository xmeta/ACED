import { spawnSync } from "node:child_process";

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
  const tracked = spawnSync("git", ["-c", "core.quotePath=false", "diff", "--name-only", "HEAD"], {
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
