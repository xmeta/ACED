import { spawnSync } from "node:child_process";

export function changedFiles(root: string): string[] {
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

export function currentBranch(root: string): string | undefined {
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd: root,
    encoding: "utf8"
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

export function headCommit(root: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8"
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

export function commitExists(root: string, commit: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--verify", `${commit}^{commit}`], {
    cwd: root,
    encoding: "utf8"
  });
  return result.status === 0;
}
