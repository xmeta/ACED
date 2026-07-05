import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { taskPath, resolveFrom } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import type { TaskContract } from "../core/types.js";

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 48) || "task";
}

function stamp(): string {
  return Date.now().toString(36).toUpperCase();
}

function splitList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : fallback;
}

export function buildCoreTaskNew(title: string, options: {
  paths?: string;
  forbid?: string;
  gate?: string;
  checks?: string;
} = {}): TaskContract {
  const id = `SCWBS-DRAFT-${stamp()}`;
  const safeTitle = slug(title);
  return {
    id,
    type: "task-contract",
    wbsNodeId: "node-governance-maintenance",
    featureId: `F-${id.replace(/^SCWBS-DRAFT-/, "")}`,
    branchName: `task/${id}-${safeTitle}`,
    allowedPaths: splitList(options.paths, ["src/**", "tests/**", "docs/**", "contracts/**"]),
    forbiddenPaths: splitList(options.forbid, ["wjs/**"]),
    humanGateRequiredPaths: splitList(options.gate, ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", ".github/**"]),
    requiredChecks: splitList(options.checks, ["test", "typecheck", "build"]),
    doneCriteria: [`Complete: ${title}`],
    evidenceRequired: ["test-result", "typecheck-result", "build-result"]
  };
}

export function runTaskNew(root: string, title: string, options: {
  paths?: string;
  forbid?: string;
  gate?: string;
  checks?: string;
} = {}): number {
  try {
    const task = buildCoreTaskNew(title, options);
    const relativePath = taskPath(task.id);
    const fullPath = resolveFrom(root, relativePath);
    if (existsSync(fullPath)) {
      console.error(`${relativePath} already exists`);
      return 1;
    }
    mkdirSync(path.dirname(fullPath), { recursive: true });
    const yaml = stringifySimpleYaml(task as unknown as Record<string, unknown>);
    writeFileSync(fullPath, yaml, "utf8");
    process.stdout.write(yaml);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
