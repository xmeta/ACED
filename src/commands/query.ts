import { normalizeQueryKind, queryIndex } from "../core/local-index.js";

export type QueryCommandOptions = { kind?: string; status?: string; unverified?: boolean; stale?: boolean; limit?: number; json?: boolean };

export function runQuery(root: string, value: string | undefined, options: QueryCommandOptions = {}): number {
  try {
    const normalized = normalizeQueryKind(value);
    const kinds = options.kind?.split(",").map((item) => item.trim()).filter(Boolean) ?? normalized.kinds;
    const result = queryIndex(root, { text: normalized.text, kinds, status: options.status, unverified: options.unverified, stale: options.stale, limit: options.limit });
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else for (const item of result.results) process.stdout.write(`${item.kind} ${item.id} | ${item.title} | ${item.locator}\n`);
    return result.status === "corrupt" ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
