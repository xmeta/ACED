import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, test } from "vitest";

const DELEGATION_TOKEN_ENV = "SCWBS_APPROVAL_DELEGATION_TOKEN";
const workflow = readFileSync(path.join(process.cwd(), ".github/workflows/scwbs.yml"), "utf8");
const reporterWorkflow = readFileSync(
  path.join(process.cwd(), ".github/workflows/scwbs-readiness-reporter.yml"),
  "utf8"
);
const integrityWorkflow = readFileSync(
  path.join(process.cwd(), ".github/workflows/scwbs-workflow-integrity.yml"),
  "utf8"
);
const setupAction = readFileSync(path.join(process.cwd(), ".github/actions/setup-toolchain/action.yml"), "utf8");
const integrityDocument = load(integrityWorkflow) as {
  on: { workflow_run: { workflows: string[]; types: string[] } };
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: { receipt: { steps: Array<{ with?: { script?: string } }> } };
};
const [receiptStep, , publishStep] = integrityDocument.jobs.receipt.steps;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;
type MockCheck = {
  id: number;
  name: string;
  app: { slug: string };
  external_id?: string;
  details_url?: string;
};

function receiptScript(): (...args: unknown[]) => Promise<unknown> {
  return new AsyncFunction("github", "context", "core", "require", "process", "Buffer", receiptStep.with!.script!);
}

function publishScript(): (...args: unknown[]) => Promise<unknown> {
  return new AsyncFunction("github", "context", "core", "require", "process", "Buffer", publishStep.with!.script!);
}

function pull(
  head = "h".repeat(40),
  base = "b".repeat(40),
  changedFiles = 0,
  headRepository = "fork/ACED",
  headRef = "feature"
) {
  return {
    id: 420,
    number: 42,
    state: "open",
    head: { sha: head, repo: { full_name: headRepository }, ref: headRef },
    base: { sha: base, ref: "main", repo: { full_name: "xmeta/ACED" } },
    changed_files: changedFiles
  };
}

function runReceipt(
  options: {
    associated?: Array<{ number: number }>;
    files?: Array<Record<string, unknown>>;
    pulls?: Array<ReturnType<typeof pull>>;
    error?: Error;
  } = {}
) {
  const files = options.files ?? [];
  const pulls = [
    ...(options.pulls ?? [
      pull("h".repeat(40), "b".repeat(40), files.length),
      pull("h".repeat(40), "b".repeat(40), files.length),
      pull("h".repeat(40), "b".repeat(40), files.length)
    ])
  ];
  const written = new Map<string, string>();
  const outputs = new Map<string, string>();
  const method = () => undefined;
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async () => {
          if (options.error) throw options.error;
          return {
            data: {
              id: 7,
              event: "pull_request",
              conclusion: "success",
              path: ".github/workflows/scwbs.yml",
              head_sha: "h".repeat(40),
              head_repository: { full_name: "fork/ACED" },
              head_branch: "feature",
              pull_requests: [],
              html_url: "https://github.com/xmeta/ACED/actions/runs/7"
            }
          };
        }
      },
      repos: {
        listPullRequestsAssociatedWithCommit: method,
        getContent: async ({ path: filePath }: { path: string }) => ({
          data: { content: Buffer.from(filePath).toString("base64"), encoding: "base64" }
        })
      },
      pulls: {
        get: async () => ({ data: pulls.shift() ?? pull("h".repeat(40), "b".repeat(40), files.length) }),
        listFiles: async ({ page }: { page: number }) => ({ data: page === 1 ? files : [] })
      }
    },
    paginate: async (fn: unknown) => (fn === method ? (options.associated ?? [{ number: 42 }]) : [])
  };
  const context = {
    repo: { owner: "xmeta", repo: "ACED" },
    runId: 99,
    serverUrl: "https://github.com",
    sha: "v".repeat(40)
  };
  const core = { setOutput: (key: string, value: string) => outputs.set(key, value) };
  const requireMock = (name: string) =>
    name === "crypto" ? crypto : { writeFileSync: (file: string, value: string) => written.set(file, value) };
  return receiptScript()(github, context, core, requireMock, { env: { TRIGGERING_RUN_ID: "7" } }, Buffer).then(() => ({
    written,
    outputs,
    github
  }));
}

describe("workflow secret isolation", () => {
  test("same-repository and fork pull requests never expose the delegation token to CI code", () => {
    // Both event types execute repository-controlled code. Forks normally do not receive secrets,
    // but the same-repository case must remain safe if the secret is configured for the workflow.
    expect(workflow).not.toContain(DELEGATION_TOKEN_ENV);
    expect(setupAction).not.toContain(DELEGATION_TOKEN_ENV);
  });

  test("PR-head code cannot read the delegation token from process.env", () => {
    const prCodeEnv = { ...process.env };
    delete prCodeEnv[DELEGATION_TOKEN_ENV];
    const observed = execFileSync(
      process.execPath,
      ["-e", `process.stdout.write(process.env[${JSON.stringify(DELEGATION_TOKEN_ENV)}] ?? "")`],
      { env: prCodeEnv, encoding: "utf8" }
    );

    expect(observed).toBe("");
  });

  test("readiness reporting is isolated to the trusted workflow_run reporter", () => {
    expect(workflow).not.toContain("\n  workflow_run:");
    expect(workflow).not.toContain("readiness-reporter:");
    expect(reporterWorkflow).toContain("workflow_run:");
    expect(reporterWorkflow).toContain("readiness-reporter:");
    expect(reporterWorkflow).toContain("pull-requests: write");
    const reporter = reporterWorkflow;
    expect(reporter).not.toContain("actions/checkout@");
    expect(reporter).toContain("actions/download-artifact@");
    expect(reporter).toContain("scwbs-pr-readiness-v1");
    expect(reporter).toContain("does not create Approval, Review, or merge transitions");
    expect(reporter).toContain("updateComment");
    expect(reporter).toContain("createComment");
  });

  test("pull_request execution retains read-only workflow permissions", () => {
    expect(workflow).toContain("permissions:\n  contents: read\n  checks: read\n  actions: read");
    expect(workflow).not.toContain("SCWBS_APPROVAL_DELEGATION_TOKEN");
  });

  test("workflow integrity has an exact trusted trigger, least permissions, and serialized head scope", () => {
    expect(integrityDocument.on.workflow_run).toEqual({ workflows: ["scwbs"], types: ["completed"] });
    expect(integrityDocument.permissions).toEqual({
      actions: "read",
      checks: "write",
      contents: "read",
      "pull-requests": "read"
    });
    expect(integrityDocument.concurrency).toEqual({
      group: "scwbs-workflow-integrity-${{ github.event.workflow_run.head_sha }}",
      "cancel-in-progress": false
    });
    expect(integrityWorkflow).not.toContain("actions/checkout@");
    expect(integrityWorkflow).not.toContain(DELEGATION_TOKEN_ENV);
    expect(integrityWorkflow).not.toContain("secrets.");
  });

  test("receipt script emits a deterministic bounded success receipt", async () => {
    const { written, outputs } = await runReceipt({
      files: [
        { filename: "scripts-evil/ci-helper.mjs", status: "modified", sha: "d".repeat(40) },
        { filename: "scripts/ci-helper.mjs", status: "modified", sha: "c".repeat(40) }
      ]
    });
    const receipt = JSON.parse(written.get("workflow-integrity-receipt.json")!);
    expect(outputs.get("artifact_name")).toBe("scwbs-workflow-integrity-v1-7");
    expect(receipt).toMatchObject({
      type: "scwbs.workflow-integrity.v1",
      trustedWorkflow: { path: ".github/workflows/scwbs.yml" },
      verifier: {
        workflowPath: ".github/workflows/scwbs-workflow-integrity.yml",
        sha256: expect.stringMatching(/^sha256:/)
      },
      controlSurface: {
        manifestDigest: expect.stringMatching(/^sha256:/),
        observedDigest: expect.stringMatching(/^sha256:/)
      }
    });
    expect(receipt.controlSurface.controlFiles).toEqual([
      {
        file: "scripts/ci-helper.mjs",
        kind: "ci-runner",
        role: "current",
        counterpart: null,
        status: "modified",
        headBlobSha: "c".repeat(40),
        previousBlobSha: null
      }
    ]);
  });

  test("receipt script fails closed for ambiguous association, API failure, and stale PR state", async () => {
    await expect(runReceipt({ associated: [] })).rejects.toThrow(/exactly one matching/);
    await expect(runReceipt({ associated: [{ number: 42 }, { number: 43 }] })).rejects.toThrow(/exactly one matching/);
    await expect(runReceipt({ error: new Error("API unavailable") })).rejects.toThrow("API unavailable");
    await expect(runReceipt({ pulls: [pull(), pull(), pull("z".repeat(40))] })).rejects.toThrow(/changed while files/);
    await expect(
      runReceipt({ pulls: [pull("h".repeat(40), "b".repeat(40), 0, "other/ACED"), pull(), pull()] })
    ).rejects.toThrow(/exactly one matching/);
    await expect(
      runReceipt({ pulls: [pull("h".repeat(40), "b".repeat(40), 0, "fork/ACED", "other"), pull(), pull()] })
    ).rejects.toThrow(/exactly one matching/);
    await expect(runReceipt({ files: [{ filename: "scripts/missing-sha.mjs", status: "modified" }] })).rejects.toThrow(
      /valid blob SHA/
    );
  });

  test("receipt script records both sides of control-surface renames", async () => {
    const { written } = await runReceipt({
      files: [
        {
          filename: "docs/moved.md",
          previous_filename: ".github/workflows/old.yml",
          status: "renamed",
          sha: "d".repeat(40)
        },
        { filename: "src/cli.ts", previous_filename: "docs/old-cli.md", status: "renamed", sha: "e".repeat(40) }
      ]
    });
    const receipt = JSON.parse(written.get("workflow-integrity-receipt.json")!);
    expect(receipt.controlSurface.controlFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: ".github/workflows/old.yml",
          role: "previous",
          counterpart: "docs/moved.md",
          headBlobSha: null,
          previousBlobSha: null
        }),
        expect.objectContaining({
          file: "src/cli.ts",
          role: "current",
          counterpart: "docs/old-cli.md",
          headBlobSha: "e".repeat(40),
          previousBlobSha: null
        })
      ])
    );
  });

  test("receipt script records removed control files as previous observations", async () => {
    const { written } = await runReceipt({
      files: [{ filename: "scripts/removed.mjs", status: "removed", sha: "f".repeat(40) }]
    });
    const receipt = JSON.parse(written.get("workflow-integrity-receipt.json")!);
    expect(receipt.controlSurface.controlFiles).toEqual([
      {
        file: "scripts/removed.mjs",
        kind: "ci-runner",
        role: "previous",
        counterpart: null,
        status: "removed",
        headBlobSha: null,
        previousBlobSha: "f".repeat(40)
      }
    ]);
  });

  test("receipt script rejects changed-file and receipt bounds", async () => {
    const file = (index: number) => ({
      filename: `scripts/${String(index).padStart(3, "0")}.mjs`,
      status: "modified",
      sha: "a".repeat(40)
    });
    await expect(runReceipt({ files: Array.from({ length: 257 }, (_, index) => file(index)) })).rejects.toThrow(
      /changed-file limit exceeded/
    );
    await expect(
      runReceipt({
        files: [file(1)],
        pulls: [
          pull("h".repeat(40), "b".repeat(2), 2),
          pull("h".repeat(40), "b".repeat(2), 2),
          pull("h".repeat(40), "b".repeat(2), 2)
        ]
      })
    ).rejects.toThrow(/pagination is incomplete/);
    const oversized = Array.from({ length: 256 }, (_, index) => ({
      filename: `scripts/${String(index).padStart(3, "0")}-${"x".repeat(128)}.mjs`,
      status: "modified",
      sha: "a".repeat(40)
    }));
    await expect(runReceipt({ files: oversized })).rejects.toThrow(/receipt exceeds its bound/);
  });

  test("publish script uses all checks and rejects duplicate or unmanaged names", async () => {
    const receipt = JSON.stringify({
      type: "scwbs.workflow-integrity.v1",
      repository: "xmeta/ACED",
      pullRequest: 42,
      baseCommit: "b".repeat(40),
      headCommit: "h".repeat(40),
      triggeringRun: { id: 7 },
      verifier: { runUrl: "https://github.com/xmeta/ACED/actions/runs/99" }
    });
    const calls: Array<Record<string, unknown>> = [];
    let checkResponses: MockCheck[] = [];
    const listForRef = () => undefined;
    const github = {
      rest: {
        pulls: { get: async () => ({ data: pull("h".repeat(40), "b".repeat(40)) }) },
        checks: {
          listForRef,
          create: async (input: Record<string, unknown>) => calls.push(input),
          update: async (input: Record<string, unknown>) => calls.push(input)
        }
      },
      paginate: async (_fn: unknown, input: Record<string, unknown>) => {
        calls.push(input);
        return checkResponses;
      }
    };
    const requireMock = (name: string) => (name === "fs" ? { readFileSync: () => receipt } : {});
    await publishScript()(
      github,
      { repo: { owner: "xmeta", repo: "ACED" }, serverUrl: "https://github.com" },
      {},
      requireMock,
      {},
      Buffer
    );
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filter: "all" }),
        expect.objectContaining({ name: "workflow-integrity", head_sha: "h".repeat(40) })
      ])
    );

    checkResponses = [
      {
        id: 1,
        name: "workflow-integrity",
        app: { slug: "github-actions" },
        external_id: "foreign",
        details_url: "https://github.com/xmeta/ACED/actions/runs/99"
      }
    ];
    await expect(
      publishScript()(
        github,
        { repo: { owner: "xmeta", repo: "ACED" }, serverUrl: "https://github.com" },
        {},
        requireMock,
        {},
        Buffer
      )
    ).rejects.toThrow(/unmanaged/);

    checkResponses = [
      {
        id: 1,
        name: "workflow-integrity",
        app: { slug: "other-app" },
        external_id: "scwbs.workflow-integrity.v1:foreign",
        details_url: "https://github.com/xmeta/ACED/actions/runs/99"
      }
    ];
    await expect(
      publishScript()(
        github,
        { repo: { owner: "xmeta", repo: "ACED" }, serverUrl: "https://github.com" },
        {},
        requireMock,
        {},
        Buffer
      )
    ).rejects.toThrow(/unmanaged/);

    checkResponses = [
      { id: 1, name: "workflow-integrity", app: { slug: "github-actions" } },
      { id: 2, name: "workflow-integrity", app: { slug: "github-actions" } }
    ];
    await expect(
      publishScript()(
        github,
        { repo: { owner: "xmeta", repo: "ACED" }, serverUrl: "https://github.com" },
        {},
        requireMock,
        {},
        Buffer
      )
    ).rejects.toThrow(/ambiguous/);
  });
});
