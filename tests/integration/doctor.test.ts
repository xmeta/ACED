import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildDoctorReport, runDoctor } from "../../src/commands/doctor.js";
import { makeTempRepo, writeScwbsProject, writeText } from "../helpers.js";

describe("doctor", () => {
  test("doctor shows the issue-specific CRLF repair command", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeText(root, "README.md", "title\r\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    const report = buildDoctorReport(root);
    expect(report).toContain(".gitattributes");
    expect(report).toContain("git add --renormalize README.md");
  });

  test("doctor aggregates repeated CRLF diagnostics within a fixed budget", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    for (let index = 0; index < 100; index += 1) {
      writeText(root, `docs/example-${index}.md`, "title\r\n");
    }
    execFileSync("git", ["add", "docs"], { cwd: root });
    const report = buildDoctorReport(root);
    expect(report).toContain("health.workingTree.crlf (health, count=100)");
    expect(report).toContain("98 more omitted");
    expect(report.split("\n").filter((line) => line.includes("contains CRLF"))).toHaveLength(2);
    expect(Buffer.byteLength(report)).toBeLessThan(4000);
  });

  test("doctor --json outputs pass status for a healthy repo", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    writeText(root, "node_modules/.keep", "");
    mkdirSync(path.join(root, "wjs/node_modules"), { recursive: true });
    writeText(root, "wjs/node_modules/.keep", "");
    mkdirSync(path.join(root, "wjs/node_modules/@esbuild"), { recursive: true });
    writeText(root, "wjs/node_modules/@esbuild/.keep", "");
    writeText(root, "wjs/package.json", JSON.stringify({ scripts: { validate: "node tools/validate.js" } }));
    writeText(root, "wjs/tools/validate.ts", "export {}\n");
    writeText(root, "wjs/tools/validate.js", "process.exit(0);\n");
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
    expect(parsed.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "wjs.validator", status: "pass" })
    ]));

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
    expect(parsed.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "wjs.validator", status: "fail", fix: "Run: git submodule update --init --recursive wjs" })
    ]));
  });
});
