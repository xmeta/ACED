import { mkdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runDoctor } from "../../src/commands/doctor.js";
import { makeTempRepo, writeScwbsProject, writeText } from "../helpers.js";

describe("doctor", () => {
  test("doctor --json outputs pass status for a healthy repo", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    writeText(root, "node_modules/.keep", "");
    mkdirSync(path.join(root, "wjs/node_modules"), { recursive: true });
    writeText(root, "wjs/node_modules/.keep", "");
    mkdirSync(path.join(root, "wjs/node_modules/@esbuild"), { recursive: true });
    writeText(root, "wjs/node_modules/@esbuild/.keep", "");
    writeText(root, "wjs/schema/wbs-json.schema.json", "{}");

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };
    try {
      expect(runDoctor(root, { json: true })).toBe(0);
    } finally {
      console.log = originalLog;
    }

    const parsed = JSON.parse(output.join("\n"));
    expect(parsed).toMatchObject({
      status: "pass",
      diagnostics: expect.any(Array),
      contractIssues: expect.any(Array)
    });

    for (const diagnostic of parsed.diagnostics) {
      expect(diagnostic).toMatchObject({
        id: expect.any(String),
        label: expect.any(String),
        status: expect.stringMatching(/pass|fail/),
        message: expect.any(String),
        fix: expect.any(String)
      });
    }
  });

  test("doctor --json outputs fail status for an unhealthy repo", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };
    try {
      expect(runDoctor(root, { json: true })).toBe(1);
    } finally {
      console.log = originalLog;
    }

    const parsed = JSON.parse(output.join("\n"));
    expect(parsed).toMatchObject({
      status: "fail",
      diagnostics: expect.any(Array),
      contractIssues: expect.any(Array)
    });
    expect(parsed.diagnostics.some((d: { status: string }) => d.status === "fail")).toBe(true);
  });
});
