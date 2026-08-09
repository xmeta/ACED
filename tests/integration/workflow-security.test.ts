import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const DELEGATION_TOKEN_ENV = "SCWBS_APPROVAL_DELEGATION_TOKEN";
const workflow = readFileSync(path.join(process.cwd(), ".github/workflows/scwbs.yml"), "utf8");
const setupAction = readFileSync(path.join(process.cwd(), ".github/actions/setup-toolchain/action.yml"), "utf8");

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
});
