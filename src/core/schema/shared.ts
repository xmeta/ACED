import { Ajv, type ErrorObject } from "ajv";
import type { Issue } from "../types.js";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function issue(code: string, message: string): Issue {
  return { severity: "error", code, message };
}

export const ajv = new Ajv({ allErrors: true, strict: false });

export const stringArraySchema = {
  type: "array",
  items: { type: "string" }
} as const;

export function formatSchemaPath(error: ErrorObject): string {
  return error.instancePath ? error.instancePath.replace(/\//g, ".").replace(/^\./, "") : "<root>";
}
