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
    if (node.workMode !== undefined && node.workMode !== "discovery" && node.workMode !== "delivery") {
      issues.push(issue("wbs.discovery.workMode", `nodes[${index}].workMode must be discovery or delivery`));
    }
    if (node.workMode === "discovery") {
      if (node.progressPercent !== undefined) {
        issues.push(issue("wbs.discovery.progressPercent", `nodes[${index}] discovery nodes must not use progressPercent`));
      }
      const state = node.discovery;
      if (!isObject(state)) {
        issues.push(issue("wbs.discovery.state", `nodes[${index}].discovery is required for discovery nodes`));
      } else {
        for (const key of ["factsLearned", "hypothesesRejected", "openUnknowns", "blockingUnknowns", "exitConditions"]) {
          if (!isStringArray(state[key])) issues.push(issue("wbs.discovery.state", `nodes[${index}].discovery.${key} must be a string array`));
        }
        if (typeof state.exitConditionsMet !== "boolean") {
          issues.push(issue("wbs.discovery.state", `nodes[${index}].discovery.exitConditionsMet must be boolean`));
        }
        if (typeof state.nextDecision !== "string" || state.nextDecision.length === 0) {
          issues.push(issue("wbs.discovery.state", `nodes[${index}].discovery.nextDecision must be non-empty`));
        }
        if (!["notReady", "conditionallyReady", "ready"].includes(String(state.decisionReadiness))) {
          issues.push(issue("wbs.discovery.readiness", `nodes[${index}].discovery.decisionReadiness is invalid`));
        }
        if (!["draft", "reviewable", "approved"].includes(String(state.downstreamInputQuality))) {
          issues.push(issue("wbs.discovery.quality", `nodes[${index}].discovery.downstreamInputQuality is invalid`));
        }
      }
    }
    if (node.workMode === "delivery" && node.discovery !== undefined) {
      issues.push(issue("wbs.delivery.discovery", `nodes[${index}] delivery nodes must not carry discovery state`));
    }
  });
  return issues;
}

export function asWbsDocument(value: unknown): WbsDocument {
  return value as WbsDocument;
}
