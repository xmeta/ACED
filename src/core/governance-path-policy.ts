import { matchesGlob } from "./glob.js";

export const GOVERNANCE_PATH_POLICY_VERSION = "1.0.0";

export type GovernancePathClassification =
  | "toolchain"
  | "build"
  | "quality-gate"
  | "ci"
  | "agent-policy"
  | "governance-schema";

export type GovernancePathPolicyEntry = {
  pattern: string;
  classification: GovernancePathClassification;
  reasonCode: string;
  reason: string;
  critical?: boolean;
  sensitiveMeta?: boolean;
  newTaskHumanGate?: boolean;
};

export const GOVERNANCE_PATH_POLICY: readonly GovernancePathPolicyEntry[] = [
  {
    pattern: "package.json",
    classification: "toolchain",
    reasonCode: "governance.toolchain.package",
    reason: "package scripts, engines, packageManager, and dependencies affect the execution toolchain",
    critical: true,
    sensitiveMeta: true,
    newTaskHumanGate: true
  },
  {
    pattern: "package-lock.json",
    classification: "toolchain",
    reasonCode: "governance.toolchain.lockfile",
    reason: "dependency resolution and installed toolchain inputs are changed",
    critical: true,
    sensitiveMeta: true,
    newTaskHumanGate: true
  },
  {
    pattern: "tsconfig.json",
    classification: "build",
    reasonCode: "governance.build.typescript",
    reason: "the TypeScript compiler boundary and emitted build can change",
    critical: true,
    sensitiveMeta: true,
    newTaskHumanGate: true
  },
  {
    pattern: "tsconfig.*.json",
    classification: "build",
    reasonCode: "governance.build.extra-typescript-config",
    reason: "an additional TypeScript project can change compilation or packaging behavior",
    critical: true,
    sensitiveMeta: true
  },
  {
    pattern: "vitest.config.ts",
    classification: "quality-gate",
    reasonCode: "governance.quality.vitest",
    reason: "test discovery, isolation, or pass/fail behavior can change",
    critical: true,
    sensitiveMeta: true,
    newTaskHumanGate: true
  },
  {
    pattern: "eslint.config.js",
    classification: "quality-gate",
    reasonCode: "governance.quality.eslint",
    reason: "lint enforcement and the accepted code-quality boundary can change",
    critical: true,
    sensitiveMeta: true
  },
  {
    pattern: ".github/**",
    classification: "ci",
    reasonCode: "governance.ci.workflow",
    reason: "repository automation and CI enforcement can change",
    critical: true,
    sensitiveMeta: true,
    newTaskHumanGate: true
  },
  {
    pattern: ".npmrc",
    classification: "toolchain",
    reasonCode: "governance.toolchain.npm-config",
    reason: "npm registry, install, or execution behavior can change",
    critical: true,
    sensitiveMeta: true
  },
  {
    pattern: "AGENTS.md",
    classification: "agent-policy",
    reasonCode: "governance.agent.instructions",
    reason: "agent operating constraints and approval boundaries can change",
    critical: true,
    sensitiveMeta: true
  },
  {
    pattern: ".gitignore",
    classification: "agent-policy",
    reasonCode: "governance.agent.workspace-boundary",
    reason: "ignored files can alter what enters Evidence and review scope",
    critical: true,
    sensitiveMeta: true
  },
  {
    pattern: "scripts/tsconfig.json",
    classification: "build",
    reasonCode: "governance.build.scripts-typescript",
    reason: "script compilation and validation tooling can change",
    critical: true,
    sensitiveMeta: true
  },
  {
    pattern: "contracts/check-coverage.yaml",
    classification: "governance-schema",
    reasonCode: "governance.schema.check-coverage",
    reason: "required checks and Evidence coverage are derived from this policy",
    critical: true,
    sensitiveMeta: true
  },
  {
    pattern: "docs/scwbs/schemas/**",
    classification: "governance-schema",
    reasonCode: "governance.schema.scwbs",
    reason: "SC-WBS machine-readable contract semantics can change",
    critical: true,
    sensitiveMeta: true
  },
  {
    pattern: "src/core/governance-path-policy.ts",
    classification: "agent-policy",
    reasonCode: "governance.agent.path-policy",
    reason: "the single source of truth for governance-critical paths can change",
    critical: true,
    sensitiveMeta: true
  }
] as const;

export const BROAD_ALLOWED_PATH_PATTERNS = ["**", "src/**", "tests/**", "docs/**", "contracts/**"] as const;

export type GovernancePathImpact = GovernancePathPolicyEntry & { matchedPath: string };

export function governancePathImpacts(file: string): GovernancePathImpact[] {
  return GOVERNANCE_PATH_POLICY
    .filter((entry) => matchesGlob(file, entry.pattern))
    .map((entry) => ({ ...entry, matchedPath: file }));
}

export function governancePathImpact(file: string): GovernancePathImpact | undefined {
  return governancePathImpacts(file)[0];
}

export function standardHumanGatePaths(): string[] {
  return GOVERNANCE_PATH_POLICY
    .filter((entry) => entry.newTaskHumanGate)
    .map((entry) => entry.pattern);
}

export function requiredNewTaskHumanGatePaths(): string[] {
  return standardHumanGatePaths();
}

export function sensitiveMetaPaths(): string[] {
  return GOVERNANCE_PATH_POLICY
    .filter((entry) => entry.sensitiveMeta)
    .map((entry) => entry.pattern);
}

export function isBroadAllowedPath(pattern: string): boolean {
  return BROAD_ALLOWED_PATH_PATTERNS.includes(pattern as typeof BROAD_ALLOWED_PATH_PATTERNS[number]);
}

export function governancePolicyReason(file: string): { code: string; classification: GovernancePathClassification; reason: string } | undefined {
  const impact = governancePathImpact(file);
  return impact
    ? { code: impact.reasonCode, classification: impact.classification, reason: impact.reason }
    : undefined;
}
