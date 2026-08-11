import { indexStatus, rebuildIndex, verifyIndex } from "../core/local-index.js";

export function runIndexRebuild(root: string, options: { json?: boolean } = {}): number {
  try {
    const result = rebuildIndex(root);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write(`PASS index rebuilt (${result.recordCount} records)\n`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function runIndexStatus(root: string, options: { json?: boolean } = {}): number {
  const result = indexStatus(root);
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`Index: ${result.status}\nPath: ${result.path}\n`);
  return result.status === "corrupt" ? 1 : 0;
}

export function runIndexVerify(root: string, options: { json?: boolean } = {}): number {
  const result = verifyIndex(root);
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`Index verification: ${result.status}\n`);
  return result.status === "corrupt" ? 1 : 0;
}
