import { buildAiPacket } from "./ai-packet.js";
import { readTask } from "../core/contracts.js";

export function buildAiRunPlan(root: string, taskId: string, agent = "codex"): string {
  const { task, issues } = readTask(root, taskId);
  if (!task) throw new Error(issues.map((issue) => issue.message).join("\n"));
  return `SC-WBS AI Run (dry-run)

Task: ${task.id}
Agent: ${agent}

Before implementation:
- npm run scwbs -- check
- npm run scwbs -- check-diff --task ${task.id}
- npm run scwbs -- ai packet --task ${task.id} --format ${agent === "codex" ? "codex" : "compact"}

Implementation:
- Give the AI Work Packet to ${agent}
- Stop on forbidden paths, Human Gate paths, DB/API/auth/security/business-rule changes, or unclear scope

After implementation:
- npm run scwbs -- check-diff --task ${task.id}
${task.requiredChecks.map((check) => `- npm ${check === "test" ? "test" : `run ${check}`}`).join("\n")}
- npm run scwbs -- evidence collect --task ${task.id} --force

Packet preview:
${buildAiPacket(root, taskId, 1, agent === "codex" ? "codex" : "compact")}
`;
}

export function runAiRun(root: string, taskId: string, agent?: string): number {
  try {
    process.stdout.write(buildAiRunPlan(root, taskId, agent));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
