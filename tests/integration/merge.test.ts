import { chmodSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test, vi } from "vitest";
import { main } from "../../src/cli.js";
import { evaluateMergePreflight, type MergePullRequestView } from "../../src/core/merge-preflight.js";
import { makeTempRepo, writeText } from "../helpers.js";

const HEAD = "a".repeat(40);

function successfulView(overrides: Partial<MergePullRequestView> = {}): MergePullRequestView {
  return {
    number: 42,
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefOid: HEAD,
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [{
      name: "validate",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      workflowName: "scwbs",
      detailsUrl: "https://github.com/xmeta/ACED/actions/runs/1/job/2"
    }],
    ...overrides
  };
}

function installFakeGh(root: string): { restore: () => void; log: string } {
  const bin = path.join(root, "bin");
  const log = path.join(root, "gh.log");
  const executable = path.join(bin, "gh");
  writeText(root, "bin/gh", [
    "#!/usr/bin/env node",
    "const { appendFileSync } = require('node:fs');",
    "appendFileSync(process.env.SCWBS_TEST_GH_LOG, `${process.argv.slice(2).join(' ')}\\n`);",
    "if (process.argv[2] === 'pr' && process.argv[3] === 'view') {",
    "  if (process.env.SCWBS_TEST_GH_VIEW_ERROR) { process.stderr.write('view unavailable'); process.exit(1); }",
    "  process.stdout.write(process.env.SCWBS_TEST_GH_VIEW);",
    "  process.exit(0);",
    "}",
    "if (process.argv[2] === 'pr' && process.argv[3] === 'merge' && process.env.SCWBS_TEST_GH_MERGE_ERROR) {",
    "  process.stderr.write('merge rejected');",
    "  process.exit(1);",
    "}"
  ].join("\n"));
  chmodSync(executable, 0o755);
  const previousPath = process.env.PATH;
  const previousLog = process.env.SCWBS_TEST_GH_LOG;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.SCWBS_TEST_GH_LOG = log;
  execFileSync("git", ["remote", "add", "origin", "https://github.com/xmeta/ACED.git"], { cwd: root });
  return {
    log,
    restore: () => {
      process.env.PATH = previousPath;
      if (previousLog === undefined) delete process.env.SCWBS_TEST_GH_LOG;
      else process.env.SCWBS_TEST_GH_LOG = previousLog;
      delete process.env.SCWBS_TEST_GH_VIEW;
      delete process.env.SCWBS_TEST_GH_VIEW_ERROR;
      delete process.env.SCWBS_TEST_GH_MERGE_ERROR;
    }
  };
}

describe("merge preflight", () => {
  test("requires the exact main PR state and aggregate scwbs validate success", () => {
    expect(evaluateMergePreflight(42, successfulView(), "xmeta/ACED")).toMatchObject({
      status: "pass",
      repository: "xmeta/ACED",
      headCommit: HEAD,
      validate: { status: "success", workflow: "scwbs" },
      enforcement: {
        githubBranchProtection: "not-enforced",
        headBinding: "match-head-commit",
        adminBypass: false
      }
    });

    for (const [view, code] of [
      [successfulView({ state: "CLOSED" }), "merge.pr.state"],
      [successfulView({ isDraft: true }), "merge.pr.draft"],
      [successfulView({ baseRefName: "release" }), "merge.pr.base"],
      [successfulView({ headRefOid: "short" }), "merge.pr.head"],
      [successfulView({ mergeStateStatus: "DIRTY" }), "merge.pr.mergeable"],
      [successfulView({ statusCheckRollup: [] }), "merge.validate.count"],
      [successfulView({ statusCheckRollup: [{
        name: "validate", status: "IN_PROGRESS", conclusion: "", workflowName: "scwbs"
      }] }), "merge.validate.pending"],
      [successfulView({ statusCheckRollup: [{
        name: "validate", status: "COMPLETED", conclusion: "FAILURE", workflowName: "scwbs"
      }] }), "merge.validate.conclusion"],
      [successfulView({ statusCheckRollup: [{
        name: "validate", status: "COMPLETED", conclusion: "CANCELLED", workflowName: "scwbs"
      }] }), "merge.validate.conclusion"],
      [successfulView({ statusCheckRollup: [{
        name: "validate", status: "COMPLETED", conclusion: "SKIPPED", workflowName: "scwbs"
      }] }), "merge.validate.conclusion"],
      [successfulView({ statusCheckRollup: [{
        name: "validate", status: "COMPLETED", conclusion: "NEUTRAL", workflowName: "scwbs"
      }] }), "merge.validate.conclusion"],
      [successfulView({ statusCheckRollup: [
        { name: "validate", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "scwbs" },
        { name: "validate", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "scwbs" }
      ] }), "merge.validate.count"],
      [successfulView({ statusCheckRollup: [{
        name: "validate", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "other"
      }] }), "merge.validate.workflow"]
    ] as Array<[MergePullRequestView, string]>) {
      expect(evaluateMergePreflight(42, view, "xmeta/ACED").violations.map((item) => item.code)).toContain(code);
    }
  });

  test("blocked preflight never invokes gh pr merge", () => {
    const root = makeTempRepo();
    const fake = installFakeGh(root);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      process.env.SCWBS_TEST_GH_VIEW = JSON.stringify(successfulView({
        statusCheckRollup: [{
          name: "validate",
          status: "COMPLETED",
          conclusion: "TIMED_OUT",
          workflowName: "scwbs"
        }]
      }));
      expect(main(["merge", "--pr", "42", "--json"], root)).toBe(1);
      expect(JSON.parse(output.join(""))).toMatchObject({
        status: "blocked",
        validate: { status: "failure", conclusion: "TIMED_OUT" },
        execution: { requested: true, executed: false, command: null }
      });
      expect(readFileSync(fake.log, "utf8")).toContain("pr view 42 --repo xmeta/ACED");
      expect(readFileSync(fake.log, "utf8")).not.toContain("pr merge");
    } finally {
      log.mockRestore();
      fake.restore();
    }
  });

  test("preflight-only emits schema-conformant JSON without merging", () => {
    const root = makeTempRepo();
    const fake = installFakeGh(root);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      process.env.SCWBS_TEST_GH_VIEW = JSON.stringify(successfulView());
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], root)).toBe(0);
      const report = JSON.parse(output.join(""));
      const schema = JSON.parse(readFileSync(
        path.join(process.cwd(), "docs/scwbs/schemas/merge-preflight.schema.json"),
        "utf8"
      ));
      expect(new Ajv2020({ strict: false }).compile(schema)(report)).toBe(true);
      expect(report).toMatchObject({
        status: "pass",
        execution: { requested: false, executed: false, command: null }
      });
      expect(readFileSync(fake.log, "utf8")).not.toContain("pr merge");
    } finally {
      log.mockRestore();
      fake.restore();
    }
  });

  test("merge binds execution to the verified head without an admin bypass", () => {
    const root = makeTempRepo();
    const fake = installFakeGh(root);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      process.env.SCWBS_TEST_GH_VIEW = JSON.stringify(successfulView());
      expect(main(["merge", "--pr", "42", "--json"], root)).toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({
        status: "pass",
        execution: {
          requested: true,
          executed: true,
          command: `gh pr merge 42 --squash --delete-branch --match-head-commit ${HEAD} --repo xmeta/ACED`
        }
      });
      const calls = readFileSync(fake.log, "utf8");
      expect(calls).toContain(`pr merge 42 --squash --delete-branch --match-head-commit ${HEAD} --repo xmeta/ACED`);
      expect(calls).not.toContain("--admin");
      expect(calls).not.toContain("--auto");
    } finally {
      log.mockRestore();
      fake.restore();
    }
  });

  test("GitHub lookup and merge command failures remain blocked", () => {
    const root = makeTempRepo();
    const fake = installFakeGh(root);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      process.env.SCWBS_TEST_GH_VIEW_ERROR = "1";
      expect(main(["merge", "--pr", "42", "--json"], root)).toBe(1);
      expect(JSON.parse(output.pop()!)).toMatchObject({
        status: "blocked",
        violations: [{ code: "merge.github.unavailable" }]
      });

      delete process.env.SCWBS_TEST_GH_VIEW_ERROR;
      process.env.SCWBS_TEST_GH_VIEW = JSON.stringify(successfulView());
      process.env.SCWBS_TEST_GH_MERGE_ERROR = "1";
      expect(main(["merge", "--pr", "42", "--json"], root)).toBe(1);
      expect(JSON.parse(output.pop()!)).toMatchObject({
        status: "blocked",
        violations: [{ code: "merge.command.failed" }],
        execution: { requested: true, executed: false }
      });
    } finally {
      log.mockRestore();
      fake.restore();
    }
  });
});
