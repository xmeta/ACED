import type { Issue } from "./types.js";

export type Reporter = {
  log(message?: unknown): void;
  error(message?: unknown): void;
  write(chunk: string | Uint8Array): void;
};

export const createConsoleReporter = (): Reporter => ({ log: console.log.bind(console), error: console.error.bind(console), write: process.stdout.write.bind(process.stdout) });

export const createBufferedStdoutReporter = (): { reporter: Reporter; output: () => string } => { let stdout = ""; return { reporter: { log: (message) => { stdout += `${String(message)}\n`; }, error: console.error.bind(console), write: (chunk) => { stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(); } }, output: () => stdout }; };

export const printIssues = (issues: Issue[], reporter: Reporter = createConsoleReporter()): void => issues.forEach((item) => { const prefix = item.severity === "error" ? "ERROR" : "WARN"; reporter.log(`${prefix} ${item.code}: ${item.message}`); if (item.severity === "error" && item.fixCommand) reporter.log(`  fixCommand: ${item.fixCommand}`); });

/**
 * M2-022: every Error must show a fixCommand. Call sites are encouraged to
 * set a specific fixCommand, but this backstop guarantees one is always
 * present so a caller never sees an Error with no next action.
 */
export const withDefaultFixCommand = (a: Issue[], d?: string): Issue[] => a.map((i) => i.remediation ? i : i.fixCommand ? { ...i, remediation: { kind: "guidance", owner: "user", message: i.fixCommand } } : d && i.severity === "error" ? { ...i, fixCommand: d } : i);

export const hasErrors = (issues: Issue[]): boolean => issues.some((item) => item.severity === "error");
