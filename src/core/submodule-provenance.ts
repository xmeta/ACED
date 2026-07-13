import { spawnSync } from "node:child_process";
import type { Evidence, TaskContract } from "./types.js";
import { mergeBase, resolveCommit } from "./git.js";

const zeroCommit = "0".repeat(40);

function git(root: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function repositoryFor(root: string, submodulePath: string): string {
  const paths = git(root, ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]) ?? "";
  const key = paths.split(/\r?\n/).find((line) => line.endsWith(` ${submodulePath}`))?.split(/\s+/, 1)[0];
  const name = key?.slice("submodule.".length, -".path".length);
  return (name ? git(root, ["config", "-f", ".gitmodules", "--get", `submodule.${name}.url`]) : undefined) ?? "unknown";
}

function submoduleGit(root: string, submodulePath: string, args: string[]): string | undefined {
  return git(root, ["-C", submodulePath, ...args])
    ?? git(root, [`--git-dir=.git/modules/${submodulePath}`, ...args]);
}

function nestedChangedFiles(root: string, submodulePath: string, baseCommit: string, headCommit: string): string[] {
  const args = baseCommit === zeroCommit
    ? ["ls-tree", "-r", "--name-only", headCommit]
    : headCommit === zeroCommit
      ? ["ls-tree", "-r", "--name-only", baseCommit]
      : ["diff", "--name-only", `${baseCommit}..${headCommit}`];
  const output = submoduleGit(root, submodulePath, args);
  if (output === undefined) throw new Error(`Unable to collect nested changed files for submodule ${submodulePath} (${baseCommit} -> ${headCommit}); initialize the submodule and fetch both commits`);
  return output.split(/\r?\n/).filter(Boolean);
}

function upstreamTarget(root: string, submodulePath: string, configured?: string): string {
  if (configured) return configured;
  for (const candidate of ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master"]) {
    if (submoduleGit(root, submodulePath, ["rev-parse", "--verify", candidate]) !== undefined) return candidate;
  }
  return "refs/remotes/origin/HEAD";
}

function reachableFromUpstreamTarget(root: string, submodulePath: string, headCommit: string, upstreamRef: string): boolean {
  if (headCommit === zeroCommit) return true;
  const result = spawnSync("git", ["-C", submodulePath, "merge-base", "--is-ancestor", headCommit, upstreamRef], { cwd: root, encoding: "utf8" });
  return result.status === 0;
}

export function collectSubmoduleProvenance(root: string, baseRef: string, task: TaskContract): NonNullable<Evidence["submodules"]> {
  const baseCommit = mergeBase(root, baseRef) ?? resolveCommit(root, baseRef);
  if (!baseCommit) return [];
  const raw = git(root, ["diff", "--raw", "--no-abbrev", `${baseCommit}..HEAD`]) ?? "";
  const configs = new Map((task.submoduleDependencies ?? []).map((item) => [item.path, item]));
  return raw.split(/\r?\n/).flatMap((line) => {
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) [A-Z][0-9]*\t(.+)$/.exec(line);
    if (!match || (match[1] !== "160000" && match[2] !== "160000")) return [];
    const submodulePath = match[5]!;
    const config = configs.get(submodulePath);
    const oldCommit = match[3]!;
    const newCommit = match[4]!;
    const upstreamRef = upstreamTarget(root, submodulePath, config?.upstreamRef);
    return [{
      path: submodulePath,
      repository: config?.repository ?? repositoryFor(root, submodulePath),
      baseCommit: oldCommit,
      headCommit: newCommit,
      changedFiles: nestedChangedFiles(root, submodulePath, oldCommit, newCommit),
      ...(config?.pullRequest ? { pullRequest: config.pullRequest } : {}),
      upstreamRef,
      upstreamReachable: reachableFromUpstreamTarget(root, submodulePath, newCommit, upstreamRef),
      ...(config?.checks ? { checks: config.checks } : {})
    }];
  });
}
