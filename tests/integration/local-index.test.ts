import { describe, expect, test } from "vitest";
import { main } from "../../src/cli.js";
import { queryIndex, rebuildIndex } from "../../src/core/local-index.js";
import { makeTempRepo, writeText } from "../helpers.js";

function capture(root: string, args: string[]): { code: number; output: string } {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try { return { code: main(args, root), output }; }
  finally { process.stdout.write = originalWrite; }
}

describe("local index CLI and scale fixture", () => {
  test("rebuilds and queries more than 1000 records with bounded JSON", () => {
    const root = makeTempRepo();
    for (let index = 0; index < 1_050; index += 1) {
      writeText(root, `contracts/tasks/TASK-${index}.yaml`, `id: TASK-${index}\ntype: task-contract\nfeatureId: F-${index}\ntitle: auth task ${index}\nstatus: blocked\nallowedPaths: []\nforbiddenPaths: []\nhumanGateRequiredPaths: []\nrequiredChecks: []\ndoneCriteria: []\nevidenceRequired: []\n`);
    }
    const rebuilt = rebuildIndex(root) as { recordCount: number };
    expect(rebuilt.recordCount).toBeGreaterThanOrEqual(1_050);
    const result = queryIndex(root, { text: "auth", kinds: ["task"], limit: 100 });
    expect(result.results).toHaveLength(100);
    expect(result.omitted).toBeGreaterThan(900);
    const cli = capture(root, ["query", "tasks", "--status", "blocked", "--limit", "2", "--json"]);
    expect(cli.code).toBe(0);
    expect(JSON.parse(cli.output)).toMatchObject({ version: "scwbs.query.v1", query: { kinds: ["task"], limit: 2 }, results: expect.any(Array) });
  }, 60_000);
});
