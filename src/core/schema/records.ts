import type { ErrorObject } from "ajv";
import type { ApprovalRecord, BlockRecord, Evidence, Issue, ReviewRecord, RiskRecord } from "../types.js";
import { taskIdPatternSource } from "../paths.js";
import { ajv, formatSchemaPath, isObject, isStringArray, issue, stringArraySchema } from "./shared.js";

const coverageMetricSchema = {
  type: "object",
  required: ["total", "covered", "skipped", "percent"],
  additionalProperties: false,
  properties: {
    total: { type: "number", minimum: 0 },
    covered: { type: "number", minimum: 0 },
    skipped: { type: "number", minimum: 0 },
    percent: { type: "number", minimum: 0, maximum: 100 }
  }
};

const coverageCountsSchema = {
  type: "object",
  required: ["total", "passed", "failed", "skipped"],
  additionalProperties: false,
  properties: {
    total: { type: "number", minimum: 0 },
    passed: { type: "number", minimum: 0 },
    failed: { type: "number", minimum: 0 },
    skipped: { type: "number", minimum: 0 }
  }
};

const testQualityObservationSchema = {
  type: "object",
  required: ["version", "status", "subject", "tests", "coverage", "assertionDelta"],
  additionalProperties: false,
  properties: {
    version: { const: "1" },
    status: { enum: ["evaluated", "not-evaluated"] },
    subject: {
      type: "object",
      additionalProperties: false,
      properties: {
        baseCommit: { type: "string", minLength: 1 },
        headCommit: { type: "string", minLength: 1 },
        diffHash: { type: "string", minLength: 1 }
      }
    },
    tests: {
      type: "object",
      required: ["filesAdded", "filesModified", "filesDeleted", "skippedMarkersAdded"],
      additionalProperties: false,
      properties: {
        filesAdded: { type: "integer", minimum: 0 },
        filesModified: { type: "integer", minimum: 0 },
        filesDeleted: { type: "integer", minimum: 0 },
        skippedMarkersAdded: { type: "integer", minimum: 0 }
      }
    },
    coverage: {
      type: "object",
      required: ["status"],
      additionalProperties: false,
      properties: {
        status: { enum: ["evaluated", "not-evaluated"] },
        baselineSubjectHeadCommit: { type: "string", minLength: 1 },
        baselineLines: { type: "number", minimum: 0, maximum: 100 },
        subjectLines: { type: "number", minimum: 0, maximum: 100 },
        deltaLines: { type: "number" },
        source: { const: "coverage-receipt" },
        reason: { type: "string", minLength: 1 }
      }
    },
    assertionDelta: {
      type: "object",
      required: ["status", "method"],
      additionalProperties: false,
      properties: {
        status: { const: "not-evaluated" },
        method: { const: "phase-2-out-of-scope" }
      }
    }
  }
};

const attestationVerificationSchema = {
  type: "object",
  required: ["schemaVersion", "status", "artifact", "attestation", "verifier", "reasonCodes", "verifiedAt"],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: "scwbs.attestation-verification.v1" },
    status: { enum: ["verified", "missing", "invalid", "subject-mismatch", "untrusted", "unavailable"] },
    artifact: {
      type: "object",
      required: ["locator", "digest"],
      additionalProperties: false,
      properties: {
        locator: { type: "string", minLength: 1, maxLength: 256 },
        digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" }
      }
    },
    attestation: {
      type: "object",
      required: ["locator"],
      additionalProperties: false,
      properties: {
        locator: { type: "string", minLength: 1, maxLength: 256 },
        bundle: { type: "string", minLength: 1, maxLength: 256 },
        trustedRoot: { type: "string", minLength: 1, maxLength: 256 }
      }
    },
    identity: {
      type: "object",
      additionalProperties: false,
      properties: {
        repository: { type: "string", minLength: 1, maxLength: 256 },
        signerWorkflow: { type: "string", minLength: 1, maxLength: 256 },
        predicateType: { type: "string", minLength: 1, maxLength: 256 },
        sourceCommit: { type: "string", minLength: 1, maxLength: 128 },
        sourceRef: { type: "string", minLength: 1, maxLength: 256 },
        issuer: { type: "string", minLength: 1, maxLength: 256 }
      }
    },
    verifier: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { const: "gh attestation verify" },
        exitStatus: { type: "integer", minimum: 0, maximum: 255 }
      }
    },
    reasonCodes: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 128 } },
    verifiedAt: { type: "string", minLength: 1, maxLength: 64 }
  }
};

const requirementEvidenceSchema = {
  type: "object",
  required: ["requirementId", "status", "references"],
  additionalProperties: false,
  properties: {
    requirementId: { type: "string", pattern: "^[A-Z][A-Z0-9._-]*$" },
    status: { type: "string", enum: ["covered", "manual-required", "not-covered"] },
    references: { type: "array", items: { type: "string", minLength: 1 } },
    checkNames: { type: "array", items: { type: "string", minLength: 1 } },
    subjectHeadCommit: { type: "string", minLength: 1 },
    diffHash: { type: "string", minLength: 1 }
  }
};

const evidenceSchema = {
  type: "object",
  required: ["id", "type", "taskId", "changedFiles", "checks"],
  additionalProperties: true,
  properties: {
    id: { type: "string", minLength: 1 },
    type: { const: "evidence" },
    taskId: { type: "string", minLength: 1, pattern: taskIdPatternSource },
    commit: { type: "string" },
    subjectHeadCommit: { type: "string" },
    evidenceCommit: { type: "string" },
    diffHash: { type: "string" },
    provenance: {
      type: "object",
      required: ["schemaVersion", "subject", "retention"],
      additionalProperties: false,
      properties: {
        schemaVersion: { const: "1.0.0" },
        subject: {
          type: "object",
          required: ["commit", "treeHash", "diffHash", "canonicalization"],
          additionalProperties: false,
          properties: {
            commit: { type: "string", pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$" },
            treeHash: { type: "string", pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$" },
            diffHash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
            canonicalization: { const: "git-diff-binary-v1" }
          }
        },
        retention: {
          type: "object",
          required: ["mode", "locator"],
          additionalProperties: false,
          properties: {
            mode: { enum: ["git-object", "patch-artifact", "bundle"] },
            locator: { type: "string", minLength: 1 },
            manifestHash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" }
          }
        }
      }
    },
    ciReceipt: {
      type: "object",
      required: [
        "schemaVersion", "repository", "pullRequest", "taskId", "headCommit", "baseRef", "baseCommit",
        "diffHash", "authorityFingerprint", "workflowPath", "workflowRunId", "workflowRunUrl", "trustedCommit",
        "retrievedAt", "verifiedBy", "jobs"
      ],
      additionalProperties: false,
      properties: {
        schemaVersion: { const: "1.0.0" },
        repository: { type: "string", minLength: 1 },
        pullRequest: { type: "string", minLength: 1 },
        taskId: { type: "string", minLength: 1 },
        headCommit: { type: "string", minLength: 1 },
        baseRef: { type: "string", minLength: 1 },
        baseCommit: { type: "string", minLength: 1 },
        diffHash: { type: "string", minLength: 1 },
        authorityFingerprint: { type: "string", minLength: 1 },
        workflowPath: { const: ".github/workflows/scwbs.yml" },
        workflowRunId: { type: "string", minLength: 1 },
        workflowRunUrl: { type: "string", minLength: 1 },
        trustedCommit: { type: "string", minLength: 1 },
        retrievedAt: { type: "string", minLength: 1 },
        verifiedBy: { const: "github-actions-provenance" },
        jobs: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "checkNames", "jobId", "conclusion", "url", "workflowRunId", "workflowPath"],
            additionalProperties: false,
            properties: {
              name: { type: "string", minLength: 1 },
              checkNames: { type: "array", minItems: 0, items: { type: "string", minLength: 1 } },
              jobId: { type: "string", minLength: 1 },
              conclusion: { const: "success" },
              url: { type: "string", minLength: 1 },
              workflowRunId: { type: "string", minLength: 1 },
              workflowPath: { const: ".github/workflows/scwbs.yml" }
            }
          }
        }
      }
    },
    coverageReceipt: {
      type: "object",
      required: [
        "schemaVersion", "command", "scope", "subjectHeadCommit", "workflowPath", "workflowRunId",
        "workflowRunUrl", "artifactName", "payloadDigest", "testFiles", "tests", "metrics", "skippedTests", "generatedAt"
      ],
      additionalProperties: false,
      properties: {
        schemaVersion: { const: "1.0.0" },
        command: { type: "string", minLength: 1 },
        scope: { type: "string", minLength: 1 },
        repository: { type: "string", minLength: 1 },
        taskId: { type: "string", minLength: 1 },
        pullRequest: { type: "string", pattern: "^[1-9][0-9]*$" },
        subjectHeadCommit: { type: "string", pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$" },
        workflowPath: { const: ".github/workflows/scwbs.yml" },
        workflowRunId: { type: "string", minLength: 1 },
        workflowRunUrl: { type: "string", minLength: 1 },
        artifactName: { type: "string", minLength: 1 },
        artifactDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        payloadDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        testFiles: coverageCountsSchema,
        tests: coverageCountsSchema,
        metrics: {
          type: "object",
          required: ["statements", "branches", "functions", "lines"],
          additionalProperties: false,
          properties: {
            statements: coverageMetricSchema,
            branches: coverageMetricSchema,
            functions: coverageMetricSchema,
            lines: coverageMetricSchema
          }
        },
        skippedTests: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "reason"],
            additionalProperties: false,
            properties: {
              name: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1 }
            }
          }
        },
        generatedAt: { type: "string", minLength: 1 }
      }
    },
    attestationVerification: attestationVerificationSchema,
    changedFiles: stringArraySchema,
    requirementEvidence: { type: "array", uniqueItems: true, items: requirementEvidenceSchema },
    submodules: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "repository", "baseCommit", "headCommit", "changedFiles", "upstreamRef", "upstreamReachable"],
        additionalProperties: true,
        properties: {
          path: { type: "string", minLength: 1 },
          repository: { type: "string", minLength: 1 },
          baseCommit: { type: "string", minLength: 1 },
          headCommit: { type: "string", minLength: 1 },
          changedFiles: stringArraySchema,
          pullRequest: { type: "string", minLength: 1 },
          upstreamRef: { type: "string", minLength: 1 },
          upstreamReachable: { type: "boolean" },
          checks: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "status"],
              additionalProperties: true,
              properties: {
                name: { type: "string", minLength: 1 },
                status: { type: "string", minLength: 1 },
                url: { type: "string", minLength: 1 }
              }
            }
          }
        }
      }
    },
    git: {
      type: "object",
      additionalProperties: true,
      properties: {
        branch: { type: "string" },
        base: { type: "string" },
        baseCommit: { type: "string" },
        changedFilesBasis: { type: "string" },
        subjectHeadCommit: { type: "string" },
        diffHash: { type: "string" },
        headCommit: { type: "string" },
        pullRequest: { type: "string" }
      }
    },
    checks: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "status"],
        additionalProperties: true,
        properties: {
          name: { type: "string", minLength: 1 },
          status: { type: "string", enum: ["passed", "failed", "skipped"] },
          source: { type: "string" },
          runId: { type: "string" },
          url: { type: "string" },
          command: { type: "string" },
          cacheKey: { type: "string" },
          exitStatus: { type: "number" },
          stdoutSummary: { type: "string" },
          stderrSummary: { type: "string" },
          executedAt: { type: "string" },
          durationMilliseconds: { type: "number", minimum: 0 },
          verifiedBy: { type: "string" }
        }
      }
    },
    testQuality: {
      type: "object",
      additionalProperties: true,
      properties: {
        assertionsAdded: { type: "boolean" },
        testsDisabled: { type: "boolean" },
        coverageDecreased: { type: "boolean" },
        notes: stringArraySchema
      }
    },
    testQualityObservation: testQualityObservationSchema,
    notes: stringArraySchema
  }
};

const approvalRecordSchema = {
  type: "object",
  required: ["id", "type", "taskId", "status"],
  additionalProperties: true,
  properties: {
    id: { type: "string", minLength: 1 },
    type: { const: "approval" },
    taskId: { type: "string", minLength: 1, pattern: taskIdPatternSource },
    status: { type: "string", enum: ["requested", "approved", "rejected"] },
    requestedAt: { type: "string" },
    approvedBy: { type: "string" },
    approvedAt: { type: "string" },
    headCommit: { type: "string" },
    diffHash: { type: "string" },
    pullRequest: { type: "string" },
    reason: { type: "string" },
    approvalMode: { type: "string", enum: ["human", "delegated"] },
    actorId: { type: "string", minLength: 1 },
    actorSource: { type: "string", minLength: 1 },
    actorUrl: { type: "string", minLength: 1 },
    verifiedAt: { type: "string", minLength: 1 },
    verificationLevel: { type: "string", minLength: 1 },
    delegationSource: { type: "string" },
    delegatedBy: { type: "string" },
    executedBy: { const: "ai-agent" },
    delegationScope: { type: "string", enum: ["human-gate", "post-finish"] },
    delegationProof: { type: "string", pattern: "^hmac-sha256:[a-f0-9]{64}$" },
    notes: stringArraySchema
  }
};

const blockRecordSchema = {
  type: "object",
  required: ["id", "type", "taskId", "status", "level", "category", "reason", "requiredHumanDecision", "createdAt"],
  additionalProperties: true,
  properties: {
    id: { type: "string", minLength: 1 },
    type: { const: "block" },
    taskId: { type: "string", minLength: 1, pattern: taskIdPatternSource },
    status: { type: "string", enum: ["blocked", "resolved"] },
    level: { type: "integer", enum: [1, 2] },
    category: { type: "string", enum: ["db", "auth", "permission", "security", "breaking-api", "business-rule", "human-gate", "external-service", "unknown"] },
    reason: { type: "string", minLength: 1 },
    requiredHumanDecision: { type: "string", minLength: 1 },
    createdAt: { type: "string", minLength: 1 },
    resolvedAt: { type: "string", minLength: 1 },
    resolvedBy: { const: "human" },
    resolution: { type: "string", minLength: 1 },
    history: {
      type: "array",
      items: {
        type: "object",
        required: ["status", "at", "reason", "by"],
        additionalProperties: false,
        properties: {
          status: { type: "string", enum: ["blocked", "resolved"] },
          at: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1 },
          by: { type: "string", enum: ["ai-agent", "human"] }
        }
      }
    }
  }
};

const reviewRecordSchema = {
  type: "object",
  required: ["id", "type", "taskId", "status", "reviewProfile", "groundTruth"],
  additionalProperties: true,
  properties: {
    id: { type: "string", minLength: 1 },
    type: { const: "review" },
    taskId: { type: "string", minLength: 1, pattern: taskIdPatternSource },
    status: { type: "string", enum: ["requested", "approved", "changes-requested", "closed"] },
    reviewProfile: { type: "string", minLength: 1 },
    headCommit: { type: "string" },
    diffHash: { type: "string" },
    pullRequest: { type: "string" },
    groundTruth: stringArraySchema,
    requestedReviewers: {
      type: "array",
      items: {
        type: "object",
        required: ["role", "reason"],
        additionalProperties: true,
        properties: {
          role: { type: "string", minLength: 1 },
          user: { type: "string" },
          reason: { type: "string", minLength: 1 }
        }
      }
    },
    notes: stringArraySchema,
    reviewedBy: { type: "string" },
    reviewedAt: { type: "string" },
    findings: stringArraySchema
  }
};

const riskRecordSchema = {
  type: "object",
  required: ["schemaVersion", "id", "type", "title", "status", "scope", "assessment", "treatment", "residualRisk", "createdAt"],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: "scwbs.risk.v1" },
    id: { type: "string", pattern: "^RISK-[A-Z0-9][A-Z0-9._-]*$" },
    type: { const: "risk" },
    title: { type: "string", minLength: 1 },
    status: { enum: ["open", "mitigated", "accepted", "closed"] },
    scope: {
      type: "object",
      required: ["specs", "tasks", "requirements"],
      additionalProperties: false,
      properties: {
        specs: { type: "array", items: { type: "string", minLength: 1 } },
        tasks: { type: "array", items: { type: "string", minLength: 1 } },
        requirements: { type: "array", items: { type: "string", minLength: 1 } }
      }
    },
    assessment: {
      type: "object",
      required: ["likelihood", "impact", "score", "level"],
      additionalProperties: false,
      properties: {
        likelihood: { type: "integer", minimum: 1, maximum: 5 },
        impact: { type: "integer", minimum: 1, maximum: 5 },
        score: { type: "integer", minimum: 1, maximum: 25 },
        level: { enum: ["low", "medium", "high", "critical"] }
      }
    },
    treatment: {
      type: "object",
      required: ["strategy", "owner", "actions", "verification"],
      additionalProperties: false,
      properties: {
        strategy: { enum: ["avoid", "mitigate", "transfer", "accept"] },
        owner: { type: "string", minLength: 1 },
        actions: { type: "array", items: { type: "string", minLength: 1 } },
        verification: { type: "array", items: { type: "string", minLength: 1 } }
      }
    },
    residualRisk: {
      type: "object",
      required: ["likelihood", "impact", "score", "level"],
      additionalProperties: false,
      properties: {
        likelihood: { type: "integer", minimum: 1, maximum: 5 },
        impact: { type: "integer", minimum: 1, maximum: 5 },
        score: { type: "integer", minimum: 1, maximum: 25 },
        level: { enum: ["low", "medium", "high", "critical"] }
      }
    },
    acceptance: {
      type: "object",
      required: ["acceptedBy", "acceptedAt", "reason"],
      additionalProperties: false,
      properties: {
        acceptedBy: { const: "human" },
        acceptedAt: { type: "string", minLength: 1 },
        subjectHeadCommit: { type: "string", minLength: 1 },
        diffHash: { type: "string", minLength: 1 },
        scopeFingerprint: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
        reason: { type: "string", minLength: 1 }
      }
    },
    createdAt: { type: "string", minLength: 1 },
    updatedAt: { type: "string", minLength: 1 }
  }
};

const validateEvidenceAjv = ajv.compile(evidenceSchema);
const validateApprovalAjv = ajv.compile(approvalRecordSchema);
const validateBlockAjv = ajv.compile(blockRecordSchema);
const validateReviewAjv = ajv.compile(reviewRecordSchema);
const validateRiskAjv = ajv.compile(riskRecordSchema);

function schemaIssues(validate: ReturnType<typeof ajv.compile>, kind: string, value: unknown, filePath: string): Issue[] {
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error: ErrorObject) =>
    issue(`${kind}.schema`, `${filePath}.${formatSchemaPath(error)} ${error.message ?? "does not match schema"}`)
  );
}

/* ── Evidence ── */

export function validateEvidenceSchema(value: unknown, filePath = "evidence"): Issue[] {
  return schemaIssues(validateEvidenceAjv, "evidence", value, filePath);
}

export function asEvidence(value: unknown): Evidence {
  return value as Evidence;
}

export function validateEvidence(value: unknown, filePath = "evidence"): Issue[] {
  const issues: Issue[] = [];
  if (!isObject(value)) return [issue("evidence.invalid", `${filePath} must be an object`)];
  for (const key of ["id", "type", "taskId"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      issues.push(issue("evidence.field", `${filePath}.${key} must be a non-empty string`));
    }
  }
  if (value.type !== "evidence") {
    issues.push(issue("evidence.type", `${filePath}.type must be evidence`));
  }
  for (const key of ["commit", "subjectHeadCommit", "evidenceCommit", "diffHash"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      issues.push(issue("evidence.field", `${filePath}.${key} must be a string when present`));
    }
  }
  if (value.provenance !== undefined && !isObject(value.provenance)) {
    issues.push(issue("evidence.provenance", `${filePath}.provenance must be an object when present`));
  }
  if (!isStringArray(value.changedFiles)) {
    issues.push(issue("evidence.changedFiles", `${filePath}.changedFiles must be a string array`));
  }
  if (value.requirementEvidence !== undefined) {
    if (!Array.isArray(value.requirementEvidence)) {
      issues.push(issue("evidence.requirementEvidence", `${filePath}.requirementEvidence must be an array when present`));
    } else {
      const ids = new Set<string>();
      value.requirementEvidence.forEach((entry, index) => {
        if (!isObject(entry)) {
          issues.push(issue("evidence.requirementEvidence", `${filePath}.requirementEvidence[${index}] must be an object`));
          return;
        }
        if (typeof entry.requirementId !== "string" || entry.requirementId.length === 0) {
          issues.push(issue("evidence.requirementEvidence", `${filePath}.requirementEvidence[${index}].requirementId must be a non-empty string`));
        } else if (ids.has(entry.requirementId)) {
          issues.push(issue("evidence.requirementEvidence.duplicate", `${filePath}.requirementEvidence contains duplicate id ${entry.requirementId}`));
        } else {
          ids.add(entry.requirementId);
        }
        if (!["covered", "manual-required", "not-covered"].includes(String(entry.status))) {
          issues.push(issue("evidence.requirementEvidence.status", `${filePath}.requirementEvidence[${index}].status is invalid`));
        }
        if (!isStringArray(entry.references)) {
          issues.push(issue("evidence.requirementEvidence.references", `${filePath}.requirementEvidence[${index}].references must be a string array`));
        }
      });
    }
  }
  if (value.submodules !== undefined && !Array.isArray(value.submodules)) {
    issues.push(issue("evidence.submodules", `${filePath}.submodules must be an array when present`));
  }
  if (value.git !== undefined) {
    if (!isObject(value.git)) {
      issues.push(issue("evidence.git", `${filePath}.git must be an object when present`));
    } else {
      for (const key of ["branch", "base", "baseCommit", "changedFilesBasis", "subjectHeadCommit", "diffHash", "headCommit", "pullRequest"]) {
        if (value.git[key] !== undefined && typeof value.git[key] !== "string") {
          issues.push(issue("evidence.git", `${filePath}.git.${key} must be a string when present`));
        }
      }
    }
  }
  if (!Array.isArray(value.checks)) {
    issues.push(issue("evidence.checks", `${filePath}.checks must be an array`));
  } else {
    value.checks.forEach((check, index) => {
      if (!isObject(check) || typeof check.name !== "string" || typeof check.status !== "string") {
        issues.push(issue("evidence.check", `${filePath}.checks[${index}] must include name and status`));
        return;
      }
      for (const key of ["source", "runId", "url", "command", "cacheKey", "stdoutSummary", "stderrSummary", "executedAt", "verifiedBy"]) {
        if (check[key] !== undefined && typeof check[key] !== "string") {
          issues.push(issue("evidence.check", `${filePath}.checks[${index}].${key} must be a string when present`));
        }
      }
      if (check.exitStatus !== undefined && typeof check.exitStatus !== "number") {
        issues.push(issue("evidence.check", `${filePath}.checks[${index}].exitStatus must be a number when present`));
      }
    });
  }
  if (value.testQuality !== undefined) {
    if (!isObject(value.testQuality)) {
      issues.push(issue("evidence.testQuality", `${filePath}.testQuality must be an object when present`));
    } else {
      for (const key of ["assertionsAdded", "testsDisabled", "coverageDecreased"]) {
        if (value.testQuality[key] !== undefined && typeof value.testQuality[key] !== "boolean") {
          issues.push(issue("evidence.testQuality", `${filePath}.testQuality.${key} must be a boolean when present`));
        }
      }
      if (value.testQuality.notes !== undefined && !isStringArray(value.testQuality.notes)) {
        issues.push(issue("evidence.testQuality", `${filePath}.testQuality.notes must be a string array when present`));
      }
    }
  }
  if (value.testQualityObservation !== undefined && !isObject(value.testQualityObservation)) {
    issues.push(issue("evidence.testQualityObservation", `${filePath}.testQualityObservation must be an object when present`));
  }
  return issues;
}

/* ── Approval Record ── */

export function validateApprovalRecordSchema(value: unknown, filePath = "approval"): Issue[] {
  return schemaIssues(validateApprovalAjv, "approval", value, filePath);
}

export function asApprovalRecord(value: unknown): ApprovalRecord {
  return value as ApprovalRecord;
}

export function validateApprovalRecord(value: unknown, filePath = "approval"): Issue[] {
  const issues: Issue[] = [];
  if (!isObject(value)) return [issue("approval.invalid", `${filePath} must be an object`)];
  for (const key of ["id", "type", "taskId", "status"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      issues.push(issue("approval.field", `${filePath}.${key} must be a non-empty string`));
    }
  }
  if (value.type !== "approval") {
    issues.push(issue("approval.type", `${filePath}.type must be approval`));
  }
  if (value.status !== undefined && !["requested", "approved", "rejected"].includes(String(value.status))) {
    issues.push(issue("approval.status", `${filePath}.status must be requested, approved, or rejected`));
  }
  for (const key of ["requestedAt", "approvedBy", "approvedAt", "headCommit", "diffHash", "pullRequest", "reason", "approvalMode", "actorId", "actorSource", "actorUrl", "verifiedAt", "verificationLevel", "delegationSource", "delegatedBy", "executedBy", "delegationScope", "delegationProof"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      issues.push(issue("approval.field", `${filePath}.${key} must be a string when present`));
    }
  }
  if (value.notes !== undefined && !isStringArray(value.notes)) {
    issues.push(issue("approval.notes", `${filePath}.notes must be a string array when present`));
  }
  if (value.status === "approved") {
    for (const key of ["approvedBy", "approvedAt"]) {
      if (typeof value[key] !== "string" || value[key].length === 0) {
        issues.push(issue("approval.status", `${filePath}.${key} must be present when status is approved`));
      }
    }
    if (value.approvalMode === "delegated") {
      for (const key of ["delegationSource", "delegatedBy", "executedBy", "delegationScope", "delegationProof", "headCommit", "diffHash"]) {
        if (typeof value[key] !== "string" || value[key].length === 0) {
          issues.push(issue("approval.delegation", `${filePath}.${key} must be present for delegated approval`));
        }
      }
      if (value.executedBy !== "ai-agent") {
        issues.push(issue("approval.delegation", `${filePath}.executedBy must be ai-agent for delegated approval`));
      }
      if (value.approvedBy !== `delegated:${String(value.delegatedBy ?? "")}`) {
        issues.push(issue("approval.delegation", `${filePath}.approvedBy must identify the delegatedBy principal`));
      }
    } else if (["delegationSource", "delegatedBy", "executedBy", "delegationScope", "delegationProof"].some((key) => value[key] !== undefined)) {
      issues.push(issue("approval.delegation", `${filePath} delegation fields require approvalMode delegated`));
    }
  }
  return issues;
}

/* ── Block Record ── */

export function validateBlockRecordSchema(value: unknown, filePath = "block"): Issue[] {
  return schemaIssues(validateBlockAjv, "block", value, filePath);
}

export function asBlockRecord(value: unknown): BlockRecord {
  return value as BlockRecord;
}

export function validateBlockRecord(value: unknown, filePath = "block"): Issue[] {
  const issues: Issue[] = [];
  if (!isObject(value)) return [issue("block.invalid", `${filePath} must be an object`)];
  for (const key of ["id", "type", "taskId", "status", "category", "reason", "requiredHumanDecision", "createdAt"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      issues.push(issue("block.field", `${filePath}.${key} must be a non-empty string`));
    }
  }
  if (value.type !== "block") {
    issues.push(issue("block.type", `${filePath}.type must be block`));
  }
  if (value.status !== "blocked" && value.status !== "resolved") {
    issues.push(issue("block.status", `${filePath}.status must be blocked or resolved`));
  }
  if (value.level !== 1 && value.level !== 2) {
    issues.push(issue("block.level", `${filePath}.level must be 1 or 2`));
  }
  if (value.category !== undefined && !["db", "auth", "permission", "security", "breaking-api", "business-rule", "human-gate", "external-service", "unknown"].includes(String(value.category))) {
    issues.push(issue("block.category", `${filePath}.category is not a known stop category`));
  }
  if (value.status === "resolved") {
    for (const key of ["resolvedAt", "resolvedBy", "resolution"]) {
      if (typeof value[key] !== "string" || value[key].trim().length === 0) {
        issues.push(issue("block.resolution", `${filePath}.${key} must be present when status is resolved`));
      }
    }
    if (value.resolvedBy !== "human") {
      issues.push(issue("block.resolution", `${filePath}.resolvedBy must be human`));
    }
  }
  if (value.history !== undefined) {
    if (!Array.isArray(value.history)) {
      issues.push(issue("block.history", `${filePath}.history must be an array when present`));
    } else {
      value.history.forEach((entry, index) => {
        if (!isObject(entry)) {
          issues.push(issue("block.history", `${filePath}.history[${index}] must be an object`));
          return;
        }
        if (entry.status !== "blocked" && entry.status !== "resolved") {
          issues.push(issue("block.history", `${filePath}.history[${index}].status must be blocked or resolved`));
        }
        if (entry.by !== "ai-agent" && entry.by !== "human") {
          issues.push(issue("block.history", `${filePath}.history[${index}].by must be ai-agent or human`));
        }
        for (const key of ["at", "reason"]) {
          if (typeof entry[key] !== "string" || entry[key].trim().length === 0) {
            issues.push(issue("block.history", `${filePath}.history[${index}].${key} must be a non-empty string`));
          }
        }
      });
    }
  }
  return issues;
}

/* ── Review Record ── */

export function validateReviewRecordSchema(value: unknown, filePath = "review"): Issue[] {
  return schemaIssues(validateReviewAjv, "review", value, filePath);
}

export function asReviewRecord(value: unknown): ReviewRecord {
  return value as ReviewRecord;
}

export function validateReviewRecord(value: unknown, filePath = "review"): Issue[] {
  const issues: Issue[] = [];
  if (!isObject(value)) return [issue("review.invalid", `${filePath} must be an object`)];
  for (const key of ["id", "type", "taskId", "status", "reviewProfile"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      issues.push(issue("review.field", `${filePath}.${key} must be a non-empty string`));
    }
  }
  if (value.type !== "review") {
    issues.push(issue("review.type", `${filePath}.type must be review`));
  }
  if (value.status !== undefined && !["requested", "approved", "changes-requested", "closed"].includes(String(value.status))) {
    issues.push(issue("review.status", `${filePath}.status must be requested, approved, changes-requested, or closed`));
  }
  for (const key of ["headCommit", "diffHash", "pullRequest", "reviewedBy", "reviewedAt"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      issues.push(issue("review.field", `${filePath}.${key} must be a string when present`));
    }
  }
  if (!isStringArray(value.groundTruth)) {
    issues.push(issue("review.groundTruth", `${filePath}.groundTruth must be a string array`));
  }
  if (value.requestedReviewers !== undefined) {
    if (!Array.isArray(value.requestedReviewers)) {
      issues.push(issue("review.requestedReviewers", `${filePath}.requestedReviewers must be an array when present`));
    } else {
      value.requestedReviewers.forEach((reviewer, index) => {
        if (!isObject(reviewer)) {
          issues.push(issue("review.requestedReviewers", `${filePath}.requestedReviewers[${index}] must be an object`));
          return;
        }
        for (const key of ["role", "reason"]) {
          if (typeof reviewer[key] !== "string" || reviewer[key].length === 0) {
            issues.push(issue("review.requestedReviewers", `${filePath}.requestedReviewers[${index}].${key} must be a non-empty string`));
          }
        }
        if (reviewer.user !== undefined && typeof reviewer.user !== "string") {
          issues.push(issue("review.requestedReviewers", `${filePath}.requestedReviewers[${index}].user must be a string when present`));
        }
      });
    }
  }
  if (value.notes !== undefined && !isStringArray(value.notes)) {
    issues.push(issue("review.notes", `${filePath}.notes must be a string array when present`));
  }
  if (value.findings !== undefined && !isStringArray(value.findings)) {
    issues.push(issue("review.findings", `${filePath}.findings must be a string array when present`));
  }
  return issues;
}

/* ── Risk Register ── */

export function validateRiskRecordSchema(value: unknown, filePath = "risk"): Issue[] {
  return schemaIssues(validateRiskAjv, "risk", value, filePath);
}

export function asRiskRecord(value: unknown): RiskRecord {
  return value as RiskRecord;
}

function riskLevelForScore(score: number): string {
  if (score <= 4) return "low";
  if (score <= 9) return "medium";
  if (score <= 16) return "high";
  return "critical";
}

export function validateRiskRecord(value: unknown, filePath = "risk"): Issue[] {
  const issues = validateRiskRecordSchema(value, filePath);
  if (!isObject(value)) return issues;
  const assessment = isObject(value.assessment) ? value.assessment : undefined;
  const residual = isObject(value.residualRisk) ? value.residualRisk : undefined;
  for (const [name, section] of [["assessment", assessment], ["residualRisk", residual]] as const) {
    if (!section) continue;
    const likelihood = Number(section.likelihood);
    const impact = Number(section.impact);
    const score = Number(section.score);
    if (Number.isInteger(likelihood) && Number.isInteger(impact) && score !== likelihood * impact) {
      issues.push(issue("risk.score.mismatch", `${filePath}.${name}.score must equal likelihood * impact`));
    }
    if (Number.isInteger(score) && section.level !== riskLevelForScore(score)) {
      issues.push(issue("risk.level.mismatch", `${filePath}.${name}.level does not match the fixed risk level algorithm`));
    }
  }
  if (isObject(value.acceptance) && value.acceptance.acceptedBy !== "human") {
    issues.push(issue("risk.acceptance.human-only", `${filePath}.acceptance.acceptedBy must be human`));
  }
  return issues;
}
