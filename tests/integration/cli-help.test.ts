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

function captureStderr(action: () => number): { exitCode: number; stderr: string } {
  const output: string[] = [];
  const originalWrite = process.stderr.write;
  const originalError = console.error;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  console.error = (message?: unknown) => output.push(`${String(message)}\n`);
  try {
    return { exitCode: action(), stderr: output.join("") };
  } finally {
    process.stderr.write = originalWrite;
    console.error = originalError;
  }
}

describe("CLI help lifecycle semantics", () => {
  test("separates Task pre-flight from Discovery and project bootstrap", () => {
    const root = makeTempRepo();

    const taskStart = captureHelp(["task", "start", "--help"], root);
    expect(taskStart.exitCode).toBe(0);
    expect(taskStart.stdout.replace(/\s+/g, " ")).toContain("Run pre-flight for an existing Task Contract");

    const bootstrap = captureHelp(["project", "bootstrap", "--help"], root);
    expect(bootstrap.exitCode).toBe(0);
    expect(bootstrap.stdout.replace(/\s+/g, " ")).toContain("without a delivery Task Contract");
  });

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

  test("does not advertise text and dry-run stubs as running services or agents", () => {
    const root = makeTempRepo();

    const topLevel = captureHelp(["--help"], root);
    const topLevelText = topLevel.stdout.replace(/\s+/g, " ");
    expect(topLevelText).toContain("ui Show the text dashboard");
      expect(topLevelText).toContain("serve [options] Start the localhost read-only dashboard");
    expect(topLevelText).not.toContain("Start web UI");
    expect(topLevelText).not.toContain("Start API server");

    const aiRun = captureHelp(["ai", "run", "--help"], root);
    expect(aiRun.exitCode).toBe(0);
    expect(aiRun.stdout.replace(/\s+/g, " ")).toContain("Print a dry-run AI task plan");
  });

  test("describes every top-level command group", () => {
    const root = makeTempRepo();
    const topLevel = captureHelp(["--help"], root);
    const topLevelText = topLevel.stdout.replace(/\s+/g, " ");
    const descriptions = [
      "ci Plan and classify CI execution",
      "checks Run and inspect required checks",
      "metrics Measure governance cost and repository metrics",
      "ai Build AI packets and dry-run task plans",
      "approval Manage task approval requests and delegated policy preparation",
      "completion Apply completion changes through SC-WBS",
      "evidence Collect and maintain Task Evidence",
      "registry Validate and rebuild the contract registry",
      "profile Show or change the SC-WBS profile",
      "review Request and route Task reviews",
      "lite Create lightweight task proposals",
      "task Manage Task Contracts and lifecycle",
      "wbs Validate and apply WBS changes"
    ];
    descriptions.forEach((description) => expect(topLevelText).toContain(description));
  });

  test("distinguishes Commander usage errors from action validation errors", () => {
    const root = makeTempRepo();

    const missingArgument = captureStderr(() => main(["wbs", "apply"], root));
    expect(missingArgument.exitCode).toBe(1);
    expect(missingArgument.stderr).toContain("missing required argument");

    const missingTaskOption = captureStderr(() => main(["ai", "run"], root));
    expect(missingTaskOption.exitCode).toBe(2);
    expect(missingTaskOption.stderr).toContain("Missing --task");
  });
});
