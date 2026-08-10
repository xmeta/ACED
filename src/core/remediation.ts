import type { Issue, Remediation } from "./types.js";

export function commandRemediation(
  argv: string[],
  options: { owner?: "ai" | "human" | "user"; safeToAutoRun?: boolean } = {}
): Remediation {
  return {
    kind: "command",
    owner: options.owner ?? "user",
    argv,
    safeToAutoRun: options.safeToAutoRun ?? false
  };
}

/** Compatibility adapter: legacy fixCommand text is guidance until a producer supplies argv explicitly. */
export const withLegacyRemediations = (issues: Issue[]): Issue[] => issues.map((issue) =>
  issue.remediation || !issue.fixCommand ? issue : { ...issue, remediation: { kind: "guidance", owner: "user", message: issue.fixCommand } }
);
