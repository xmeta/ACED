import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { buildApprovalApproveYaml, runApprovalApprove, runApprovalReject, runApprovalRequest } from "../../src/commands/approval-request.js";
import { APPROVAL_DELEGATION_TOKEN_ENV, approvalDelegationTokenSha256 } from "../../src/core/human-gate.js";
import { main } from "../../src/cli.js";
import { readApproval, readApprovalForScope, readRegistry } from "../../src/core/contracts.js";
import { makeTempRepo, sampleTask, sampleEvidence, sampleApproval, writeScwbsProject, writeText, writeYaml } from "../helpers.js";

const STRONG_TOKEN = "0123456789abcdef0123456789abcdef";
const OTHER_STRONG_TOKEN = "fedcba9876543210fedcba9876543210";

function captureOutput(action: () => number): { result: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalWrite = process.stdout.write;
  const originalError = console.error;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  try {
    return { result: action(), stdout: stdout.join(""), stderr: stderr.join("\n") };
  } finally {
    process.stdout.write = originalWrite;
    console.error = originalError;
  }
}

function withCurrentPullRequest(root: string, payload: unknown | undefined, action: () => number): number {
  const gh = path.join(root, "bin/gh");
  writeText(root, "bin/gh", payload === undefined
    ? "#!/usr/bin/env node\nprocess.exit(1);\n"
    : `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n`);
  chmodSync(gh, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${path.dirname(gh)}:${previousPath ?? ""}`;
  try {
    return action();
  } finally {
    process.env.PATH = previousPath;
  }
}

function withInteractiveTty(action: () => number): number {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    return action();
  } finally {
    if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    else delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
  }
}

describe("approval", () => {
  test("approval request writes a requested approval record", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runApprovalRequest(root, "WBS-001-004", { pullRequest: "#42", note: "Awaiting human review", force: false })).toBe(0);
    const actual = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(actual).toContain("status: requested");
    expect(actual).toContain("requestedAt:");
    expect(actual).toContain('pullRequest: "#42"');
  });

  test("scoped requests retain independent human-gate and post-finish slots", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runApprovalRequest(root, "WBS-001-004", { scope: "human-gate", pullRequest: "#42", force: false })).toBe(0);
    expect(runApprovalRequest(root, "WBS-001-004", { scope: "post-finish", pullRequest: "#42", force: false })).toBe(0);

    const human = readApprovalForScope(root, "WBS-001-004", "human-gate").approval;
    const postFinish = readApprovalForScope(root, "WBS-001-004", "post-finish").approval;
    expect(human).toMatchObject({ version: "scwbs.approval.v2", activeScope: "human-gate", status: "requested", pullRequest: "#42" });
    expect(postFinish).toMatchObject({ version: "scwbs.approval.v2", activeScope: "post-finish", status: "requested", pullRequest: "#42" });
    expect(runApprovalRequest(root, "WBS-001-004", { scope: "human-gate", pullRequest: "#43", note: "replacement", force: true })).toBe(0);
    expect(readApprovalForScope(root, "WBS-001-004", "post-finish").approval).toMatchObject({ status: "requested", pullRequest: "#42" });
    expect(readApprovalForScope(root, "WBS-001-004", "human-gate").approval).toMatchObject({ status: "requested", pullRequest: "#43" });
    const raw = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(raw).toContain("human-gate:");
    expect(raw).toContain("post-finish:");
  });

  test("scoped write imports only an explicitly scoped v1 delegated record and never infers v1 human scope", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval({
      status: "approved",
      approvalMode: "delegated",
      approvedBy: "delegated:xmeta",
      approvedAt: "2026-07-14T00:00:00.000Z",
      delegationSource: "issue-222",
      delegatedBy: "xmeta",
      executedBy: "ai-agent",
      delegationScope: "post-finish",
      headCommit: "abc1234",
      diffHash: "diff1234",
      reason: "Legacy delegated approval",
      delegationProof: `hmac-sha256:${"a".repeat(64)}`
    }) as unknown as Record<string, unknown>);
    expect(runApprovalRequest(root, "WBS-001-004", { scope: "human-gate", force: true })).toBe(0);
    const raw = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(raw).toContain("post-finish:");
    expect(raw).toContain("delegationScope: post-finish");
    expect(raw).toContain("human-gate:");

    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval({ status: "approved", approvedBy: "old-human", approvedAt: "2026-07-14T00:00:00.000Z" }) as unknown as Record<string, unknown>);
    expect(runApprovalRequest(root, "WBS-001-004", { scope: "post-finish", force: true })).toBe(0);
    const humanRaw = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(humanRaw).not.toContain("old-human");
    expect(humanRaw).toContain("post-finish:");
  });

  test("approval request records the detected current branch PR after Evidence matches", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    execFileSync("git", ["remote", "add", "origin", "https://github.com/xmeta/ACED.git"], { cwd: root });
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({ git: { pullRequest: "#42" } }) as unknown as Record<string, unknown>);

    withCurrentPullRequest(root, { number: 42, state: "OPEN", isDraft: false }, () => {
      const result = runApprovalRequest(root, "WBS-001-004", { note: "Awaiting human review", force: false });
      expect(result).toBe(0);
      return result;
    });
    expect(readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8")).toContain('pullRequest: "#42"');
  });

  test("approval request stops and points to Evidence collection when an existing PR is unrecorded", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    execFileSync("git", ["remote", "add", "origin", "https://github.com/xmeta/ACED.git"], { cwd: root });
    const output = captureOutput(() => withCurrentPullRequest(root, { number: 42 }, () =>
      runApprovalRequest(root, "WBS-001-004", { note: "Awaiting human review", force: false })));

    expect(output.result).toBe(1);
    expect(output.stderr).toContain("current branch already has PR #42");
    expect(output.stderr).toContain("evidence collect --task WBS-001-004 --pull-request 42 --force");
  });

  test("approval request refuses to overwrite an existing record without force", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval() as unknown as Record<string, unknown>);
    const before = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");

    expect(runApprovalRequest(root, "WBS-001-004", { pullRequest: "#99", note: "Updated", force: false })).toBe(1);
    expect(readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8")).toBe(before);
    expect(runApprovalRequest(root, "WBS-001-004", { pullRequest: "#99", note: "Updated", force: true })).toBe(0);
    expect(readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8")).not.toBe(before);
  });

  test("approval request CLI accepts multi-word notes", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(main(["approval", "request", "--task", "WBS-001-004", "--pull-request", "#42", "--note", "Awaiting", "human", "review"], root)).toBe(0);
    const actual = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(actual).toContain("  - Awaiting human review");
  });

  test("approval request CLI accepts inline note syntax", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(main(["approval", "request", "--task", "WBS-001-004", "--note=Awaiting human review"], root)).toBe(0);
    const actual = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(actual).toContain("  - Awaiting human review");
  });

  test("approval request --json emits a bounded versioned requested summary", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      subjectHeadCommit: "abc1234",
      diffHash: "diff1234",
      git: {
        branch: "task/WBS-001-004-api-implementation",
        base: "main",
        headCommit: "abc1234",
        pullRequest: "#42"
      }
    }) as unknown as Record<string, unknown>);
    const note = "n".repeat(2048);
    const output = captureOutput(() => main([
      "approval", "request", "--task", "WBS-001-004", "--pull-request", "#42", "--note", note, "--json"
    ], root));

    expect(output.result).toBe(0);
    const json = JSON.parse(output.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      version: "scwbs.approval-request.v1",
      approvalId: "APR-WBS-001-004",
      taskId: "WBS-001-004",
      status: "requested",
      nextActionOwner: "human",
      pullRequest: "#42"
    });
    expect(json.requestedAt).toEqual(expect.any(String));
    expect(json.notes).toEqual(["n".repeat(512)]);
    expect(json.nextAction).toEqual(expect.stringContaining(
      'approval approve --task WBS-001-004 --actor human --reason "CONFIRM TTY APPROVAL WBS-001-004 abc1234 diff1234"'
    ));
    expect(json).not.toHaveProperty("approvedBy");
    expect(json).not.toHaveProperty("approvedAt");
    expect(output.stdout.length).toBeLessThan(2048);
    const schema = JSON.parse(readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/approval-request.schema.json"), "utf8"));
    expect(new Ajv2020({ strict: false }).compile(schema)(json)).toBe(true);
  });

  test("approval request --json preserves requested side effects and rejects unknown options", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const output = captureOutput(() => main([
      "approval", "request", "--task", "WBS-001-004", "--json", "--unknown"
    ], root));

    expect(output.result).toBe(1);
    expect(readApproval(root, "WBS-001-004").approval).toBeUndefined();
  });

  test("approval approve writes a human approved record", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      subjectHeadCommit: "abc1234",
      diffHash: "diff1234",
      git: { pullRequest: "#42" }
    }) as unknown as Record<string, unknown>);

    const result = withInteractiveTty(() => runApprovalApprove(root, "WBS-001-004", {
      pullRequest: "#42",
      reason: "CONFIRM TTY APPROVAL WBS-001-004 abc1234 diff1234",
      actor: "human",
      force: false
    }));
    const actorId = os.userInfo().username;
    expect(result).toBe(0);
    const actual = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(actual).toContain("status: approved");
    expect(actual).toContain(`approvedBy: ${actorId}`);
    expect(actual).toContain(`actorId: ${actorId}`);
    expect(actual).toContain("actorSource: tty");
    expect(actual).toContain("verificationLevel: lean");
    expect(actual).toContain("approvedAt:");
    expect(actual).toContain("headCommit: abc1234");
    expect(actual).toContain("diffHash: diff1234");
    expect(actual).toContain('pullRequest: "#42"');
    expect(actual).toContain("reason: CONFIRM TTY APPROVAL WBS-001-004 abc1234 diff1234");
  });

  test("scoped human approval requires scope-bound confirmation and preserves the other slot", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      subjectHeadCommit: "abc1234",
      diffHash: "diff1234",
      git: { pullRequest: "#42" }
    }) as unknown as Record<string, unknown>);
    expect(runApprovalRequest(root, "WBS-001-004", { scope: "post-finish", pullRequest: "#42", force: false })).toBe(0);

    const result = withInteractiveTty(() => runApprovalApprove(root, "WBS-001-004", {
      scope: "human-gate",
      pullRequest: "#42",
      reason: "CONFIRM TTY APPROVAL WBS-001-004 human-gate abc1234 diff1234",
      actor: "human",
      force: false
    }));
    expect(result).toBe(0);
    expect(readApprovalForScope(root, "WBS-001-004", "human-gate").approval).toMatchObject({ status: "approved", activeScope: "human-gate" });
    expect(readApprovalForScope(root, "WBS-001-004", "post-finish").approval).toMatchObject({ status: "requested", activeScope: "post-finish" });
    expect(withInteractiveTty(() => runApprovalApprove(root, "WBS-001-004", {
      scope: "post-finish", pullRequest: "#42",
      reason: "CONFIRM TTY APPROVAL WBS-001-004 post-finish abc1234 diff1234", actor: "human", force: false
    }))).toBe(0);
    expect(withInteractiveTty(() => runApprovalApprove(root, "WBS-001-004", {
      scope: "human-gate", pullRequest: "#42",
      reason: "CONFIRM TTY APPROVAL WBS-001-004 human-gate abc1234 diff1234", actor: "human", force: true
    }))).toBe(0);
    expect(readApprovalForScope(root, "WBS-001-004", "post-finish").approval).toMatchObject({ status: "approved", activeScope: "post-finish" });
    expect(readRegistry(root).registry?.contracts.filter((entry) => entry.type === "approval" && entry.relatedTask === "WBS-001-004")).toHaveLength(1);
  });

  test("scoped human rejection is isolated, TTY-bound, and bounded", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(runApprovalRequest(root, "WBS-001-004", { scope: "human-gate", force: false })).toBe(0);
    expect(runApprovalRequest(root, "WBS-001-004", { scope: "post-finish", force: false })).toBe(0);
    const output = captureOutput(() => withInteractiveTty(() => runApprovalReject(root, "WBS-001-004", {
      actor: "human", scope: "human-gate", reason: "Human rejected the gate", force: false
    })));
    expect(output.result).toBe(0);
    expect(output.stdout).toContain("activeScope: human-gate");
    expect(output.stdout).not.toContain("post-finish:");
    expect(output.stdout).not.toContain("Human rejected the gate");
    expect(readApprovalForScope(root, "WBS-001-004", "human-gate").approval).toMatchObject({ status: "rejected", reason: "Human rejected the gate" });
    expect(readApprovalForScope(root, "WBS-001-004", "post-finish").approval).toMatchObject({ status: "requested" });
    expect(runApprovalReject(root, "WBS-001-004", { actor: "ai", scope: "post-finish", reason: "AI", force: true })).toBe(1);
    expect(readApprovalForScope(root, "WBS-001-004", "post-finish").approval).toMatchObject({ status: "requested" });
  });

  test("scoped human approval fails closed without Evidence PR, TTY, or exact confirmation", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      subjectHeadCommit: "abc1234", diffHash: "diff1234", git: {
        branch: "task/WBS-001-004-api-implementation", base: "main", headCommit: "abc1234"
      }
    }) as unknown as Record<string, unknown>);
    expect(withInteractiveTty(() => runApprovalApprove(root, "WBS-001-004", {
      actor: "human", scope: "human-gate", force: true, reason: "CONFIRM TTY APPROVAL WBS-001-004 human-gate abc1234 diff1234"
    }))).toBe(1);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      subjectHeadCommit: "abc1234", diffHash: "diff1234", git: {
        branch: "task/WBS-001-004-api-implementation", base: "main", headCommit: "abc1234", pullRequest: "#42"
      }
    }) as unknown as Record<string, unknown>);
    expect(runApprovalApprove(root, "WBS-001-004", {
      actor: "human", scope: "human-gate", force: true, reason: "CONFIRM TTY APPROVAL WBS-001-004 human-gate abc1234 diff1234"
    })).toBe(1);
    expect(withInteractiveTty(() => runApprovalApprove(root, "WBS-001-004", {
      actor: "human", scope: "human-gate", force: true, reason: "wrong confirmation"
    }))).toBe(1);
    expect(readApproval(root, "WBS-001-004").approval).toBeUndefined();
  });

  test("request and approve preserve an invalid v2 artifact even with force", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const invalid = {
      id: "APR-WBS-001-004", type: "approval", taskId: "WBS-001-004", version: "scwbs.approval.v2",
      activeScope: "human-gate", scopeApprovals: { "human-gate": { status: "requested" } }, status: "approved"
    };
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", invalid);
    const before = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(runApprovalRequest(root, "WBS-001-004", { scope: "human-gate", force: true })).toBe(1);
    expect(runApprovalApprove(root, "WBS-001-004", { actor: "human", scope: "human-gate", force: true, reason: "bad" })).toBe(1);
    expect(runApprovalReject(root, "WBS-001-004", { actor: "human", scope: "human-gate", force: true, reason: "bad" })).toBe(1);
    expect(readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8")).toBe(before);
  });

  test("transactional approval mutation restores Approval and Registry bytes when sync fails", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(runApprovalRequest(root, "WBS-001-004", { force: false })).toBe(0);
    const approvalPath = path.join(root, "contracts/approvals/WBS-001-004.yaml");
    const registryPath = path.join(root, "contracts/registry.yaml");
    const beforeApproval = readFileSync(approvalPath, "utf8");
    const beforeRegistry = readFileSync(registryPath, "utf8");
    expect(runApprovalRequest(root, "WBS-001-004", {
      force: true,
      note: "replacement",
      afterRegistrySync: () => {
        writeFileSync(registryPath, "corrupted registry\n", "utf8");
        throw new Error("forced registry failure");
      }
    })).toBe(1);
    expect(readFileSync(approvalPath, "utf8")).toBe(beforeApproval);
    expect(readFileSync(registryPath, "utf8")).toBe(beforeRegistry);
  });

  test("root reject alias reaches the approval reject writer", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(runApprovalRequest(root, "WBS-001-004", { force: false })).toBe(0);
    expect(main(["reject", "--task", "WBS-001-004", "--actor", "human", "--reason", "Human rejected"], root)).toBe(0);
    expect(readApproval(root, "WBS-001-004").approval).toMatchObject({ status: "rejected", reason: "Human rejected" });
  });

  test("approval approve fails closed when the Evidence PR has no matching approved review", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      subjectHeadCommit: "abc1234",
      diffHash: "diff1234",
      git: { pullRequest: "#42" }
    }) as unknown as Record<string, unknown>);
    const output = captureOutput(() => withInteractiveTty(() => runApprovalApprove(root, "WBS-001-004", {
      pullRequest: "#42",
      reason: "Reviewed",
      actor: "human",
      force: false
    })));

    expect(output.result).toBe(1);
    expect(output.stderr).toContain("exact TTY confirmation");
    expect(readApproval(root, "WBS-001-004").approval).toBeUndefined();
  });

  test("approval approve preserves request time while legacy approval remains unobserved", () => {
    const requestedAt = "2026-07-23T00:00:00.000Z";
    expect(buildApprovalApproveYaml("WBS-001-004", {
      requestedAt,
      approvedAt: "2026-07-23T00:01:00.000Z"
    })).toContain(`requestedAt: "${requestedAt}"`);
    expect(buildApprovalApproveYaml("WBS-001-004", {
      approvedAt: "2026-07-23T00:01:00.000Z"
    })).not.toContain("requestedAt:");
  });

  test("approval approve rejects AI execution mode", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runApprovalApprove(root, "WBS-001-004", { reason: "AI should not approve", actor: "ai", force: false })).toBe(1);
    expect(readApproval(root, "WBS-001-004").approval).toBeUndefined();
  });

  test("approval approve rejects when actor is not explicitly human", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    // Ensure SCWBS_AGENT_MODE is not set in the test environment
    delete process.env.SCWBS_AGENT_MODE;
    expect(runApprovalApprove(root, "WBS-001-004", { reason: "No actor specified", force: false })).toBe(1);
    expect(readApproval(root, "WBS-001-004").approval).toBeUndefined();
  });

  test("approval approve writes a provenance-distinct delegated record for an authorized scope", () => {
    const root = makeTempRepo();
    const token = STRONG_TOKEN;
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      approvalPolicy: {
        mode: "delegated",
        delegatedBy: "xmeta",
        delegatedTo: "ai-agent",
        scopes: ["human-gate", "post-finish"],
        source: "https://github.com/xmeta/ACED/issues/222",
        reason: "Authorized unattended execution",
        expiresAt: "2099-01-01T00:00:00.000Z",
        tokenSha256: approvalDelegationTokenSha256(token)
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      subjectHeadCommit: "abc1234",
      diffHash: "diff1234",
      git: {
        branch: "task/WBS-001-004-api-implementation",
        base: "main",
        headCommit: "abc1234",
        pullRequest: "#42"
      }
    }) as unknown as Record<string, unknown>);
    let output: ReturnType<typeof captureOutput>;
    process.env[APPROVAL_DELEGATION_TOKEN_ENV] = token;
    try {
      output = captureOutput(() => runApprovalApprove(root, "WBS-001-004", {
        reason: "Automated evidence review",
        actor: "delegated-ai",
        scope: "post-finish",
        force: false
      }));
    } finally {
      delete process.env[APPROVAL_DELEGATION_TOKEN_ENV];
    }
    expect(output.result).toBe(0);
    const actual = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(actual).toContain("approvalMode: delegated");
    expect(actual).toContain("delegationSource: https://github.com/xmeta/ACED/issues/222");
    expect(actual).toContain("delegatedBy: xmeta");
    expect(actual).toContain("executedBy: ai-agent");
    expect(actual).toContain("delegationScope: post-finish");
    expect(actual).toContain("delegationProof: hmac-sha256:");
    expect(actual).not.toContain(token);
    expect(output.stdout).not.toContain(token);
    expect(output.stderr).not.toContain(token);
  });

  test.each([
    { name: "missing policy", task: sampleTask(), token: STRONG_TOKEN, scope: "human-gate", error: "does not have a delegated approval policy" },
    { name: "missing token", task: sampleTask({ approvalPolicy: {
      mode: "delegated", delegatedBy: "xmeta", delegatedTo: "ai-agent", scopes: ["human-gate"],
      source: "issue-222", reason: "automation", expiresAt: "2099-01-01T00:00:00.000Z",
      tokenSha256: approvalDelegationTokenSha256(STRONG_TOKEN)
    } }), token: undefined, scope: "human-gate", error: `${APPROVAL_DELEGATION_TOKEN_ENV} is required` },
    { name: "token mismatch", task: sampleTask({ approvalPolicy: {
      mode: "delegated", delegatedBy: "xmeta", delegatedTo: "ai-agent", scopes: ["human-gate"],
      source: "issue-222", reason: "automation", expiresAt: "2099-01-01T00:00:00.000Z",
      tokenSha256: approvalDelegationTokenSha256(STRONG_TOKEN)
    } }), token: OTHER_STRONG_TOKEN, scope: "human-gate", error: "does not match the Task Contract delegation" },
    { name: "expired policy", task: sampleTask({ approvalPolicy: {
      mode: "delegated", delegatedBy: "xmeta", delegatedTo: "ai-agent", scopes: ["human-gate"],
      source: "issue-222", reason: "automation", expiresAt: "2020-01-01T00:00:00.000Z",
      tokenSha256: approvalDelegationTokenSha256(STRONG_TOKEN)
    } }), token: STRONG_TOKEN, scope: "human-gate", error: "approval delegation is expired" },
    { name: "scope mismatch", task: sampleTask({ approvalPolicy: {
      mode: "delegated", delegatedBy: "xmeta", delegatedTo: "ai-agent", scopes: ["human-gate"],
      source: "issue-222", reason: "automation", expiresAt: "2099-01-01T00:00:00.000Z",
      tokenSha256: approvalDelegationTokenSha256(STRONG_TOKEN)
    } }), token: STRONG_TOKEN, scope: "post-finish", error: "delegation does not allow post-finish approval" },
    { name: "weak token", task: sampleTask({ approvalPolicy: {
      mode: "delegated", delegatedBy: "xmeta", delegatedTo: "ai-agent", scopes: ["human-gate"],
      source: "issue-222", reason: "automation", expiresAt: "2099-01-01T00:00:00.000Z",
      tokenSha256: approvalDelegationTokenSha256("short-token")
    } }), token: "short-token", scope: "human-gate", error: "at least 32 UTF-8 bytes" }
  ])("delegated approval fails closed for $name", ({ task, token, scope, error }) => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", task as unknown as Record<string, unknown>);
    if (token) process.env[APPROVAL_DELEGATION_TOKEN_ENV] = token;
    else delete process.env[APPROVAL_DELEGATION_TOKEN_ENV];
    let output: ReturnType<typeof captureOutput>;
    try {
    output = captureOutput(() => runApprovalApprove(root, "WBS-001-004", { actor: "delegated-ai", scope, reason: "Delegated evidence review", force: false }));
    } finally {
      delete process.env[APPROVAL_DELEGATION_TOKEN_ENV];
    }
    expect(output.result).toBe(1);
    expect(output.stderr).toContain(error);
    if (token) {
      expect(output.stdout).not.toContain(token);
      expect(output.stderr).not.toContain(token);
    }
    expect(readApproval(root, "WBS-001-004").approval).toBeUndefined();
  });

  test("approval approve updates requested records and protects existing approvals", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval() as unknown as Record<string, unknown>);

    expect(runApprovalApprove(root, "WBS-001-004", { reason: "Reviewed", actor: "human", force: false })).toBe(0);
    expect(readApproval(root, "WBS-001-004").approval?.status).toBe("approved");
    const before = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(runApprovalApprove(root, "WBS-001-004", { reason: "Second approval", actor: "human", force: false })).toBe(1);
    expect(readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8")).toBe(before);
  });

  test("approval approve CLI accepts inline multi-word reason syntax", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(main(["approval", "approve", "--task", "WBS-001-004", "--actor", "human", "--pull-request", "#42", "--reason=Evidence and PR reviewed"], root)).toBe(0);
    const actual = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(actual).toContain("reason: Evidence and PR reviewed");
  });

  test("approval approve helper can render deterministic YAML", () => {
    expect(buildApprovalApproveYaml("WBS-001-004", {
      pullRequest: "#42",
      reason: "Reviewed",
      approvedBy: "human",
      approvedAt: "2026-07-02T00:00:00.000Z"
    })).toContain('approvedAt: "2026-07-02T00:00:00.000Z"');
  });
});
