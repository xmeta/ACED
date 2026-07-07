import type { Issue, Registry } from "../types.js";
import { ajv, formatSchemaPath, isObject, issue, stringArraySchema } from "./shared.js";
import type { ErrorObject } from "ajv";

const registrySchema = {
  type: "object",
  required: ["projectId", "contracts"],
  additionalProperties: true,
  properties: {
    projectId: { type: "string", minLength: 1 },
    contracts: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "type", "path"],
        additionalProperties: true,
        properties: {
          id: { type: "string", minLength: 1 },
          type: { type: "string", enum: ["requirement", "spec", "spec-change", "task", "evidence", "approval", "review", "block", "adr"] },
          path: { type: "string", minLength: 1 },
          status: { type: "string" },
          version: { type: "string" },
          featureId: { type: "string" },
          relatedTask: { type: "string" }
        }
      }
    }
  }
};

const validateRegistryAjv = ajv.compile(registrySchema);

function schemaIssues(value: unknown, filePath: string): Issue[] {
  if (validateRegistryAjv(value)) return [];
  return (validateRegistryAjv.errors ?? []).map((error: ErrorObject) =>
    issue("registry.schema", `${filePath}.${formatSchemaPath(error)} ${error.message ?? "does not match schema"}`)
  );
}

export function validateRegistrySchema(value: unknown, filePath = "registry"): Issue[] {
  return schemaIssues(value, filePath);
}

export function asRegistry(value: unknown): Registry {
  return value as Registry;
}

export function validateRegistry(value: unknown): Issue[] {
  const issues: Issue[] = [];
  if (!isObject(value)) return [issue("registry.invalid", "registry must be an object")];
  if (typeof value.projectId !== "string" || value.projectId.length === 0) {
    issues.push(issue("registry.projectId", "registry.projectId must be a non-empty string"));
  }
  if (!Array.isArray(value.contracts)) {
    issues.push(issue("registry.contracts", "registry.contracts must be an array"));
    return issues;
  }
  value.contracts.forEach((contract, index) => {
    if (!isObject(contract)) {
      issues.push(issue("registry.contract", `contracts[${index}] must be an object`));
      return;
    }
    for (const key of ["id", "type", "path"]) {
      if (typeof contract[key] !== "string" || contract[key].length === 0) {
        issues.push(issue("registry.contract", `contracts[${index}].${key} must be a non-empty string`));
      }
    }
  });
  return issues;
}
