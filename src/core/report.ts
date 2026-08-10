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

export type Reporter = {
  log(message?: unknown): void;
  error(message?: unknown): void;
  write(chunk: string | Uint8Array): void;
};

export function createConsoleReporter(): Reporter {
  return {
    log: (message) => console.log(message),
    error: (message) => console.error(message),
    write: (chunk) => {
      process.stdout.write(chunk);
    }
  };
}

export function createBufferedStdoutReporter(): { reporter: Reporter; output: () => string } {
  let stdout = "";
  const consoleReporter = createConsoleReporter();
  return {
    reporter: {
      log: (message) => {
        stdout += `${String(message)}\n`;
      },
      error: consoleReporter.error,
      write: (chunk) => {
        stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      }
    },
    output: () => stdout
  };
}

export function printIssues(issues: Issue[], reporter: Reporter = createConsoleReporter()): void {
  for (const item of issues) {
    const prefix = item.severity === "error" ? "ERROR" : "WARN";
    reporter.log(`${prefix} ${item.code}: ${item.message}`);
    if (item.severity === "error" && item.fixCommand) {
      reporter.log(`  fixCommand: ${item.fixCommand}`);
    }
  }
}

/**
 * M2-022: every Error must show a fixCommand. Call sites are encouraged to
 * set a specific fixCommand, but this backstop guarantees one is always
 * present so a caller never sees an Error with no next action.
 */
export function withDefaultFixCommand(issues: Issue[], defaultFixCommand: string): Issue[] {
  return issues.map((issue) =>
    issue.severity === "error" && !issue.fixCommand
      ? { ...issue, fixCommand: defaultFixCommand }
      : issue
  );
}

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((item) => item.severity === "error");
}
