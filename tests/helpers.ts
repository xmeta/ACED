import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Evidence, SpecContract, TaskContract, WbsDocument } from "../src/core/types.js";
import { stringifySimpleYaml } from "../src/core/yaml.js";

export function makeTempRepo(): string {
  const root = path.join(tmpdir(), `scwbs-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  return root;
}

export function writeText(root: string, relativePath: string, content: string): void {
  const fullPath = path.join(root, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

export function writeJson(root: string, relativePath: string, content: unknown): void {
  writeText(root, relativePath, `${JSON.stringify(content, null, 2)}\n`);
}

export function writeYaml(root: string, relativePath: string, content: Record<string, unknown>): void {
  writeText(root, relativePath, stringifySimpleYaml(content));
}

export function sampleWbs(status: WbsDocument["nodes"][number]["status"] = "planned"): WbsDocument {
  return {
    schemaVersion: "0.1.0",
    id: "test-wbs",
    name: "Test WBS",
    rootId: "node-root",
    nodes: [
      {
        id: "node-root",
        parentId: null,
        code: "1",
        name: "Root",
        type: "deliverable",
        status: "planned"
      },
      {
        id: "node-api",
        parentId: "node-root",
        code: "1.1",
        name: "API Implementation",
        type: "workPackage",
        status,
        outputs: ["artifact-api"],
        acceptanceCriteria: ["API tests pass"]
      }
    ],
    relations: [
      {
        id: "rel-api-requirement",
        type: "implementsRequirement",
        source: "node-api",
        target: "req:REQ-001"
      }
    ],
    resources: [],
    artifacts: [
      {
        id: "artifact-api",
        name: "API source",
        type: "sourceCode",
        uri: "./src/api.ts"
      }
    ],
    metadata: {},
    extensions: {}
  };
}

export function sampleTask(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    id: "WBS-001-004",
    type: "task-contract",
    wbsNodeId: "node-api",
    featureId: "F001",
    allowedPaths: ["src/features/api/**", "tests/features/api/**"],
    forbiddenPaths: ["src/auth/**"],
    humanGateRequiredPaths: ["src/security/**"],
    requiredChecks: ["test", "typecheck"],
    doneCriteria: ["API tests pass"],
    evidenceRequired: ["test-result"],
    ...overrides
  };
}

export function sampleSpec(overrides: Partial<SpecContract> = {}): SpecContract {
  return {
    id: "SPEC-F001-API",
    type: "spec-contract",
    featureId: "F001",
    title: "API Implementation",
    status: "approved",
    version: "1.0.0",
    summary: "Spec for the sample API implementation.",
    sourcePaths: ["src/features/api/index.ts"],
    acceptanceCriteria: ["API tests pass"],
    approvedBy: "Product Owner",
    approvedAt: "2026-06-27T10:00:00+09:00",
    ...overrides
  };
}

export function sampleEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: "EVD-001-004",
    type: "evidence",
    taskId: "WBS-001-004",
    changedFiles: ["src/features/api/index.ts"],
    checks: [
      { name: "test", status: "passed" },
      { name: "typecheck", status: "passed" }
    ],
    ...overrides
  };
}

export function writeScwbsProject(root: string, status: WbsDocument["nodes"][number]["status"] = "planned"): void {
  writeJson(root, "contracts/wbs/project.wbs.json", sampleWbs(status));
  const spec = sampleSpec();
  writeYaml(root, "contracts/specs/SPEC-F001-API.yaml", spec as unknown as Record<string, unknown>);
  writeYaml(root, "contracts/registry.yaml", {
    projectId: "test-wbs",
    contracts: [
      {
        id: spec.id,
        type: "spec",
        path: "contracts/specs/SPEC-F001-API.yaml",
        status: spec.status,
        version: spec.version,
        featureId: spec.featureId,
        relatedTask: "WBS-001-004"
      },
      {
        id: "TASK-WBS-001-004",
        type: "task",
        path: "contracts/tasks/WBS-001-004.yaml",
        featureId: "F001"
      }
    ]
  });
  writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask() as unknown as Record<string, unknown>);
}
