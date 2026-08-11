import { buildDoctorReport, collectEnvironmentDiagnostics, type DoctorJsonOutput } from "./doctor.js";
import { buildNextAction, buildNextJsonOutput, type NextJsonOutput } from "./next.js";
import { buildReviewQueue, buildReviewQueueSummary, type ReviewQueueSummary } from "./review-queue.js";
import { buildStatus, buildStatusJsonOutput, type StatusJsonOutput } from "./status.js";
import { collectCheckIssues } from "./check.js";
import { collectHealthIssues } from "./health.js";
import { createDashboardServer, parseServePort } from "../core/serve.js";
import { listRisks } from "../core/contracts.js";
import { summarizeRisk } from "../core/risk.js";
import { buildTraceJson } from "./trace.js";

export type UiJsonOutput = {
  version: "scwbs.ui.v1";
  status: "pass" | "fail";
  statusReport: StatusJsonOutput;
  next: NextJsonOutput;
  review: ReviewQueueSummary;
  doctor: DoctorJsonOutput;
};

function buildDoctorJsonOutput(root: string): DoctorJsonOutput {
  const diagnostics = collectEnvironmentDiagnostics(root);
  const contractIssues = [
    ...collectCheckIssues(root).map((issue) => ({ source: "check" as const, issue })),
    ...collectHealthIssues(root).map((issue) => ({ source: "health" as const, issue }))
  ];
  const envHasFailure = diagnostics.some((diagnostic) => diagnostic.status === "fail");
  const hasContractErrors = contractIssues.some(({ issue }) => issue.severity === "error");
  return {
    status: envHasFailure || hasContractErrors ? "fail" : "pass",
    diagnostics,
    contractIssues
  };
}

export function buildUiJsonOutput(root: string): UiJsonOutput {
  const statusReport = buildStatusJsonOutput(root);
  const doctor = buildDoctorJsonOutput(root);
  return {
    version: "scwbs.ui.v1",
    status: doctor.status,
    statusReport,
    next: buildNextJsonOutput(root),
    review: buildReviewQueueSummary(root),
    doctor
  };
}

export function runUi(root: string, options: { json?: boolean } = {}): number {
  try {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(buildUiJsonOutput(root))}\n`);
      return 0;
    }
    process.stdout.write(`SC-WBS Dashboard

${buildStatus(root)}
${buildNextAction(root)}
${buildReviewQueue(root)}
${buildDoctorReport(root)}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function runServe(root: string, options: { port?: number } = {}): number {
  try {
    const server = createDashboardServer({
      buildDashboard: () => ({
        ui: buildUiJsonOutput(root),
        openRisks: listRisks(root).slice(0, 50).flatMap((entry) => entry.risk ? [summarizeRisk(root, entry.risk)] : [])
      }),
      buildTrace: (taskId) => buildTraceJson(root, taskId)
    }, { port: parseServePort(options.port) });
    server.once("listening", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port ?? 0;
      process.stdout.write(`scwbs serve listening on http://127.0.0.1:${port}\n`);
    });
    server.once("error", () => {
      process.stderr.write("scwbs serve failed to start\n");
    });
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
