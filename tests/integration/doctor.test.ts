import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildDoctorFixPlan, buildDoctorReport, collectEnvironmentDiagnostics, runDoctor } from "../../src/commands/doctor.js";
import { makeTempRepo, sampleTask, writeJson, writeScwbsProject, writeText, writeYaml } from "../helpers.js";

describe("doctor", () => {
  test("doctor validates npm engines, Corepack packageManager pins, and workspace graph", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeJson(root, "package.json", {
      engines: { node: ">=22.12.0", npm: ">=10" },
      packageManager: "npm@10.9.0",
      workspaces: ["wjs"]
    });

    const diagnostics = collectEnvironmentDiagnostics(root, {
      nodeVersion: "22.12.0",
      npmVersion: "9.9.0",
      corepackAvailable: true,
      corepackVersion: "0.31.0",
      corepackNpmVersion: "10.9.0",
      dependencyGraphStatus: 0
    });
    const npm = diagnostics.find((diagnostic) => diagnostic.id === "npm");
    const packageManager = diagnostics.find((diagnostic) => diagnostic.id === "packageManager");
    const graph = diagnostics.find((diagnostic) => diagnostic.id === "dependencies.graph");
    expect(npm).toMatchObject({
      status: "fail",
      details: { required: ">=10", actual: "9.9.0", source: "package.json#engines.npm" }
    });
    expect(packageManager).toMatchObject({
      status: "pass",
      details: { required: "npm@10.9.0", actual: "10.9.0" }
    });
    expect(graph).toMatchObject({
      status: "pass",
      details: { required: "npm ls --workspaces --depth=0", actual: "healthy", source: "corepack npm ls --workspaces --depth=0" }
    });
  });

  test("doctor reports wrong pinned npm and missing Corepack independently", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeJson(root, "package.json", {
      engines: { npm: ">=10" },
      packageManager: "npm@10.9.0",
      workspaces: ["wjs"]
    });

    const wrongPin = collectEnvironmentDiagnostics(root, {
      npmVersion: "10.9.0",
      corepackAvailable: true,
      corepackNpmVersion: "10.8.0",
      dependencyGraphStatus: 0
    });
    expect(wrongPin.find((diagnostic) => diagnostic.id === "npm")).toMatchObject({ status: "pass" });
    expect(wrongPin.find((diagnostic) => diagnostic.id === "packageManager")).toMatchObject({ status: "fail" });

    const noCorepack = collectEnvironmentDiagnostics(root, {
      npmVersion: "10.9.0",
      corepackAvailable: false,
      corepackNpmVersion: "",
      dependencyGraphStatus: 0
    });
    expect(noCorepack.find((diagnostic) => diagnostic.id === "corepack")).toMatchObject({ status: "fail" });
    expect(noCorepack.find((diagnostic) => diagnostic.id === "packageManager")).toMatchObject({ status: "fail" });
  });

  test("doctor fix plan respects the pinned package manager", () => {
    const root = makeTempRepo();
    writeJson(root, "package.json", { packageManager: "npm@10.9.0" });
    const plan = buildDoctorFixPlan(root, [{
      id: "root.node_modules",
      label: "root dependencies installed",
      status: "fail",
      message: "node_modules is missing",
      fix: "Run: corepack npm install"
    }]);
    expect(plan).toEqual([{ command: "corepack", args: ["npm", "install"], cwd: "." }]);
  });

  test("doctor reports governance policy impact as read-only machine-readable diagnostics", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ allowedPaths: ["src/**"] }) as unknown as Record<string, unknown>);

    const diagnostic = collectEnvironmentDiagnostics(root, {
      npmVersion: "10.9.0",
      corepackAvailable: true,
      corepackVersion: "0.31.0",
      corepackNpmVersion: "10.9.0",
      dependencyGraphStatus: 0
    }).find((item) => item.id === "governance.policy");
    expect(diagnostic).toMatchObject({
      status: "pass",
      details: {
        policyVersion: "1.0.0",
        mode: "read-only",
        affectedTasks: "WBS-001-004",
        reasonCodes: expect.stringContaining("governance.agent.path-policy")
      }
    });
  });

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
    let status: number;
    try {
      status = runDoctor(root, { json: true });
    } finally {
      console.log = originalLog;
    }

    const parsed = JSON.parse(output.join("\n"));
    expect(status).toBe(0);
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
