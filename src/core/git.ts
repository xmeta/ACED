import { spawnSync } from "node:child_process";

export function changedFiles(root: string): string[] {
  const result = spawnSync("git", ["diff", "--name-only", "HEAD"], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "git diff failed");
  }
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function commitExists(root: string, commit: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--verify", `${commit}^{commit}`], {
    cwd: root,
    encoding: "utf8"
  });
  return result.status === 0;
}

export function currentHead(root: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}
