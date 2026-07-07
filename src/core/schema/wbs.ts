import type { Issue, WbsDocument } from "../types.js";
import { isObject, isStringArray, issue } from "./shared.js";

export function validateWbsShape(value: unknown): Issue[] {
  const issues: Issue[] = [];
  if (!isObject(value)) return [issue("wbs.invalid", "WBS document must be an object")];
  for (const key of ["schemaVersion", "id", "name", "rootId"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      issues.push(issue("wbs.field", `WBS ${key} must be a non-empty string`));
    }
  }
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
    issues.push(issue("wbs.nodes", "WBS nodes must be a non-empty array"));
    return issues;
  }
  value.nodes.forEach((node, index) => {
    if (!isObject(node)) {
      issues.push(issue("wbs.node", `nodes[${index}] must be an object`));
      return;
    }
    for (const key of ["id", "code", "name", "type"]) {
      if (typeof node[key] !== "string" || node[key].length === 0) {
        issues.push(issue("wbs.node", `nodes[${index}].${key} must be a non-empty string`));
      }
    }
    if (!(typeof node.parentId === "string" || node.parentId === null)) {
      issues.push(issue("wbs.node", `nodes[${index}].parentId must be string or null`));
    }
  });
  return issues;
}

export function asWbsDocument(value: unknown): WbsDocument {
  return value as WbsDocument;
}
