import type { CheckCoveragePolicy, Issue } from "../types.js";
import { isObject, isStringArray, issue } from "./shared.js";

export function validateCheckCoveragePolicy(value: unknown, filePath: string): Issue[] {
  if (!isObject(value)) return [issue("checkCoverage.invalid", `${filePath} must be an object`)];
  if (!Array.isArray(value.rules)) return [issue("checkCoverage.rules", `${filePath}.rules must be an array`)];
  const issues: Issue[] = [];
  value.rules.forEach((rule, index) => {
    if (!isObject(rule)) {
      issues.push(issue("checkCoverage.rule", `${filePath}.rules[${index}] must be an object`));
      return;
    }
    if (typeof rule.id !== "string" || rule.id.length === 0) issues.push(issue("checkCoverage.rule.id", `${filePath}.rules[${index}].id must be a non-empty string`));
    if (!isStringArray(rule.paths) || rule.paths.length === 0 || rule.paths.some((item) => item.trim().length === 0)) issues.push(issue("checkCoverage.rule.paths", `${filePath}.rules[${index}].paths must contain non-blank strings`));
    if (!isStringArray(rule.requires) || rule.requires.length === 0 || rule.requires.some((item) => item.trim().length === 0)) issues.push(issue("checkCoverage.rule.requires", `${filePath}.rules[${index}].requires must contain non-blank strings`));
  });
  return issues;
}

export function asCheckCoveragePolicy(value: unknown): CheckCoveragePolicy {
  return value as CheckCoveragePolicy;
}
