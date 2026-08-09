import { buildDoctorReport, collectEnvironmentDiagnostics, type DoctorJsonOutput } from "./doctor.js";
import { buildNextAction, buildNextJsonOutput, type NextJsonOutput } from "./next.js";
import { buildReviewQueue, buildReviewQueueSummary, type ReviewQueueSummary } from "./review-queue.js";
import { buildStatus, buildStatusJsonOutput, type StatusJsonOutput } from "./status.js";
import { collectCheckIssues } from "./check.js";
import { collectHealthIssues } from "./health.js";

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

export function runServe(): number {
  console.error("scwbs serve is not implemented yet. Web UI requires a Human Gate decision for dependencies.");
  return 1;
}
