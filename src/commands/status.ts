import { evidenceExists, listTasks } from "../core/contracts.js";
import { findNode, isDoneNode, readWbs } from "../core/wbs.js";

export function buildStatus(root: string): string {
  const wbs = readWbs(root);
  const counts = new Map<string, number>();
  for (const node of wbs.nodes) {
    const status = node.status ?? "planned";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  const evidenceMissing: string[] = [];
  for (const entry of listTasks(root)) {
    if (!entry.task) continue;
    const node = findNode(wbs, entry.task.wbsNodeId);
    if (node && isDoneNode(node) && !evidenceExists(root, entry.task.id)) {
      evidenceMissing.push(entry.task.id);
    }
  }

  const blockers = (wbs.relations ?? []).filter((relation) => relation.type === "blocks");

  const lines = [
    `Project: ${wbs.name}`,
    "",
    "Status:",
    ...Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => `- ${status}: ${count}`),
    "",
    "Evidence Missing:",
    ...(evidenceMissing.length === 0 ? ["- None"] : evidenceMissing.map((item) => `- ${item}`)),
    "",
    "Blocking Relations:",
    ...(blockers.length === 0 ? ["- None"] : blockers.map((relation) => `- ${relation.source} blocks ${relation.target}`))
  ];
  return `${lines.join("\n")}\n`;
}

export function runStatus(root: string): number {
  try {
    process.stdout.write(buildStatus(root));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
