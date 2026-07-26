import { listTasks, readSpec } from "../core/contracts.js";
import { buildRollingWavePlan, rollingWavePlanPath } from "../core/planning.js";
import { buildTaskIndex, readTaskIndex, writeTaskIndexAtomic } from "../core/task-index.js";
import { syncRegistry } from "./registry-rebuild.js";

export function runPlan(root: string, specId: string, options: {
  replanReason?: string;
  json?: boolean;
} = {}): number {
  try {
    const specRelativePath = specId.includes("/") ? specId : `contracts/specs/${specId}.yaml`;
    const { spec, issues } = readSpec(root, specRelativePath);
    if (!spec) throw new Error(issues.map((issue) => issue.message).join("\n"));
    const tasks = listTasks(root);
    const invalidTasks = tasks.flatMap((entry) => entry.issues);
    if (invalidTasks.length > 0) throw new Error(invalidTasks.map((issue) => issue.message).join("\n"));
    const plan = buildRollingWavePlan(root, spec, options.replanReason);
    const updatedTasks = listTasks(root);
    writeTaskIndexAtomic(root, buildTaskIndex(updatedTasks, readTaskIndex(root).index));
    syncRegistry(root);
    const output = {
      version: "scwbs.plan.v1",
      status: "created",
      planningMode: plan.planningMode,
      specId: plan.specId,
      path: rollingWavePlanPath(plan.specId),
      tasks: plan.artifacts.tasks,
      probe: plan.artifacts.probe ?? null,
      nextAction: plan.planningMode === "probe"
        ? (plan.inputs.probeResults.some((probe) => probe.status === "inconclusive")
          ? "Create a follow-up Discovery Probe, then replan before delivery"
          : `Conclude ${plan.artifacts.probe ?? "the Discovery Probe"} before delivery planning`)
        : `Review Ready Window Tasks: ${plan.artifacts.tasks.join(", ")}`
    };
    if (options.json) console.log(JSON.stringify(output));
    else console.log([
      `CREATED ${output.path}`,
      `mode: ${output.planningMode}`,
      `tasks: ${output.tasks.join(", ") || "(none)"}`,
      `probe: ${output.probe ?? "(none)"}`,
      `next: ${output.nextAction}`
    ].join("\n"));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
