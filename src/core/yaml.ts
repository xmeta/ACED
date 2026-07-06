import { readFileSync } from "node:fs";
import * as yaml from "js-yaml";

type Parsed = Record<string, unknown>;

function asParsed(value: unknown): Parsed {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Parsed;
  return {};
}

export function parseSimpleYaml(text: string): Parsed {
  return asParsed(yaml.load(text));
}

export function readYamlFile<T>(filePath: string): T {
  return parseSimpleYaml(readFileSync(filePath, "utf8")) as T;
}

export function stringifySimpleYaml(value: Record<string, unknown>): string {
  return yaml.dump(value, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false
  }).replace(/^(\s*(?:-\s+)?[A-Za-z0-9_-]+:\s*)'([^'\n]*)'$/gm, (_match, prefix: string, scalar: string) => `${prefix}${JSON.stringify(scalar)}`);
}
