import { describe, expect, test } from "vitest";
import { main } from "../../src/cli.js";
import { makeTempRepo } from "../helpers.js";

function captureHelp(args: string[], root: string): { exitCode: number; stdout: string } {
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { exitCode: main(args, root), stdout: output.join("") };
  } finally {
    process.stdout.write = originalWrite;
  }
}

describe("CLI help lifecycle semantics", () => {
  test("describes status strict scope and finish preflight side effects", () => {
    const root = makeTempRepo();

    const status = captureHelp(["status", "--help"], root);
    expect(status.exitCode).toBe(0);
    const statusText = status.stdout.replace(/\s+/g, " ");
    expect(statusText).toContain("completed or archived Task completion trust");

    const finish = captureHelp(["finish", "--help"], root);
    expect(finish.exitCode).toBe(0);
    const finishText = finish.stdout.replace(/\s+/g, " ");
    expect(finishText).toContain("without required checks or tracked artifact changes");
    expect(finishText).toContain("record a local lifecycle receipt");
    expect(finishText).not.toContain("without running checks or writing files");
  });
});
