import type { Issue, Remediation } from "./types.js";

export function commandRemediation(
  argv: string[],
  options: { owner?: "ai" | "human" | "user"; cwd?: string; safeToAutoRun?: boolean; reason?: string } = {}
): Remediation {
  return {
    kind: "command",
    owner: options.owner ?? "user",
    argv: [...argv],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    safeToAutoRun: options.safeToAutoRun ?? false,
    ...(options.reason ? { reason: options.reason } : {})
  };
}

export function guidanceRemediation(message: string, owner: "human" | "user" = "user"): Remediation {
  return { kind: "guidance", owner, message };
}

export function waitRemediation(condition: string): Remediation {
  return { kind: "wait", owner: "external", condition };
}

/** Compatibility adapter: legacy fixCommand text is guidance until a producer supplies argv explicitly. */
export function withLegacyRemediations(issues: Issue[]): Issue[] {
  return issues.map((issue) =>
    issue.remediation || !issue.fixCommand
      ? issue
      : { ...issue, remediation: guidanceRemediation(issue.fixCommand) }
  );
}
