import { describe, expect, test } from "vitest";
import { main } from "../../src/cli.js";
import { queryIndex, rebuildIndex } from "../../src/core/local-index.js";
import { makeTempRepo, writeText, writeYaml } from "../helpers.js";

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
  test("rebuilds an ACED-shaped task directory without indexing task metadata", () => {
    const root = makeTempRepo();
    writeText(root, "contracts/tasks/TASK-1.yaml", "id: TASK-1\ntype: task-contract\ntitle: CLI task\nstatus: planned\n");
    writeYaml(root, "contracts/tasks/index.yaml", {
      tasks: [{ id: "TASK-1", path: "contracts/tasks/TASK-1.yaml", branchName: "task/TASK-1", wbsNodeId: "node-api", status: "reviewed", dependsOn: [] }]
    });

    const rebuild = capture(root, ["index", "rebuild", "--json"]);
    expect(rebuild.code).toBe(0);
    expect(JSON.parse(rebuild.output)).toMatchObject({ status: "pass", recordCount: 1 });

    const query = capture(root, ["query", "--kind", "task", "--json"]);
    expect(query.code).toBe(0);
    const output = JSON.parse(query.output) as { results: Array<{ sourcePath: string; status: string }> };
    expect(output.results).toHaveLength(1);
    expect(output.results[0]).toMatchObject({ sourcePath: "contracts/tasks/TASK-1.yaml", status: "reviewed" });
    expect(output.results.some((item) => item.sourcePath === "contracts/tasks/index.yaml")).toBe(false);
  });

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
