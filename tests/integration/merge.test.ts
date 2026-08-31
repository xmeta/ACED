import { chmodSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test, vi } from "vitest";
import { main } from "../../src/cli.js";
import { evaluateMergePreflight, type MergePullRequestView } from "../../src/core/merge-preflight.js";
import { hashDiffBinary, diffBinary, headCommit } from "../../src/core/git.js";
import { makeTempRepo, sampleApproval, sampleEvidence, sampleTask, writeText, writeYaml } from "../helpers.js";

const HEAD = "a".repeat(40);
const REPOSITORY = "xmeta/ACED";
const WORKFLOW_PATH = ".github/workflows/scwbs.yml";
const VERIFIER_PATH = ".github/workflows/scwbs-workflow-integrity.yml";
const CONTROL_MANIFEST = [
  { kind: "workflow", pattern: ".github/workflows/**" },
  { kind: "local-action", pattern: ".github/actions/**" },
  { kind: "ci-runner", pattern: "scripts/**" },
  { kind: "package-config", pattern: "package.json" },
  { kind: "package-config", pattern: "package-lock.json" },
  { kind: "package-config", pattern: "tsconfig.json" },
  { kind: "package-config", pattern: "vitest.config.ts" },
  { kind: "merge-enforcement", pattern: "src/core/merge-preflight.ts" },
  { kind: "merge-enforcement", pattern: "src/commands/merge.ts" },
  { kind: "merge-enforcement", pattern: "src/commands/finish.ts" },
  { kind: "merge-enforcement", pattern: "src/cli.ts" }
];

function digest(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function expectMergeReportSchema(report: unknown): void {
  const schema = JSON.parse(
    readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/merge-preflight.schema.json"), "utf8")
  );
  expect(new Ajv2020({ strict: false }).compile(schema)(report)).toBe(true);
}

function commitAll(root: string, message: string): string {
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message], { cwd: root, stdio: "ignore" });
  return headCommit(root)!;
}

function descriptorZip(
  receipt: Buffer,
  options: { name?: string; extraEntries?: boolean; symlink?: boolean } = {}
): Buffer {
  const name = Buffer.from(options.name ?? "workflow-integrity-receipt.json", "utf8");
  const data = deflateRawSync(receipt);
  // ZIP CRC-32 is deliberately implemented here without a dependency.
  let checksum = 0xffffffff;
  for (const byte of receipt) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
  }
  const receiptCrc = (checksum ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x8, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const payload = Buffer.concat([local, data]);
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(receiptCrc, 4);
  descriptor.writeUInt32LE(data.length, 8);
  descriptor.writeUInt32LE(receipt.length, 12);
  const localWithDescriptor = Buffer.concat([payload, descriptor]);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(options.symlink ? 0x0314 : 0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x8, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(receiptCrc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(receipt.length, 24);
  if (options.symlink) central.writeUInt32LE(0xa0000000, 38);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  let centralDirectory = central;
  if (options.extraEntries) {
    const extraName = Buffer.from("extra.txt", "utf8");
    const extra = Buffer.alloc(46 + extraName.length);
    extra.writeUInt32LE(0x02014b50, 0);
    extra.writeUInt16LE(20, 6);
    extra.writeUInt16LE(extraName.length, 28);
    extraName.copy(extra, 46);
    centralDirectory = Buffer.concat([central, extra]);
  }
  const centralOffset = localWithDescriptor.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(options.extraEntries ? 2 : 1, 8);
  eocd.writeUInt16LE(options.extraEntries ? 2 : 1, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([localWithDescriptor, centralDirectory, eocd]);
}

function successfulView(overrides: Partial<MergePullRequestView> = {}): MergePullRequestView {
  return {
    number: 42,
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    baseRefOid: "b".repeat(40),
    headRefOid: HEAD,
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [
      {
        name: "validate",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        workflowName: "scwbs",
        detailsUrl: "https://github.com/xmeta/ACED/actions/runs/1/job/2"
      }
    ],
    ...overrides
  };
}

function installFakeGh(root: string): { restore: () => void; log: string } {
  const bin = path.join(root, "bin");
  const log = path.join(root, "gh.log");
  const executable = path.join(bin, "gh");
  writeText(
    root,
    "bin/gh",
    [
      "#!/usr/bin/env node",
      "const { appendFileSync } = require('node:fs');",
      "appendFileSync(process.env.SCWBS_TEST_GH_LOG, `${process.argv.slice(2).join(' ')}\\n`);",
      "if (process.argv[2] === 'pr' && process.argv[3] === 'view') {",
      "  if (process.env.SCWBS_TEST_GH_VIEW_ERROR) { process.stderr.write('view unavailable'); process.exit(1); }",
      "  process.stdout.write(process.env.SCWBS_TEST_GH_VIEW);",
      "  process.exit(0);",
      "}",
      "if (process.argv[2] === 'api') {",
      "  const endpoint = process.argv[3];",
      "  if (endpoint.endsWith('/zip')) { process.stdout.write(Buffer.from(process.env.SCWBS_TEST_GH_ZIP || '', 'base64')); process.exit(0); }",
      "  const responses = process.env.SCWBS_TEST_GH_API ? JSON.parse(process.env.SCWBS_TEST_GH_API) : {};",
      "  if (Object.prototype.hasOwnProperty.call(responses, endpoint)) { process.stdout.write(JSON.stringify(responses[endpoint])); process.exit(0); }",
      `  if (endpoint === 'repos/xmeta/ACED/pulls/42') { process.stdout.write(JSON.stringify({ changed_files: 0, head: { sha: '${HEAD}' }, base: { sha: '${"b".repeat(40)}' } })); process.exit(0); }`,
      "  if (endpoint.startsWith('repos/xmeta/ACED/pulls/42/files?')) { process.stdout.write('[]'); process.exit(0); }",
      "  process.stderr.write(`unexpected api ${endpoint}`); process.exit(1);",
      "}",
      "if (process.argv[2] === 'pr' && process.argv[3] === 'merge' && process.env.SCWBS_TEST_GH_MERGE_ERROR) {",
      "  process.stderr.write('merge rejected');",
      "  process.exit(1);",
      "}"
    ].join("\n")
  );
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
      delete process.env.SCWBS_TEST_GH_API;
      delete process.env.SCWBS_TEST_GH_ZIP;
    }
  };
}

function validControlFixture(
  options: {
    approvalStatus?: "approved" | "requested" | "rejected";
    unboundApproval?: boolean;
    omitApprovalField?: "pullRequest" | "headCommit" | "diffHash";
    legacyEvidence?: boolean;
    v2Approval?: boolean;
    v2ApprovalMismatch?: "pullRequest" | "headCommit" | "diffHash";
  } = {}
): {
  root: string;
  fake: ReturnType<typeof installFakeGh>;
  head: string;
  receipt: Buffer;
} {
  const root = makeTempRepo();
  const fake = installFakeGh(root);
  writeText(root, WORKFLOW_PATH, "name: scwbs\n");
  writeText(root, VERIFIER_PATH, "name: scwbs-workflow-integrity\n");
  writeYaml(
    root,
    "contracts/tasks/WBS-001-004.yaml",
    sampleTask({ id: "WBS-001-004", humanGateRequiredPaths: [] }) as unknown as Record<string, unknown>
  );
  const base = commitAll(root, "base");
  writeText(root, WORKFLOW_PATH, "name: scwbs\nchanged: true\n");
  const subject = commitAll(root, "control change");
  const diffHash = hashDiffBinary(
    diffBinary(root, base, subject, [
      "contracts/evidence/WBS-001-004.yaml",
      "contracts/evidence-payloads/WBS-001-004.patch",
      "contracts/approvals/WBS-001-004.yaml",
      "contracts/reviews/WBS-001-004.yaml",
      "contracts/registry.yaml"
    ])
  );
  const evidence = sampleEvidence({
    changedFiles: [WORKFLOW_PATH],
    subjectHeadCommit: subject,
    diffHash,
    git: {
      branch: "feature",
      base: "main",
      headCommit: subject,
      pullRequest: "#42",
      subjectHeadCommit: subject,
      diffHash
    }
  });
  if (options.legacyEvidence) evidence.git!.changedFilesBasis = "legacy-recorded";
  writeYaml(root, "contracts/evidence/WBS-001-004.yaml", evidence as unknown as Record<string, unknown>);
  const approval = sampleApproval({
    status: options.approvalStatus ?? "approved",
    approvedBy: "Human Reviewer",
    approvedAt: "2026-08-31T00:00:00.000Z",
    headCommit: subject,
    diffHash,
    pullRequest: "#42"
  });
  if (options.unboundApproval) {
    delete approval.pullRequest;
    delete approval.headCommit;
    delete approval.diffHash;
  }
  if (options.omitApprovalField) delete approval[options.omitApprovalField];
  if (options.v2Approval || options.v2ApprovalMismatch) {
    const provenance = {
      approvedBy: "Human Reviewer",
      approvedAt: "2026-08-31T00:00:00.000Z",
      reason: "control surface approval",
      approvalMode: "human" as const,
      actorId: "Human Reviewer",
      actorSource: "tty",
      verifiedAt: "2026-08-31T00:00:00.000Z",
      verificationLevel: "lean",
      notes: ["Awaiting human gate review"]
    };
    const humanGate = {
      status: "approved" as const,
      headCommit: subject,
      diffHash,
      pullRequest: "#42",
      ...provenance
    };
    if (options.v2ApprovalMismatch) {
      if (options.v2ApprovalMismatch === "pullRequest") humanGate.pullRequest = "#41";
      if (options.v2ApprovalMismatch === "headCommit") humanGate.headCommit = "0".repeat(40);
      if (options.v2ApprovalMismatch === "diffHash") humanGate.diffHash = `sha256:${"0".repeat(64)}`;
    }
    Object.assign(approval, {
      version: "scwbs.approval.v2" as const,
      activeScope: "post-finish" as const,
      scopeApprovals: {
        "human-gate": humanGate,
        "post-finish": {
          status: "approved" as const,
          headCommit: subject,
          diffHash,
          pullRequest: "#42",
          ...provenance
        }
      },
      ...provenance,
      headCommit: subject,
      diffHash,
      pullRequest: "#42"
    });
  }
  writeYaml(root, "contracts/approvals/WBS-001-004.yaml", approval as unknown as Record<string, unknown>);
  writeText(root, "contracts/registry.yaml", "metadata\n");
  const head = commitAll(root, "lifecycle metadata");
  const blob = execFileSync("git", ["rev-parse", `${subject}:${WORKFLOW_PATH}`], {
    cwd: root,
    encoding: "utf8"
  }).trim();
  const triggeringRunId = 777;
  const verifierRunId = 888;
  const verifierUrl = `https://github.com/${REPOSITORY}/actions/runs/${verifierRunId}`;
  const triggeringUrl = `https://github.com/${REPOSITORY}/actions/runs/${triggeringRunId}`;
  const controlFiles = [
    {
      file: WORKFLOW_PATH,
      kind: "workflow",
      role: "current",
      counterpart: null,
      status: "modified",
      headBlobSha: blob,
      previousBlobSha: null
    }
  ];
  const receipt = {
    type: "scwbs.workflow-integrity.v1",
    repository: REPOSITORY,
    pullRequest: 42,
    baseCommit: base,
    headCommit: head,
    triggeringRun: {
      id: triggeringRunId,
      url: triggeringUrl,
      workflowPath: WORKFLOW_PATH,
      headRepository: REPOSITORY,
      headBranch: "feature"
    },
    trustedWorkflow: {
      path: WORKFLOW_PATH,
      sha256: digest(readFileSync(`${root}/${WORKFLOW_PATH}`, "utf8").replace("changed: true\n", ""))
    },
    controlSurface: {
      version: "1",
      manifestDigest: digest(JSON.stringify(CONTROL_MANIFEST)),
      observedDigest: digest(JSON.stringify(controlFiles)),
      controlFiles
    },
    verifier: {
      workflowPath: VERIFIER_PATH,
      runId: verifierRunId,
      runUrl: verifierUrl,
      definitionCommit: base,
      sha256: digest(readFileSync(`${root}/${VERIFIER_PATH}`))
    }
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  const summary = receiptBytes.toString("utf8");
  const api: Record<string, unknown> = {
    [`repos/${REPOSITORY}/pulls/42`]: {
      number: 42,
      id: 9001,
      state: "open",
      changed_files: 1,
      base: { ref: "main", sha: base, repo: { full_name: REPOSITORY } },
      head: { ref: "feature", sha: head, repo: { full_name: REPOSITORY } }
    },
    [`repos/${REPOSITORY}/pulls/42/files?per_page=100&page=1`]: [
      { filename: WORKFLOW_PATH, status: "modified", sha: blob }
    ],
    [`repos/${REPOSITORY}/commits/${head}/check-runs?check_name=workflow-integrity&filter=all&per_page=100&page=1`]: {
      total_count: 1,
      check_runs: [
        {
          name: "workflow-integrity",
          status: "completed",
          conclusion: "success",
          head_sha: head,
          app: { slug: "github-actions" },
          details_url: verifierUrl,
          external_id: `scwbs.workflow-integrity.v1:${triggeringRunId}:${base}:${head}`,
          output: { summary }
        }
      ]
    },
    [`repos/${REPOSITORY}/actions/runs/${verifierRunId}`]: {
      id: verifierRunId,
      path: VERIFIER_PATH,
      event: "workflow_run",
      status: "completed",
      conclusion: "success",
      html_url: verifierUrl,
      repository: { full_name: REPOSITORY },
      head_repository: { full_name: REPOSITORY },
      head_branch: "main",
      head_sha: base
    },
    [`repos/${REPOSITORY}/actions/runs/${verifierRunId}/artifacts?per_page=100&page=1`]: {
      total_count: 1,
      artifacts: [
        {
          id: 999,
          name: `scwbs-workflow-integrity-v1-${triggeringRunId}`,
          expired: false,
          size_in_bytes: 0,
          workflow_run: { id: verifierRunId },
          digest: "sha256:pending"
        }
      ]
    },
    [`repos/${REPOSITORY}/contents/${WORKFLOW_PATH}?ref=${base}`]: {
      encoding: "base64",
      content: Buffer.from("name: scwbs\n", "utf8").toString("base64")
    },
    [`repos/${REPOSITORY}/contents/${VERIFIER_PATH}?ref=${base}`]: {
      encoding: "base64",
      content: readFileSync(`${root}/${VERIFIER_PATH}`).toString("base64")
    },
    [`repos/${REPOSITORY}/actions/runs/${triggeringRunId}`]: {
      id: triggeringRunId,
      path: WORKFLOW_PATH,
      event: "pull_request",
      status: "completed",
      conclusion: "success",
      html_url: triggeringUrl,
      head_sha: head,
      head_repository: { full_name: REPOSITORY },
      head_branch: "feature",
      pull_requests: [{ number: 42, id: 9001 }]
    }
  };
  const archive = descriptorZip(receiptBytes);
  (
    api[`repos/${REPOSITORY}/actions/runs/${verifierRunId}/artifacts?per_page=100&page=1`] as {
      artifacts: Array<Record<string, unknown>>;
    }
  ).artifacts[0] = {
    id: 999,
    name: `scwbs-workflow-integrity-v1-${triggeringRunId}`,
    expired: false,
    size_in_bytes: archive.length,
    workflow_run: { id: verifierRunId },
    digest: digest(archive)
  };
  process.env.SCWBS_TEST_GH_VIEW = JSON.stringify(successfulView({ baseRefOid: base, headRefOid: head }));
  process.env.SCWBS_TEST_GH_API = JSON.stringify(api);
  process.env.SCWBS_TEST_GH_ZIP = archive.toString("base64");
  return { root, fake, head, receipt: receiptBytes };
}

function mutateReceiptFixture(
  fixture: ReturnType<typeof validControlFixture>,
  mutate: (receipt: Record<string, unknown>) => void
): void {
  const api = JSON.parse(process.env.SCWBS_TEST_GH_API!) as Record<string, unknown>;
  const receipt = JSON.parse(fixture.receipt.toString("utf8")) as Record<string, unknown>;
  mutate(receipt);
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  const checkKey = Object.keys(api).find((item) => item.includes("check-runs?"))!;
  const checks = api[checkKey] as { check_runs: Array<Record<string, unknown>> };
  (checks.check_runs[0]!.output as Record<string, unknown>).summary = bytes.toString("utf8");
  const archive = descriptorZip(bytes);
  process.env.SCWBS_TEST_GH_ZIP = archive.toString("base64");
  const artifactKey = Object.keys(api).find((item) => item.includes("/artifacts?"))!;
  const artifact = (api[artifactKey] as { artifacts: Array<Record<string, unknown>> }).artifacts[0]!;
  artifact.size_in_bytes = archive.length;
  artifact.digest = digest(archive);
  process.env.SCWBS_TEST_GH_API = JSON.stringify(api);
}

function replaceArtifactZip(fixture: ReturnType<typeof validControlFixture>, archive: Buffer): void {
  const api = JSON.parse(process.env.SCWBS_TEST_GH_API!) as Record<string, unknown>;
  const artifactKey = Object.keys(api).find((item) => item.includes("/artifacts?"))!;
  const artifact = (api[artifactKey] as { artifacts: Array<Record<string, unknown>> }).artifacts[0]!;
  artifact.size_in_bytes = archive.length;
  artifact.digest = digest(archive);
  process.env.SCWBS_TEST_GH_ZIP = archive.toString("base64");
  process.env.SCWBS_TEST_GH_API = JSON.stringify(api);
}

function rebindHeadFixture(fixture: ReturnType<typeof validControlFixture>, head: string): void {
  const view = JSON.parse(process.env.SCWBS_TEST_GH_VIEW!) as MergePullRequestView;
  view.headRefOid = head;
  process.env.SCWBS_TEST_GH_VIEW = JSON.stringify(view);
  const api = JSON.parse(process.env.SCWBS_TEST_GH_API!) as Record<string, unknown>;
  const pull = api["repos/xmeta/ACED/pulls/42"] as Record<string, unknown>;
  (pull.head as Record<string, unknown>).sha = head;
  const oldCheckKey = Object.keys(api).find((item) => item.includes("/commits/") && item.includes("check-runs?"))!;
  const checks = api[oldCheckKey];
  delete api[oldCheckKey];
  api[`repos/xmeta/ACED/commits/${head}/check-runs?check_name=workflow-integrity&filter=all&per_page=100&page=1`] =
    checks;
  const run = api["repos/xmeta/ACED/actions/runs/777"] as Record<string, unknown>;
  run.head_sha = head;
  const receipt = JSON.parse(fixture.receipt.toString("utf8")) as Record<string, unknown>;
  receipt.headCommit = head;
  (receipt.triggeringRun as Record<string, unknown>).headCommit = head;
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  fixture.receipt = bytes;
  const check = (checks as { check_runs: Array<Record<string, unknown>> }).check_runs[0]!;
  (check.output as Record<string, unknown>).summary = bytes.toString("utf8");
  check.head_sha = head;
  check.external_id = `scwbs.workflow-integrity.v1:777:${(pull.base as Record<string, unknown>).sha}:${head}`;
  const archive = descriptorZip(bytes);
  const artifactKey = Object.keys(api).find((item) => item.includes("/artifacts?"))!;
  const artifact = (api[artifactKey] as { artifacts: Array<Record<string, unknown>> }).artifacts[0]!;
  artifact.size_in_bytes = archive.length;
  artifact.digest = digest(archive);
  process.env.SCWBS_TEST_GH_ZIP = archive.toString("base64");
  process.env.SCWBS_TEST_GH_API = JSON.stringify(api);
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
      [
        successfulView({
          statusCheckRollup: [
            {
              name: "validate",
              status: "IN_PROGRESS",
              conclusion: "",
              workflowName: "scwbs"
            }
          ]
        }),
        "merge.validate.pending"
      ],
      [
        successfulView({
          statusCheckRollup: [
            {
              name: "validate",
              status: "COMPLETED",
              conclusion: "FAILURE",
              workflowName: "scwbs"
            }
          ]
        }),
        "merge.validate.conclusion"
      ],
      [
        successfulView({
          statusCheckRollup: [
            {
              name: "validate",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              workflowName: "scwbs"
            }
          ]
        }),
        "merge.validate.conclusion"
      ],
      [
        successfulView({
          statusCheckRollup: [
            {
              name: "validate",
              status: "COMPLETED",
              conclusion: "SKIPPED",
              workflowName: "scwbs"
            }
          ]
        }),
        "merge.validate.conclusion"
      ],
      [
        successfulView({
          statusCheckRollup: [
            {
              name: "validate",
              status: "COMPLETED",
              conclusion: "NEUTRAL",
              workflowName: "scwbs"
            }
          ]
        }),
        "merge.validate.conclusion"
      ],
      [
        successfulView({
          statusCheckRollup: [
            { name: "validate", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "scwbs" },
            { name: "validate", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "scwbs" }
          ]
        }),
        "merge.validate.count"
      ],
      [
        successfulView({
          statusCheckRollup: [
            {
              name: "validate",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              workflowName: "other"
            }
          ]
        }),
        "merge.validate.workflow"
      ]
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
      process.env.SCWBS_TEST_GH_VIEW = JSON.stringify(
        successfulView({
          statusCheckRollup: [
            {
              name: "validate",
              status: "COMPLETED",
              conclusion: "TIMED_OUT",
              workflowName: "scwbs"
            }
          ]
        })
      );
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

  test("control-surface PR rejects validate success without a workflow-integrity receipt", () => {
    const root = makeTempRepo();
    const fake = installFakeGh(root);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      process.env.SCWBS_TEST_GH_VIEW = JSON.stringify(successfulView());
      process.env.SCWBS_TEST_GH_API = JSON.stringify({
        "repos/xmeta/ACED/pulls/42": {
          number: 42,
          id: 9001,
          state: "open",
          changed_files: 1,
          base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "xmeta/ACED" } },
          head: { ref: "feature", sha: HEAD, repo: { full_name: "xmeta/ACED" } }
        },
        "repos/xmeta/ACED/pulls/42/files?per_page=100&page=1": [
          { filename: ".github/workflows/scwbs.yml", status: "modified", sha: "c".repeat(40) }
        ],
        [`repos/xmeta/ACED/commits/${HEAD}/check-runs?check_name=workflow-integrity&filter=all&per_page=100&page=1`]: {
          total_count: 0,
          check_runs: []
        }
      });
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], root)).toBe(1);
      const report = JSON.parse(output.join(""));
      expectMergeReportSchema(report);
      expect(report).toMatchObject({
        status: "blocked",
        workflowTrust: { status: "blocked", controlFiles: [".github/workflows/scwbs.yml"] },
        violations: [expect.objectContaining({ code: "merge.workflowTrust.unavailable" })]
      });
      expect(readFileSync(fake.log, "utf8")).toContain("check-runs?check_name=workflow-integrity");
      expect(readFileSync(fake.log, "utf8")).not.toContain("pr merge");
    } finally {
      log.mockRestore();
      fake.restore();
    }
  });

  test.each([
    [
      "missing check",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.includes("check-runs?"))!;
        api[key] = { total_count: 0, check_runs: [] };
      },
      "missing or ambiguous"
    ],
    [
      "pending check",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.includes("check-runs?"))!;
        (api[key] as { check_runs: Array<Record<string, unknown>> }).check_runs[0]!.status = "in_progress";
      },
      "workflow-integrity check or receipt provenance"
    ],
    [
      "failed check",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.includes("check-runs?"))!;
        (api[key] as { check_runs: Array<Record<string, unknown>> }).check_runs[0]!.conclusion = "failure";
      },
      "workflow-integrity check or receipt provenance"
    ],
    [
      "duplicate checks",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.includes("check-runs?"))!;
        const checks = api[key] as { check_runs: Array<Record<string, unknown>>; total_count: number };
        checks.total_count = 2;
        checks.check_runs.push({ ...checks.check_runs[0] });
      },
      "missing or ambiguous"
    ],
    [
      "unmanaged check",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.includes("check-runs?"))!;
        (
          (api[key] as { check_runs: Array<Record<string, unknown>> }).check_runs[0]!.app as Record<string, unknown>
        ).slug = "other-app";
      },
      "workflow-integrity check or receipt provenance"
    ],
    [
      "external id mismatch",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.includes("check-runs?"))!;
        (api[key] as { check_runs: Array<Record<string, unknown>> }).check_runs[0]!.external_id = "wrong";
      },
      "workflow-integrity check or receipt provenance"
    ],
    [
      "details URL mismatch",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.includes("check-runs?"))!;
        (api[key] as { check_runs: Array<Record<string, unknown>> }).check_runs[0]!.details_url =
          "https://github.com/xmeta/ACED/actions/runs/1";
      },
      "workflow-integrity check or receipt provenance"
    ],
    [
      "check head mismatch",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.includes("check-runs?"))!;
        (api[key] as { check_runs: Array<Record<string, unknown>> }).check_runs[0]!.head_sha = "f".repeat(40);
      },
      "workflow-integrity check or receipt provenance"
    ],
    [
      "files count mismatch",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.includes("/pulls/42"))!;
        (api[key] as Record<string, unknown>).changed_files = 2;
      },
      "changed-file pagination is incomplete"
    ],
    [
      "check pagination count mismatch",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.includes("check-runs?"))!;
        (api[key] as Record<string, unknown>).total_count = 2;
      },
      "check_runs pagination is incomplete"
    ],
    [
      "artifact pagination count mismatch",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.includes("/artifacts?"))!;
        (api[key] as Record<string, unknown>).total_count = 2;
      },
      "artifacts pagination is incomplete"
    ],
    [
      "changed-file bound",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.endsWith("/pulls/42"))!;
        (api[key] as Record<string, unknown>).changed_files = 257;
      },
      "exceeds the changed-file bound"
    ]
  ])("rejects %s control API state without invoking merge", (name, mutate, expected) => {
    const fixture = validControlFixture();
    const api = JSON.parse(process.env.SCWBS_TEST_GH_API!) as Record<string, unknown>;
    mutate(api);
    process.env.SCWBS_TEST_GH_API = JSON.stringify(api);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], fixture.root)).toBe(1);
      const report = JSON.parse(output.join(""));
      expect(report.status).toBe("blocked");
      expect(report.violations.some((violation: { message: string }) => violation.message.includes(expected))).toBe(
        true
      );
      expect(readFileSync(fixture.fake.log, "utf8")).not.toContain("pr merge");
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test.each([
    [
      "duplicate artifact",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.includes("/artifacts?"))!;
        const artifacts = api[key] as { total_count: number; artifacts: Array<Record<string, unknown>> };
        artifacts.total_count = 2;
        artifacts.artifacts.push({ ...artifacts.artifacts[0] });
      },
      "artifact is missing or ambiguous"
    ],
    [
      "artifact size mismatch",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.includes("/artifacts?"))!;
        (api[key] as { artifacts: Array<Record<string, unknown>> }).artifacts[0]!.size_in_bytes = 1;
      },
      "digest or size"
    ],
    [
      "artifact malformed digest",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.includes("/artifacts?"))!;
        (api[key] as { artifacts: Array<Record<string, unknown>> }).artifacts[0]!.digest = "bad";
      },
      "artifact is expired"
    ],
    [
      "verifier run path",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.endsWith("/actions/runs/888"))!;
        (api[key] as Record<string, unknown>).path = "other.yml";
      },
      "trusted verifier run provenance"
    ],
    [
      "triggering run event",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.endsWith("/actions/runs/777"))!;
        (api[key] as Record<string, unknown>).event = "push";
      },
      "triggering run provenance"
    ],
    [
      "triggering run head",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.endsWith("/actions/runs/777"))!;
        (api[key] as Record<string, unknown>).head_sha = "e".repeat(40);
      },
      "triggering run provenance"
    ],
    [
      "triggering PR association",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.endsWith("/actions/runs/777"))!;
        (api[key] as { pull_requests: Array<Record<string, unknown>> }).pull_requests[0]!.id = 9002;
      },
      "pull request association"
    ],
    [
      "trusted contents encoding",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.includes(`/contents/${WORKFLOW_PATH}?`))!;
        (api[key] as Record<string, unknown>).encoding = "utf-8";
      },
      "trusted workflow digest"
    ],
    [
      "trusted contents digest",
      (api: Record<string, unknown>) => {
        const key = Object.keys(api).find((item) => item.includes(`/contents/${WORKFLOW_PATH}?`))!;
        (api[key] as Record<string, unknown>).content = "AAAA";
      },
      "trusted workflow digest"
    ]
  ])("rejects %s provenance/artifact state without invoking merge", (name, mutate, expected) => {
    const fixture = validControlFixture();
    const api = JSON.parse(process.env.SCWBS_TEST_GH_API!) as Record<string, unknown>;
    mutate(api);
    process.env.SCWBS_TEST_GH_API = JSON.stringify(api);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], fixture.root)).toBe(1);
      const report = JSON.parse(output.join(""));
      expect(report.status).toBe("blocked");
      expect(report.violations.some((violation: { message: string }) => violation.message.includes(expected))).toBe(
        true
      );
      expect(readFileSync(fixture.fake.log, "utf8")).not.toContain("pr merge");
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test.each([
    [
      "duplicate changed files",
      "files",
      {
        changed_files: 2,
        files: [
          { filename: ".github/workflows/scwbs.yml", status: "modified", sha: "c".repeat(40) },
          { filename: ".github/workflows/scwbs.yml", status: "modified", sha: "d".repeat(40) }
        ]
      }
    ],
    [
      "ambiguous workflow-integrity checks",
      "check_runs",
      {
        changed_files: 1,
        files: [{ filename: ".github/workflows/scwbs.yml", status: "modified", sha: "c".repeat(40) }],
        checks: { total_count: 2, check_runs: [{ name: "workflow-integrity" }, { name: "workflow-integrity" }] }
      }
    ]
  ])("rejects %s before invoking merge", (_name, _kind, fixture) => {
    const root = makeTempRepo();
    const fake = installFakeGh(root);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      process.env.SCWBS_TEST_GH_VIEW = JSON.stringify(successfulView());
      const changed = fixture.changed_files;
      const files = fixture.files;
      const api: Record<string, unknown> = {
        "repos/xmeta/ACED/pulls/42": {
          number: 42,
          id: 9001,
          state: "open",
          changed_files: changed,
          base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "xmeta/ACED" } },
          head: { ref: "feature", sha: HEAD, repo: { full_name: "xmeta/ACED" } }
        },
        "repos/xmeta/ACED/pulls/42/files?per_page=100&page=1": files
      };
      const checks = "checks" in fixture ? fixture.checks : undefined;
      if (checks)
        api[
          `repos/xmeta/ACED/commits/${HEAD}/check-runs?check_name=workflow-integrity&filter=all&per_page=100&page=1`
        ] = checks;
      else
        api[
          `repos/xmeta/ACED/commits/${HEAD}/check-runs?check_name=workflow-integrity&filter=all&per_page=100&page=1`
        ] = { total_count: 0, check_runs: [] };
      process.env.SCWBS_TEST_GH_API = JSON.stringify(api);
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], root)).toBe(1);
      expect(JSON.parse(output.join(""))).toMatchObject({ status: "blocked" });
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
      const schema = JSON.parse(
        readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/merge-preflight.schema.json"), "utf8")
      );
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
      const unavailable = JSON.parse(output.pop()!);
      expect(unavailable).toMatchObject({
        status: "blocked",
        violations: [{ code: "merge.github.unavailable" }]
      });
      expect(unavailable.violations[0].message).toContain("doctor --github");
      const schema = JSON.parse(
        readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/merge-preflight.schema.json"), "utf8")
      );
      expect(new Ajv2020({ strict: false }).compile(schema)(unavailable)).toBe(true);

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

  test("passes a valid control PR with a trusted descriptor ZIP and committed metadata descendant", () => {
    const fixture = validControlFixture();
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--json"], fixture.root)).toBe(0);
      const report = JSON.parse(output.join(""));
      expectMergeReportSchema(report);
      expect(report).toMatchObject({
        status: "pass",
        headCommit: fixture.head,
        workflowTrust: { status: "verified", controlFiles: [WORKFLOW_PATH] },
        execution: { executed: true }
      });
      expect(readFileSync(fixture.fake.log, "utf8")).toContain("api repos/xmeta/ACED/actions/artifacts/999/zip");
      expect(readFileSync(fixture.fake.log, "utf8")).toContain("pr merge 42");
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test("accepts GitHub's canonical check-run /runs/{check.id} details URL", () => {
    const fixture = validControlFixture();
    const api = JSON.parse(process.env.SCWBS_TEST_GH_API!) as Record<string, unknown>;
    const key = Object.keys(api).find((item) => item.includes("check-runs?"))!;
    const check = (api[key] as { check_runs: Array<Record<string, unknown>> }).check_runs[0]!;
    check.id = 99352861563;
    check.details_url = `https://github.com/${REPOSITORY}/runs/99352861563`;
    process.env.SCWBS_TEST_GH_API = JSON.stringify(api);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--json"], fixture.root)).toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({ status: "pass", execution: { executed: true } });
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test.each([
    ["noncanonical repository", 99352861563, `https://github.com/other/repo/runs/99352861563`],
    ["missing check id", undefined, `https://github.com/${REPOSITORY}/runs/99352861563`],
    ["missing check id and details URL", undefined, undefined],
    ["query suffix", 99352861563, `https://github.com/${REPOSITORY}/runs/99352861563?foo=bar`]
  ])("rejects a %s details URL", (_name, id, detailsUrl) => {
    const fixture = validControlFixture();
    const api = JSON.parse(process.env.SCWBS_TEST_GH_API!) as Record<string, unknown>;
    const key = Object.keys(api).find((item) => item.includes("check-runs?"))!;
    const check = (api[key] as { check_runs: Array<Record<string, unknown>> }).check_runs[0]!;
    if (id === undefined) delete check.id;
    else check.id = id;
    check.details_url = detailsUrl;
    process.env.SCWBS_TEST_GH_API = JSON.stringify(api);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], fixture.root)).toBe(1);
      expect(JSON.parse(output.join("")).violations[0].message).toContain("check or receipt provenance");
      expect(readFileSync(fixture.fake.log, "utf8")).not.toContain("pr merge");
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test("accepts a fork head when the triggering run has no pull request association", () => {
    const fixture = validControlFixture();
    const api = JSON.parse(process.env.SCWBS_TEST_GH_API!) as Record<string, unknown>;
    const pull = api["repos/xmeta/ACED/pulls/42"] as Record<string, unknown>;
    (pull.head as Record<string, unknown>).repo = { full_name: "contributor/ACED" };
    const run = api["repos/xmeta/ACED/actions/runs/777"] as Record<string, unknown>;
    run.head_repository = { full_name: "contributor/ACED" };
    run.pull_requests = [];
    process.env.SCWBS_TEST_GH_API = JSON.stringify(api);
    mutateReceiptFixture(fixture, (receipt) => {
      (receipt.triggeringRun as Record<string, unknown>).headRepository = "contributor/ACED";
    });
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      const result = main(["merge", "--pr", "42", "--json"], fixture.root);
      expect(result).toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({ status: "pass", execution: { executed: true } });
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test("rejects a fork run whose head repository disagrees with the PR", () => {
    const fixture = validControlFixture();
    const api = JSON.parse(process.env.SCWBS_TEST_GH_API!) as Record<string, unknown>;
    const pull = api["repos/xmeta/ACED/pulls/42"] as Record<string, unknown>;
    (pull.head as Record<string, unknown>).repo = { full_name: "contributor/ACED" };
    process.env.SCWBS_TEST_GH_API = JSON.stringify(api);
    mutateReceiptFixture(fixture, (receipt) => {
      (receipt.triggeringRun as Record<string, unknown>).headRepository = "contributor/ACED";
    });
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], fixture.root)).toBe(1);
      expect(JSON.parse(output.join(""))).toMatchObject({ status: "blocked" });
      expect(JSON.parse(output.join("")).violations[0].message).toContain("triggering run provenance");
      expect(readFileSync(fixture.fake.log, "utf8")).not.toContain("pr merge");
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test("reaches the Human Gate for a literal [audit].yml filename despite an approved scope mismatch", () => {
    const fixture = validControlFixture();
    const badApproval = sampleApproval({
      status: "approved",
      approvedBy: "Human Reviewer",
      approvedAt: "2026-08-31T00:00:00.000Z",
      headCommit: "0".repeat(40),
      diffHash: `sha256:${"0".repeat(64)}`,
      pullRequest: "#42"
    });
    writeYaml(fixture.root, "contracts/approvals/WBS-001-004.yaml", badApproval as unknown as Record<string, unknown>);
    const head = commitAll(fixture.root, "approval scope mismatch");
    rebindHeadFixture(fixture, head);
    const api = JSON.parse(process.env.SCWBS_TEST_GH_API!) as Record<string, unknown>;
    const filesKey = Object.keys(api).find((item) => item.includes("/pulls/42/files?"))!;
    const files = api[filesKey] as Array<Record<string, unknown>>;
    files[0]!.filename = ".github/workflows/[audit].yml";
    process.env.SCWBS_TEST_GH_API = JSON.stringify(api);
    mutateReceiptFixture(fixture, (receipt) => {
      const surface = receipt.controlSurface as Record<string, unknown>;
      const observed = surface.controlFiles as Array<Record<string, unknown>>;
      observed[0]!.file = ".github/workflows/[audit].yml";
      surface.observedDigest = digest(JSON.stringify(observed));
    });
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], fixture.root)).toBe(1);
      const report = JSON.parse(output.join(""));
      expect(report.violations[0].message).toContain("approved headCommit");
      expect(readFileSync(fixture.fake.log, "utf8")).not.toContain("pr merge");
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test.each([
    [
      "rename chain",
      [
        { filename: ".github/workflows/next.yml", previous_filename: WORKFLOW_PATH },
        { filename: ".github/workflows/final.yml", previous_filename: ".github/workflows/next.yml" }
      ]
    ],
    [
      "rename swap",
      [
        { filename: ".github/workflows/next.yml", previous_filename: WORKFLOW_PATH },
        { filename: WORKFLOW_PATH, previous_filename: ".github/workflows/next.yml" }
      ]
    ]
  ])("accepts a %s with overlapping previous filenames", (_name, chain) => {
    const fixture = validControlFixture();
    const api = JSON.parse(process.env.SCWBS_TEST_GH_API!) as Record<string, unknown>;
    const filesKey = Object.keys(api).find((item) => item.includes("/pulls/42/files?"))!;
    const original = JSON.parse(fixture.receipt.toString("utf8")) as Record<string, unknown>;
    const originalBlob = (
      (original.controlSurface as Record<string, unknown>).controlFiles as Array<Record<string, unknown>>
    )[0]!.headBlobSha as string;
    const renameFiles = chain.map(({ filename, previous_filename }) => ({
      filename,
      previous_filename,
      status: "renamed",
      sha: originalBlob
    }));
    api[filesKey] = renameFiles;
    const observations = renameFiles
      .flatMap((file) => [
        {
          file: file.filename,
          kind: "workflow",
          role: "current",
          counterpart: file.previous_filename,
          status: "renamed",
          headBlobSha: originalBlob,
          previousBlobSha: null
        },
        {
          file: file.previous_filename,
          kind: "workflow",
          role: "previous",
          counterpart: file.filename,
          status: "renamed",
          headBlobSha: null,
          previousBlobSha: null
        }
      ])
      .sort((left, right) => left.file.localeCompare(right.file) || left.kind.localeCompare(right.kind));
    const changed = api["repos/xmeta/ACED/pulls/42"] as Record<string, unknown>;
    changed.changed_files = renameFiles.length;
    process.env.SCWBS_TEST_GH_API = JSON.stringify(api);
    mutateReceiptFixture(fixture, (receipt) => {
      const surface = receipt.controlSurface as Record<string, unknown>;
      surface.controlFiles = observations;
      surface.observedDigest = digest(JSON.stringify(observations));
    });
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      const result = main(["merge", "--pr", "42", "--json"], fixture.root);
      expect(result).toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({ status: "pass", execution: { executed: true } });
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test("accepts two-page check-runs and artifact responses with exact total counts", () => {
    const fixture = validControlFixture();
    const api = JSON.parse(process.env.SCWBS_TEST_GH_API!) as Record<string, unknown>;
    const checkKey = Object.keys(api).find((item) => item.includes("check-runs?"))!;
    const checkPage = api[checkKey] as { total_count: number; check_runs: Array<Record<string, unknown>> };
    const expectedCheck = checkPage.check_runs[0]!;
    checkPage.total_count = 101;
    checkPage.check_runs = Array.from({ length: 100 }, (_, index) => ({ name: `unmanaged-${index}` }));
    api[checkKey.replace(/&page=1$/, "&page=2")] = { total_count: 101, check_runs: [expectedCheck] };
    const artifactKey = Object.keys(api).find((item) => item.includes("/artifacts?"))!;
    const artifactPage = api[artifactKey] as { total_count: number; artifacts: Array<Record<string, unknown>> };
    const expectedArtifact = artifactPage.artifacts[0]!;
    artifactPage.total_count = 101;
    artifactPage.artifacts = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `unmanaged-${index}`,
      expired: false,
      size_in_bytes: 1,
      workflow_run: { id: 888 },
      digest: `sha256:${"0".repeat(64)}`
    }));
    api[artifactKey.replace(/&page=1$/, "&page=2")] = { total_count: 101, artifacts: [expectedArtifact] };
    process.env.SCWBS_TEST_GH_API = JSON.stringify(api);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      const result = main(["merge", "--pr", "42", "--json"], fixture.root);
      expect(result).toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({ status: "pass", execution: { executed: true } });
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test.each(["check-runs", "artifacts"])("rejects %s total_count beyond the bounded page domain", (kind) => {
    const fixture = validControlFixture();
    const api = JSON.parse(process.env.SCWBS_TEST_GH_API!) as Record<string, unknown>;
    const key = Object.keys(api).find((item) => item.includes(kind === "check-runs" ? "check-runs?" : "/artifacts?"))!;
    (api[key] as Record<string, unknown>).total_count = 257;
    process.env.SCWBS_TEST_GH_API = JSON.stringify(api);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], fixture.root)).toBe(1);
      const report = JSON.parse(output.join(""));
      expect(report.violations[0].message).toContain("total_count is invalid or exceeds the bound");
      expect(readFileSync(fixture.fake.log, "utf8")).not.toContain("pr merge");
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test.each([
    [
      "missing artifact",
      (api: Record<string, unknown>) => {
        api["repos/xmeta/ACED/actions/runs/888/artifacts?per_page=100&page=1"] = { total_count: 0, artifacts: [] };
      },
      "artifact is missing"
    ],
    [
      "expired artifact",
      (api: Record<string, unknown>) => {
        (
          api["repos/xmeta/ACED/actions/runs/888/artifacts?per_page=100&page=1"] as {
            artifacts: Array<Record<string, unknown>>;
          }
        ).artifacts[0]!.expired = true;
      },
      "artifact is expired"
    ],
    [
      "artifact digest mismatch",
      (api: Record<string, unknown>) => {
        (
          api["repos/xmeta/ACED/actions/runs/888/artifacts?per_page=100&page=1"] as {
            artifacts: Array<Record<string, unknown>>;
          }
        ).artifacts[0]!.digest = `sha256:${"0".repeat(64)}`;
      },
      "digest or size"
    ],
    [
      "summary mismatch",
      (api: Record<string, unknown>) => {
        const checks = api[
          `repos/xmeta/ACED/commits/${api.__head as string}/check-runs?check_name=workflow-integrity&filter=all&per_page=100&page=1`
        ] as { check_runs: Array<Record<string, unknown>> };
        (checks.check_runs[0]!.output as Record<string, unknown>).summary = "{}\n";
        delete api.__head;
      },
      "GitHub API returned invalid JSON"
    ],
    [
      "summary bytes mismatch after valid locator",
      (api: Record<string, unknown>) => {
        const checks = api[
          `repos/xmeta/ACED/commits/${api.__head as string}/check-runs?check_name=workflow-integrity&filter=all&per_page=100&page=1`
        ] as { check_runs: Array<Record<string, unknown>> };
        const pull = api["repos/xmeta/ACED/pulls/42"] as {
          base: { sha: string };
        };
        (checks.check_runs[0]!.output as Record<string, unknown>).summary = JSON.stringify({
          verifier: { runId: 888, definitionCommit: pull.base.sha },
          triggeringRun: { id: 777 },
          locatorOnly: true
        });
        delete api.__head;
      },
      "summary does not match artifact bytes"
    ],
    [
      "malformed artifact ZIP",
      (api: Record<string, unknown>) => {
        delete api.__head;
      },
      "not a ZIP archive"
    ],
    [
      "wrong receipt filename",
      (api: Record<string, unknown>) => {
        delete api.__head;
      },
      "entry is unsafe"
    ],
    [
      "extra ZIP entry",
      (api: Record<string, unknown>) => {
        delete api.__head;
      },
      "unsupported bounds"
    ],
    [
      "symlink ZIP entry",
      (api: Record<string, unknown>) => {
        delete api.__head;
      },
      "entry is unsafe"
    ]
  ])("rejects %s without invoking merge", (name, mutate, expected) => {
    const fixture = validControlFixture();
    const api = JSON.parse(process.env.SCWBS_TEST_GH_API!) as Record<string, unknown>;
    if (name.includes("summary")) api.__head = fixture.head;
    mutate(api);
    delete api.__head;
    process.env.SCWBS_TEST_GH_API = JSON.stringify(api);
    if (name.includes("ZIP") || name === "wrong receipt filename") {
      const malformed =
        name === "malformed artifact ZIP"
          ? Buffer.from("not-a-zip")
          : descriptorZip(fixture.receipt, {
              name: name === "wrong receipt filename" ? "wrong.json" : undefined,
              extraEntries: name === "extra ZIP entry",
              symlink: name === "symlink ZIP entry"
            });
      process.env.SCWBS_TEST_GH_ZIP = malformed.toString("base64");
      const artifact = (
        api["repos/xmeta/ACED/actions/runs/888/artifacts?per_page=100&page=1"] as {
          artifacts: Array<Record<string, unknown>>;
        }
      ).artifacts[0]!;
      artifact.size_in_bytes = malformed.length;
      artifact.digest = digest(malformed);
      process.env.SCWBS_TEST_GH_API = JSON.stringify(api);
    }
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], fixture.root)).toBe(1);
      const report = JSON.parse(output.join(""));
      expect(report).toMatchObject({ status: "blocked" });
      expect(report.violations.some((violation: { message: string }) => violation.message.includes(expected))).toBe(
        true
      );
      expect(readFileSync(fixture.fake.log, "utf8")).not.toContain("pr merge");
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test.each([
    [
      "CRC mismatch",
      (archive: Buffer) => archive.writeUInt32LE(0, archive.readUInt32LE(archive.length - 22 + 16) + 16),
      "data descriptor"
    ],
    [
      "unsupported method",
      (archive: Buffer) => {
        archive.writeUInt16LE(12, 8);
        archive.writeUInt16LE(12, archive.readUInt32LE(archive.length - 22 + 16) + 10);
      },
      "entry is unsafe"
    ],
    [
      "encrypted entry",
      (archive: Buffer) => {
        archive.writeUInt16LE(0x9, 6);
        archive.writeUInt16LE(0x9, archive.readUInt32LE(archive.length - 22 + 16) + 8);
      },
      "entry is unsafe"
    ],
    [
      "ZIP64 sentinel",
      (archive: Buffer) => archive.writeUInt32LE(0xffffffff, archive.readUInt32LE(archive.length - 22 + 16) + 20),
      "entry is unsafe"
    ],
    ["uncompressed receipt bound", () => descriptorZip(Buffer.alloc(33 * 1024)), "decompression failed"]
  ])("rejects a ZIP with %s", (_name, mutate, expected) => {
    const fixture = validControlFixture();
    let archive: Buffer;
    if (_name === "uncompressed receipt bound") archive = descriptorZip(Buffer.alloc(33 * 1024));
    else {
      archive = descriptorZip(fixture.receipt);
      mutate(archive);
    }
    replaceArtifactZip(fixture, archive);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], fixture.root)).toBe(1);
      const report = JSON.parse(output.join(""));
      expect(report.violations[0].message).toContain(expected);
      expect(readFileSync(fixture.fake.log, "utf8")).not.toContain("pr merge");
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test.each([
    [
      "receipt repository",
      (receipt: Record<string, unknown>) => {
        receipt.repository = "other/repo";
      },
      "check or receipt provenance"
    ],
    [
      "receipt PR",
      (receipt: Record<string, unknown>) => {
        receipt.pullRequest = 41;
      },
      "check or receipt provenance"
    ],
    [
      "receipt base",
      (receipt: Record<string, unknown>) => {
        receipt.baseCommit = "c".repeat(40);
      },
      "check or receipt provenance"
    ],
    [
      "receipt head",
      (receipt: Record<string, unknown>) => {
        receipt.headCommit = "d".repeat(40);
      },
      "check or receipt provenance"
    ],
    [
      "receipt manifest digest",
      (receipt: Record<string, unknown>) => {
        (receipt.controlSurface as Record<string, unknown>).manifestDigest = `sha256:${"0".repeat(64)}`;
      },
      "control observation"
    ],
    [
      "receipt observed digest",
      (receipt: Record<string, unknown>) => {
        (receipt.controlSurface as Record<string, unknown>).observedDigest = `sha256:${"0".repeat(64)}`;
      },
      "control observation"
    ],
    [
      "receipt verifier path",
      (receipt: Record<string, unknown>) => {
        (receipt.verifier as Record<string, unknown>).workflowPath = "other.yml";
      },
      "verifier receipt"
    ],
    [
      "receipt triggering path",
      (receipt: Record<string, unknown>) => {
        (receipt.triggeringRun as Record<string, unknown>).workflowPath = "other.yml";
      },
      "triggering run provenance"
    ]
  ])("rejects %s without invoking merge", (name, mutate, expected) => {
    const fixture = validControlFixture();
    mutateReceiptFixture(fixture, mutate);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], fixture.root)).toBe(1);
      const report = JSON.parse(output.join(""));
      expect(report.status).toBe("blocked");
      expect(report.violations.some((violation: { message: string }) => violation.message.includes(expected))).toBe(
        true
      );
      expect(readFileSync(fixture.fake.log, "utf8")).not.toContain("pr merge");
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test("rejects a trusted contents response with non-base64 encoding", () => {
    const fixture = validControlFixture();
    const api = JSON.parse(process.env.SCWBS_TEST_GH_API!) as Record<string, unknown>;
    const key = Object.keys(api).find((item) => item.includes(`/contents/${WORKFLOW_PATH}?`))!;
    (api[key] as Record<string, unknown>).encoding = "utf-8";
    process.env.SCWBS_TEST_GH_API = JSON.stringify(api);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], fixture.root)).toBe(1);
      expect(JSON.parse(output.join("")).violations[0].message).toContain("trusted workflow digest");
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test.each([
    ["requested Approval", { approvalStatus: "requested" as const }, "Human Approval must be an approved"],
    ["rejected Approval", { approvalStatus: "rejected" as const }, "Human Approval must be an approved"],
    ["legacy unbound Approval", { unboundApproval: true }, "Human Approval must be an approved"],
    [
      "Approval without pullRequest",
      { omitApprovalField: "pullRequest" as const },
      "Human Approval must be an approved"
    ],
    ["Approval without headCommit", { omitApprovalField: "headCommit" as const }, "Human Approval must be an approved"],
    ["Approval without diffHash", { omitApprovalField: "diffHash" as const }, "Human Approval must be an approved"]
  ])("rejects %s control gate without invoking merge", (name, options, expected) => {
    const fixture = validControlFixture(options);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], fixture.root)).toBe(1);
      const report = JSON.parse(output.join(""));
      expect(report.status).toBe("blocked");
      expect(report.violations.some((violation: { message: string }) => violation.message.includes(expected))).toBe(
        true
      );
      expect(readFileSync(fixture.fake.log, "utf8")).not.toContain("pr merge");
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test("accepts the human-gate slot from an approved v2 bundle with post-finish activeScope", () => {
    const fixture = validControlFixture({ v2Approval: true });
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--json"], fixture.root)).toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({ status: "pass", execution: { executed: true } });
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test.each([
    ["pullRequest", "Human Approval must be an approved"],
    ["headCommit", "approved headCommit"],
    ["diffHash", "approved diffHash"]
  ] as const)("rejects a v2 human-gate slot with %s drift", (field, expected) => {
    const fixture = validControlFixture({ v2ApprovalMismatch: field });
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], fixture.root)).toBe(1);
      const report = JSON.parse(output.join(""));
      expect(report.status).toBe("blocked");
      expect(report.violations[0].message).toContain(expected);
      expect(readFileSync(fixture.fake.log, "utf8")).not.toContain("pr merge");
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test("rejects legacy-recorded Evidence with an unbound approved record", () => {
    const fixture = validControlFixture({ unboundApproval: true, legacyEvidence: true });
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], fixture.root)).toBe(1);
      expect(JSON.parse(output.join("")).violations[0].message).toContain("Human Approval must be an approved");
      expect(readFileSync(fixture.fake.log, "utf8")).not.toContain("pr merge");
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test("rejects an uncommitted Task/Evidence candidate before selecting Approval scope", () => {
    const fixture = validControlFixture();
    writeText(fixture.root, "contracts/evidence/WBS-001-004.yaml", "tampered\n");
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], fixture.root)).toBe(1);
      const report = JSON.parse(output.join(""));
      expect(
        report.violations.some((violation: { message: string }) => violation.message.includes("uncommitted metadata"))
      ).toBe(true);
      expect(readFileSync(fixture.fake.log, "utf8")).not.toContain("pr merge");
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test.each([
    [
      "non-lifecycle descendant",
      (root: string) => writeText(root, "README.md", "unrelated descendant\n"),
      "non-lifecycle"
    ],
    [
      "Evidence diffHash mismatch",
      (root: string, subject: string) => {
        const bad = `sha256:${"0".repeat(64)}`;
        writeYaml(
          root,
          "contracts/evidence/WBS-001-004.yaml",
          sampleEvidence({
            changedFiles: [WORKFLOW_PATH],
            subjectHeadCommit: subject,
            diffHash: bad,
            git: {
              branch: "feature",
              base: "main",
              headCommit: subject,
              pullRequest: "#42",
              subjectHeadCommit: subject,
              diffHash: bad
            }
          }) as unknown as Record<string, unknown>
        );
      },
      "diffHash does not match"
    ],
    [
      "Evidence PR mismatch",
      (root: string, subject: string) => {
        writeYaml(
          root,
          "contracts/evidence/WBS-001-004.yaml",
          sampleEvidence({
            changedFiles: [WORKFLOW_PATH],
            subjectHeadCommit: subject,
            diffHash: `sha256:${"0".repeat(64)}`,
            git: {
              branch: "feature",
              base: "main",
              headCommit: subject,
              pullRequest: "#99",
              subjectHeadCommit: subject,
              diffHash: `sha256:${"0".repeat(64)}`
            }
          }) as unknown as Record<string, unknown>
        );
      },
      "exactly one Task Evidence"
    ]
  ])("rejects an Evidence %s", (_name, mutate, expected) => {
    const fixture = validControlFixture();
    const subject = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: fixture.root, encoding: "utf8" }).trim();
    mutate(fixture.root, subject);
    const head = commitAll(fixture.root, "metadata or unrelated descendant");
    rebindHeadFixture(fixture, head);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], fixture.root)).toBe(1);
      const report = JSON.parse(output.join(""));
      expect(report.status).toBe("blocked");
      expect(report.violations.some((violation: { message: string }) => violation.message.includes(expected))).toBe(
        true
      );
      expect(readFileSync(fixture.fake.log, "utf8")).not.toContain("pr merge");
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test("rejects ambiguous Task/Evidence candidates for one control PR", () => {
    const fixture = validControlFixture();
    const subject = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: fixture.root, encoding: "utf8" }).trim();
    const second = sampleTask({ id: "WBS-001-005", humanGateRequiredPaths: [] });
    writeYaml(fixture.root, "contracts/tasks/WBS-001-005.yaml", second as unknown as Record<string, unknown>);
    writeYaml(
      fixture.root,
      "contracts/evidence/WBS-001-005.yaml",
      sampleEvidence({
        id: "EVD-001-005",
        taskId: "WBS-001-005",
        changedFiles: [WORKFLOW_PATH],
        subjectHeadCommit: subject,
        diffHash: `sha256:${"0".repeat(64)}`,
        git: { branch: "feature", base: "main", headCommit: subject, pullRequest: "#42" }
      }) as unknown as Record<string, unknown>
    );
    const head = commitAll(fixture.root, "second candidate");
    rebindHeadFixture(fixture, head);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], fixture.root)).toBe(1);
      expect(JSON.parse(output.join("")).violations[0].message).toContain("exactly one Task Evidence");
      expect(readFileSync(fixture.fake.log, "utf8")).not.toContain("pr merge");
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });

  test("rejects a deleted candidate before a second Task can hide the ambiguity", () => {
    const fixture = validControlFixture();
    const subject = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: fixture.root, encoding: "utf8" }).trim();
    writeYaml(
      fixture.root,
      "contracts/tasks/WBS-001-005.yaml",
      sampleTask({ id: "WBS-001-005", humanGateRequiredPaths: [] }) as unknown as Record<string, unknown>
    );
    writeYaml(
      fixture.root,
      "contracts/evidence/WBS-001-005.yaml",
      sampleEvidence({
        id: "EVD-001-005",
        taskId: "WBS-001-005",
        changedFiles: [WORKFLOW_PATH],
        subjectHeadCommit: subject,
        git: { branch: "feature", base: "main", headCommit: subject, pullRequest: "#42" }
      }) as unknown as Record<string, unknown>
    );
    const head = commitAll(fixture.root, "second candidate");
    rebindHeadFixture(fixture, head);
    execFileSync("git", ["rm", "contracts/evidence/WBS-001-005.yaml"], { cwd: fixture.root, stdio: "ignore" });
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["merge", "--pr", "42", "--preflight-only", "--json"], fixture.root)).toBe(1);
      expect(JSON.parse(output.join("")).violations[0].message).toContain("uncommitted metadata");
      expect(readFileSync(fixture.fake.log, "utf8")).not.toContain("pr merge");
    } finally {
      log.mockRestore();
      fixture.fake.restore();
    }
  });
});
