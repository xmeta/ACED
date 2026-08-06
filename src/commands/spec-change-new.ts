import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readSpec, readTask } from "../core/contracts.js";
import { resolveFrom, specChangePath, specPath } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import type { SpecChangeProposal } from "../core/types.js";

export type SpecChangeNewOptions = {
  id?: string;
  spec: string;
  task: string;
  summary: string;
  rationale: string;
  proposedVersion: string;
  level?: string | number;
  affectedPaths?: string;
  risks?: string;
};

function splitItems(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function proposalId(taskId: string, id: string | undefined): string {
  return id ?? `SCP-${taskId}-${Date.now().toString(36).toUpperCase()}`;
}

export function runSpecChangeNew(root: string, options: SpecChangeNewOptions): number {
  try {
    const taskResult = readTask(root, options.task);
    if (!taskResult.task) throw new Error(taskResult.issues.map((issue) => issue.message).join("\n"));

    const specRelativePath = specPath(options.spec);
    const specResult = readSpec(root, specRelativePath);
    if (!specResult.spec) throw new Error(specResult.issues.map((issue) => issue.message).join("\n"));

    const level = Number(options.level ?? 1);
    if (![0, 1, 2].includes(level)) throw new Error("Invalid --level; expected 0, 1, or 2");

    const id = proposalId(taskResult.task.id, options.id);
    const relativePath = specChangePath(id);
    const fullPath = resolveFrom(root, relativePath);
    if (existsSync(fullPath)) throw new Error(`${relativePath} already exists`);

    const proposal: SpecChangeProposal = {
      id,
      type: "spec-change-proposal",
      status: "proposed",
      targetSpec: specResult.spec.id,
      currentVersion: specResult.spec.version,
      proposedVersion: options.proposedVersion,
      taskId: taskResult.task.id,
      level: level as SpecChangeProposal["level"],
      summary: options.summary,
      rationale: [options.rationale],
      affectedPaths: splitItems(options.affectedPaths).length > 0 ? splitItems(options.affectedPaths) : [specRelativePath],
      approval: { required: level === 2, status: "requested" },
      ...(splitItems(options.risks).length > 0 ? { risks: splitItems(options.risks) } : {})
    };

    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, stringifySimpleYaml(proposal as unknown as Record<string, unknown>), "utf8");
    process.stdout.write(`Created Spec Change Proposal: ${relativePath}\n`);
    process.stdout.write(`Level: ${proposal.level}\n`);
    process.stdout.write(`Approval: ${proposal.approval?.status}\n`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
