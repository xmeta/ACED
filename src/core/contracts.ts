import { existsSync, readdirSync } from "node:fs";
import { readYamlFile } from "./yaml.js";
import { defaultEvidenceDir, defaultRegistryPath, defaultSpecsDir, defaultTasksDir, resolveFrom, taskPath, evidencePath } from "./paths.js";
import { asEvidence, asRegistry, asSpecContract, asTaskContract, validateEvidence, validateRegistry, validateSpecContract, validateTaskContract } from "./schema.js";
import type { Evidence, Issue, Registry, RegistryContract, SpecContract, TaskContract } from "./types.js";

export function readRegistry(root: string): { registry?: Registry; issues: Issue[] } {
  const fullPath = resolveFrom(root, defaultRegistryPath);
  if (!existsSync(fullPath)) {
    return { issues: [{ severity: "error", code: "registry.missing", message: `${defaultRegistryPath} does not exist` }] };
  }
  const value = readYamlFile<unknown>(fullPath);
  const issues = validateRegistry(value);
  return { registry: issues.length === 0 ? asRegistry(value) : undefined, issues };
}

export function readTask(root: string, taskId: string): { task?: TaskContract; issues: Issue[] } {
  const relativePath = taskPath(taskId);
  const fullPath = resolveFrom(root, relativePath);
  if (!existsSync(fullPath)) {
    return { issues: [{ severity: "error", code: "task.missing", message: `${relativePath} does not exist` }] };
  }
  const value = readYamlFile<unknown>(fullPath);
  const issues = validateTaskContract(value, relativePath);
  return { task: issues.length === 0 ? asTaskContract(value) : undefined, issues };
}

export function readSpec(root: string, relativePath: string): { spec?: SpecContract; issues: Issue[] } {
  const fullPath = resolveFrom(root, relativePath);
  if (!existsSync(fullPath)) {
    return { issues: [{ severity: "error", code: "spec.missing", message: `${relativePath} does not exist` }] };
  }
  const value = readYamlFile<unknown>(fullPath);
  const issues = validateSpecContract(value, relativePath);
  return { spec: issues.length === 0 ? asSpecContract(value) : undefined, issues };
}

export function readEvidence(root: string, taskId: string): { evidence?: Evidence; issues: Issue[] } {
  const relativePath = evidencePath(taskId);
  const fullPath = resolveFrom(root, relativePath);
  if (!existsSync(fullPath)) {
    return { issues: [{ severity: "error", code: "evidence.missing", message: `${relativePath} does not exist` }] };
  }
  const value = readYamlFile<unknown>(fullPath);
  const issues = validateEvidence(value, relativePath);
  return { evidence: issues.length === 0 ? asEvidence(value) : undefined, issues };
}

export function listTasks(root: string): Array<{ task?: TaskContract; issues: Issue[]; path: string }> {
  const dir = resolveFrom(root, defaultTasksDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
    .map((file) => {
      const path = `${defaultTasksDir}/${file}`;
      const value = readYamlFile<unknown>(resolveFrom(root, path));
      const issues = validateTaskContract(value, path);
      return { task: issues.length === 0 ? asTaskContract(value) : undefined, issues, path };
    });
}

export function listSpecs(root: string): Array<{ spec?: SpecContract; issues: Issue[]; path: string }> {
  const dir = resolveFrom(root, defaultSpecsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
    .map((file) => {
      const path = `${defaultSpecsDir}/${file}`;
      const value = readYamlFile<unknown>(resolveFrom(root, path));
      const issues = validateSpecContract(value, path);
      return { spec: issues.length === 0 ? asSpecContract(value) : undefined, issues, path };
    });
}

export function matchingSpecContract(registry: Registry | undefined, task: TaskContract): RegistryContract | undefined {
  return registry?.contracts.find((contract) => {
    if (contract.type !== "spec") return false;
    return contract.relatedTask === task.id || contract.featureId === task.featureId;
  });
}

export function resolveSpecForTask(root: string, registry: Registry | undefined, task: TaskContract): { contract?: RegistryContract; spec?: SpecContract; path?: string; issues: Issue[] } {
  const contract = matchingSpecContract(registry, task);
  if (!contract) return { issues: [] };
  const { spec, issues } = readSpec(root, contract.path);
  return { contract, spec, path: contract.path, issues };
}

export function evidenceExists(root: string, taskId: string): boolean {
  return existsSync(resolveFrom(root, `${defaultEvidenceDir}/${taskId}.yaml`));
}

export function approvalExists(root: string, taskId: string): boolean {
  const dir = resolveFrom(root, "contracts/approvals");
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((file) => file.includes(taskId) && (file.endsWith(".yaml") || file.endsWith(".yml") || file.endsWith(".md")));
}
