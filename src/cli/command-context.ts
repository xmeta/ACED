import type { Evidence } from "../core/types.js";

export type CommandContext = {
  root: string;
  setExitCode: (code: number) => void;
};

export function parseBool(value: unknown): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

export function parseTestQuality(options: Record<string, unknown>): Evidence["testQuality"] | undefined {
  const assertionsAdded = parseBool(options.testAssertionsAdded);
  const testsDisabled = parseBool(options.testsDisabled);
  const coverageDecreased = parseBool(options.coverageDecreased);
  const note = options.testQualityNote as string | undefined;
  if (
    assertionsAdded === undefined &&
    testsDisabled === undefined &&
    coverageDecreased === undefined &&
    note === undefined
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
