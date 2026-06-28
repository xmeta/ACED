import { buildDoctorReport } from "./doctor.js";
import { buildNextAction } from "./next.js";
import { buildReviewQueue } from "./review-queue.js";
import { buildStatus } from "./status.js";

export function runUi(root: string): number {
  try {
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
