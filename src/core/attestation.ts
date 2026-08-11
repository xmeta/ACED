import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Evidence } from "./types.js";

export const ATTESTATION_SCHEMA_VERSION = "scwbs.attestation-verification.v1" as const;
export const DEFAULT_ATTESTATION_PREDICATE = "https://slsa.dev/provenance/v1" as const;

export type AttestationVerificationStatus =
  | "verified"
  | "missing"
  | "invalid"
  | "subject-mismatch"
  | "untrusted"
  | "unavailable";

export type AttestationIdentitySummary = {
  repository?: string;
  signerWorkflow?: string;
  predicateType?: string;
  sourceCommit?: string;
  sourceRef?: string;
  issuer?: string;
};

export type AttestationVerificationRecord = {
  schemaVersion: typeof ATTESTATION_SCHEMA_VERSION;
  status: AttestationVerificationStatus;
  artifact: {
    locator: string;
    digest: string;
  };
  attestation: {
    locator: string;
    bundle?: string;
    trustedRoot?: string;
  };
  identity?: AttestationIdentitySummary;
  verifier: {
    name: "gh attestation verify";
    exitStatus?: number;
  };
  reasonCodes: string[];
  verifiedAt: string;
};

export type AttestationVerificationResult = AttestationVerificationRecord & {
  taskId: string;
  policy: {
    repository?: string;
    signerWorkflow?: string;
    predicateType?: string;
    sourceCommit?: string;
    sourceRef?: string;
  };
};

export type AttestationVerificationContext = {
  root?: string;
  taskId: string;
  artifact: string;
  evidence?: Evidence;
  repository?: string;
  signerWorkflow?: string;
  predicateType?: string;
  sourceRef?: string;
  sourceCommit?: string;
  bundle?: string;
  customTrustedRoot?: string;
  now?: string;
};

type GhResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type ParsedAttestation = {
  identity: AttestationIdentitySummary;
  subjectDigests: string[];
  verificationResult?: string;
};

function bounded(value: string, maximum = 160): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function boundedOptional(value: string | undefined, maximum = 256): string | undefined {
  return value === undefined ? undefined : bounded(value, maximum);
}

function safeLocator(root: string, absolutePath: string, outside = "external-artifact"): string {
  const relative = path.relative(root, absolutePath).replaceAll("\\", "/");
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return `repo:${relative}`;
  return outside;
}

function digestFile(absolutePath: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(absolutePath)).digest("hex")}`;
}

function normalizeRepository(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  const match = trimmed.match(/^([^/]+\/[^/]+)$/);
  return match?.[1];
}

function normalizeWorkflow(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/(\.github\/workflows\/[^@\s]+)(?:@.*)?$/);
  return match?.[1] ?? value.trim();
}

function normalizeDigest(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(?:sha256:)?([0-9a-f]{64})$/i);
  return match ? `sha256:${match[1].toLowerCase()}` : undefined;
}

function collectEntries(value: unknown, keyPath: string[] = [], entries: Array<{ key: string; value: string; path: string }> = []): Array<{ key: string; value: string; path: string }> {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectEntries(item, [...keyPath, String(index)], entries));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const nextPath = [...keyPath, key];
      if (typeof child === "string") entries.push({ key, value: child, path: nextPath.join(".") });
      else collectEntries(child, nextPath, entries);
    }
  }
  return entries;
}

function firstEntry(entries: Array<{ key: string; value: string; path: string }>, keys: string[]): string | undefined {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  return entries.find((entry) => wanted.has(entry.key.toLowerCase()))?.value;
}

function parseVerifierOutput(stdout: string): ParsedAttestation | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const entries = collectEntries(parsed);
  const identity: AttestationIdentitySummary = {
    repository: boundedOptional(normalizeRepository(firstEntry(entries, ["repository", "sourceRepository"]))),
    signerWorkflow: boundedOptional(normalizeWorkflow(firstEntry(entries, ["workflow", "signerWorkflow", "workflowPath"]))),
    predicateType: boundedOptional(firstEntry(entries, ["predicateType"])),
    sourceCommit: boundedOptional(firstEntry(entries, ["sourceRepositoryDigest", "sourceDigest", "sourceCommit"]), 128),
    sourceRef: boundedOptional(firstEntry(entries, ["sourceRepositoryRef", "sourceRef", "ref"])),
    issuer: boundedOptional(firstEntry(entries, ["issuer"]))
  };
  const subjectDigests = entries
    .filter((entry) => ["sha256", "digest"].includes(entry.key.toLowerCase()))
    .map((entry) => normalizeDigest(entry.value))
    .filter((value): value is string => Boolean(value));
  return {
    identity,
    subjectDigests,
    verificationResult: firstEntry(entries, ["verificationResult", "result", "status"])
  };
}

function classifyFailure(stderr: string, stdout: string): { status: AttestationVerificationStatus; reasonCodes: string[] } {
  const text = `${stderr}\n${stdout}`.toLowerCase();
  if (/no attestation|not found|could not find.*attestation|does not have.*attestation/.test(text)) {
    return { status: "missing", reasonCodes: ["attestation.missing"] };
  }
  if (/subject|digest|source.*mismatch|does not match/.test(text)) {
    return { status: "subject-mismatch", reasonCodes: ["attestation.subject-mismatch"] };
  }
  if (/untrusted|trust root|certificate|issuer|identity|repository|workflow/.test(text)) {
    return { status: "untrusted", reasonCodes: ["attestation.identity-untrusted"] };
  }
  if (/invalid|signature|verification failed|failed to verify/.test(text)) {
    return { status: "invalid", reasonCodes: ["attestation.invalid"] };
  }
  return { status: "invalid", reasonCodes: ["attestation.verifier-failed"] };
}

function runGh(args: string[], cwd: string): GhResult {
  try {
    const result = spawnSync("gh", args, {
      cwd,
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 256 * 1024
    });
    return {
      status: result.status,
      stdout: bounded(result.stdout ?? "", 256 * 1024),
      stderr: bounded(result.stderr ?? "", 4_000),
      error: result.error
    };
  } catch (error) {
    return { status: null, stdout: "", stderr: "", error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function policyFromContext(context: AttestationVerificationContext): AttestationVerificationResult["policy"] {
  return {
    repository: normalizeRepository(context.repository),
    signerWorkflow: normalizeWorkflow(context.signerWorkflow),
    predicateType: context.predicateType ?? DEFAULT_ATTESTATION_PREDICATE,
    sourceCommit: context.sourceCommit,
    sourceRef: context.sourceRef
  };
}

function baseResult(
  context: AttestationVerificationContext,
  artifactLocator: string,
  artifactDigest: string,
  policy: AttestationVerificationResult["policy"],
  status: AttestationVerificationStatus,
  reasonCodes: string[],
  exitStatus?: number,
  identity?: AttestationIdentitySummary
): AttestationVerificationResult {
  const root = context.root ?? process.cwd();
  return {
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    taskId: context.taskId,
    status,
    artifact: { locator: artifactLocator, digest: artifactDigest },
    attestation: {
      locator: context.bundle ? safeLocator(root, path.resolve(root, context.bundle), "offline-bundle") : "github:artifact-attestation",
      ...(context.bundle ? { bundle: safeLocator(root, path.resolve(root, context.bundle), "offline-bundle") } : {}),
      ...(context.customTrustedRoot ? { trustedRoot: safeLocator(root, path.resolve(root, context.customTrustedRoot), "offline-trusted-root") } : {})
    },
    ...(identity ? { identity } : {}),
    verifier: { name: "gh attestation verify", ...(exitStatus !== undefined ? { exitStatus } : {}) },
    reasonCodes: [...new Set(reasonCodes)].slice(0, 12),
    verifiedAt: context.now ?? new Date().toISOString(),
    policy
  };
}

export function verifyAttestation(root: string, context: AttestationVerificationContext): AttestationVerificationResult {
  const artifactPath = path.resolve(root, context.artifact);
  const artifactLocator = safeLocator(root, artifactPath);
  const policy = policyFromContext(context);
  if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
    return baseResult(context, artifactLocator, "sha256:" + "0".repeat(64), policy, "unavailable", ["artifact.unavailable"]);
  }
  const artifactDigest = digestFile(artifactPath);
  if (!context.evidence) {
    return baseResult(context, artifactLocator, artifactDigest, policy, "unavailable", ["evidence.missing"]);
  }
  const evidenceSubject = context.evidence.subjectHeadCommit ?? context.evidence.git?.subjectHeadCommit ?? context.evidence.commit;
  const evidenceRef = context.evidence.git?.branch;
  const repository = policy.repository;
  const signerWorkflow = policy.signerWorkflow ?? normalizeWorkflow(context.evidence.ciReceipt?.workflowPath);
  const sourceCommit = context.sourceCommit ?? evidenceSubject;
  const sourceRef = context.sourceRef ?? evidenceRef;
  const effectivePolicy = { ...policy, repository, signerWorkflow, sourceCommit, sourceRef };
  const evidenceBindingMismatches: string[] = [];
  if (context.sourceCommit && evidenceSubject && context.sourceCommit !== evidenceSubject) evidenceBindingMismatches.push("policy.source-commit-mismatch");
  if (context.sourceRef && evidenceRef && context.sourceRef !== evidenceRef) evidenceBindingMismatches.push("policy.source-ref-mismatch");
  if (context.evidence.git?.subjectHeadCommit && evidenceSubject !== context.evidence.git.subjectHeadCommit) evidenceBindingMismatches.push("evidence.subject-internal-mismatch");
  if (context.evidence.ciReceipt?.headCommit && evidenceSubject !== context.evidence.ciReceipt.headCommit) evidenceBindingMismatches.push("evidence.ci-subject-mismatch");
  if (evidenceBindingMismatches.length > 0) {
    return baseResult(context, artifactLocator, artifactDigest, effectivePolicy, "subject-mismatch", evidenceBindingMismatches);
  }
  const missingPolicy: string[] = [];
  if (!repository) missingPolicy.push("policy.repository.unknown");
  if (!signerWorkflow) missingPolicy.push("policy.signer-workflow.unknown");
  if (!sourceCommit) missingPolicy.push("policy.source-commit.unknown");
  if (!sourceRef) missingPolicy.push("policy.source-ref.unknown");
  if (context.bundle && !context.customTrustedRoot) missingPolicy.push("offline.trusted-root.required");
  if (context.customTrustedRoot && !context.bundle) missingPolicy.push("offline.bundle.required");
  if (missingPolicy.length > 0) {
    return baseResult(context, artifactLocator, artifactDigest, effectivePolicy, "untrusted", missingPolicy);
  }
  const args = [
    "attestation", "verify", artifactPath,
    "--format", "json",
    "--repo", repository!,
    "--signer-workflow", signerWorkflow!,
    "--predicate-type", effectivePolicy.predicateType!,
    "--source-digest", sourceCommit!,
    "--source-ref", sourceRef!
  ];
  if (context.bundle) args.push("--bundle", path.resolve(root, context.bundle), "--custom-trusted-root", path.resolve(root, context.customTrustedRoot!));
  const command = runGh(args, root);
  if (command.error && command.status === null) {
    return baseResult(context, artifactLocator, artifactDigest, effectivePolicy, "unavailable", ["verifier.unavailable"], undefined);
  }
  if (command.status !== 0) {
    const failure = classifyFailure(command.stderr, command.stdout);
    return baseResult(context, artifactLocator, artifactDigest, effectivePolicy, failure.status, failure.reasonCodes, command.status ?? undefined);
  }
  const parsed = parseVerifierOutput(command.stdout);
  if (!parsed) return baseResult(context, artifactLocator, artifactDigest, effectivePolicy, "invalid", ["verifier.output.invalid"], command.status ?? undefined);
  const identity = parsed.identity;
  const reasons: string[] = [];
  if (identity.repository !== repository) reasons.push("attestation.repository-mismatch");
  if (identity.signerWorkflow !== signerWorkflow) reasons.push("attestation.workflow-mismatch");
  if (identity.predicateType !== effectivePolicy.predicateType) reasons.push("attestation.predicate-mismatch");
  if (identity.sourceCommit !== sourceCommit) reasons.push("attestation.source-commit-mismatch");
  if (identity.sourceRef !== sourceRef) reasons.push("attestation.source-ref-mismatch");
  if (!parsed.subjectDigests.includes(artifactDigest)) reasons.push("attestation.artifact-digest-mismatch");
  if (parsed.verificationResult && !["passed", "verified", "success"].includes(parsed.verificationResult.toLowerCase())) reasons.push("attestation.verification-failed");
  if (reasons.length > 0) {
    const subjectReason = reasons.some((reason) => reason.includes("digest") || reason.includes("source") || reason.includes("artifact"));
    return baseResult(context, artifactLocator, artifactDigest, effectivePolicy, subjectReason ? "subject-mismatch" : "untrusted", reasons, command.status ?? undefined, identity);
  }
  return baseResult(context, artifactLocator, artifactDigest, effectivePolicy, "verified", [], command.status ?? undefined, identity);
}

export function toAttestationEvidence(record: AttestationVerificationResult): AttestationVerificationRecord {
  return {
    schemaVersion: record.schemaVersion,
    status: record.status,
    artifact: record.artifact,
    attestation: record.attestation,
    ...(record.identity ? { identity: record.identity } : {}),
    verifier: record.verifier,
    reasonCodes: record.reasonCodes,
    verifiedAt: record.verifiedAt
  };
}
