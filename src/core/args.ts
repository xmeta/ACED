import type { Evidence } from "./types.js";

export function valueAfter(args: string[], flag: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export function textAfter(args: string[], flag: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const parts: string[] = [];
  for (let i = index + 1; i < args.length; i += 1) {
    const part = args[i];
    if (!part || part.startsWith("--")) break;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function numberAfter(args: string[], flag: string, fallback: number): number {
  const value = valueAfter(args, flag);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function booleanAfter(args: string[], flag: string): boolean | undefined {
  const value = valueAfter(args, flag);
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function valuesAfter(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === flag && args[index + 1]) values.push(args[index + 1]);
    if (arg?.startsWith(`${flag}=`)) values.push(arg.slice(flag.length + 1));
  }
  return values;
}

export function testQualityAfter(args: string[]): Evidence["testQuality"] | undefined {
  const assertionsAdded = booleanAfter(args, "--test-assertions-added");
  const testsDisabled = booleanAfter(args, "--tests-disabled");
  const coverageDecreased = booleanAfter(args, "--coverage-decreased");
  const note = textAfter(args, "--test-quality-note");
  if (
    assertionsAdded === undefined
    && testsDisabled === undefined
    && coverageDecreased === undefined
    && note === undefined
  ) {
    return undefined;
  }
  return {
    ...(assertionsAdded !== undefined ? { assertionsAdded } : {}),
    ...(testsDisabled !== undefined ? { testsDisabled } : {}),
    ...(coverageDecreased !== undefined ? { coverageDecreased } : {}),
    ...(note ? { notes: [note] } : {})
  };
}
