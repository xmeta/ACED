import { describe, expect, test } from "vitest";
import { main } from "../../src/cli.js";
import { makeTempRepo } from "../helpers.js";

function capture(args: string[], root: string): { code: number; output: string } {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { return { code: main(args, root), output: chunks.join("") }; }
  finally { process.stdout.write = original; }
}

describe("GitHub Issue intake CLI boundary", () => {
  test("does not create a Task or write a Discovery artifact when GitHub is unavailable", () => {
    const root = makeTempRepo();
    const result = capture(["discovery", "from-github-issue", "123", "--dry-run", "--repository", "octo/repo", "--json"], root);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({ status: "unavailable", authority: "discovery-only", createsTaskContract: false });
  });

  test("requires explicit dry-run for Discovery projection", () => {
    const root = makeTempRepo();
    const result = capture(["discovery", "from-github-issue", "123", "--repository", "octo/repo", "--json"], root);
    expect(result.code).toBe(1);
    expect(result.output).toBe("");
  });
});
