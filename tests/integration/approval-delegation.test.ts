import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { buildApprovalDelegationPrepare } from "../../src/commands/approval-delegation.js";
import { APPROVAL_DELEGATION_TOKEN_ENV } from "../../src/core/human-gate.js";
import { makeTempRepo, sampleTask, writeScwbsProject, writeYaml } from "../helpers.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const options = { scopes: "human-gate,post-finish", expiresAt: "2099-01-01T00:00:00.000Z", source: "issue-226", reason: "unattended checks", delegatedBy: "xmeta" };

describe("approval delegation prepare", () => {
  test("creates a schema-valid secret-free policy patch and handoff", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const result = buildApprovalDelegationPrepare(root, "WBS-001-004", options, TOKEN);
    expect(result.error).toBeUndefined();
    const rendered = JSON.stringify(result.output);
    expect(result.output?.policyPatch.approvalPolicy.tokenSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.output?.policyPatch.approvalPolicy.scopes).toEqual(["human-gate", "post-finish"]);
    expect(result.output?.handoff.join(" ")).toContain("never auto-loads .env");
    expect(rendered).not.toContain(TOKEN);
    expect(result.output?.governanceCostProxy).toEqual({ manualInputsRequired: 5, generatedFields: 3, requiredContractOnlyCommits: 1, finishRetriesAdded: 0 });
  });

  test.each([
    ["missing token", undefined, options, "SCWBS_APPROVAL_DELEGATION_TOKEN is required"],
    ["weak token", "short", options, "at least 32 UTF-8 bytes"],
    ["invalid scopes", TOKEN, { ...options, scopes: "human-gate,invalid" }, "--scopes"],
    ["expired", TOKEN, { ...options, expiresAt: "2020-01-01T00:00:00.000Z" }, "future UTC"],
    ["missing source", TOKEN, { ...options, source: "" }, "--expires-at, --source"]
  ])("fails closed for %s without leaking the token", (_name, token, input, message) => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const result = buildApprovalDelegationPrepare(root, "WBS-001-004", input, token);
    expect(result.output).toBeUndefined();
    expect(result.error).toContain(message);
    expect(result.error).not.toContain(TOKEN);
  });

  test("refuses a committed or already-delegated Task Contract", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: root });
    expect(buildApprovalDelegationPrepare(root, "WBS-001-004", options, TOKEN).error).toContain("already committed");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ approvalPolicy: { mode: "delegated", delegatedBy: "xmeta", delegatedTo: "ai-agent", scopes: ["human-gate"], source: "issue", reason: "reason", expiresAt: "2099-01-01T00:00:00.000Z", tokenSha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }) as unknown as Record<string, unknown>);
    // The creation-commit boundary remains the first, non-bypassable diagnostic.
    expect(buildApprovalDelegationPrepare(root, "WBS-001-004", options, TOKEN).error).toContain("already committed");
  });

  test("does not use a process argument for the token", () => {
    expect(APPROVAL_DELEGATION_TOKEN_ENV).toBe("SCWBS_APPROVAL_DELEGATION_TOKEN");
  });
});
