import type { ErrorObject } from "ajv";
import type { Issue } from "../types.js";
import { ajv, formatSchemaPath, issue, stringArraySchema } from "./shared.js";

export const discoveryProbeSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion", "id", "type", "status", "question", "hypotheses", "activities",
    "evidenceExpected", "unknowns", "timebox", "costLimit", "exitConditions", "nextDecision"
  ],
  properties: {
    schemaVersion: { const: "1.0.0" },
    id: { type: "string", pattern: "^PROBE-[A-Za-z0-9][A-Za-z0-9._-]*$" },
    type: { const: "discovery-probe" },
    status: { enum: ["proposed", "active", "concluded", "inconclusive"] },
    question: { type: "string", minLength: 1 },
    hypotheses: stringArraySchema,
    activities: stringArraySchema,
    evidenceExpected: stringArraySchema,
    unknowns: stringArraySchema,
    timebox: { type: "string", minLength: 1 },
    costLimit: { type: "string", minLength: 1 },
    exitConditions: stringArraySchema,
    nextDecision: { type: "string", minLength: 1 },
    deliveryTaskId: { type: "string", minLength: 1 },
    createdAt: { type: "string", minLength: 1 },
    startedAt: { type: "string", minLength: 1 },
    concludedAt: { type: "string", minLength: 1 },
    exitConditionsMet: { type: "boolean" },
    factsLearned: stringArraySchema,
    hypothesesRejected: stringArraySchema,
    remainingUnknowns: stringArraySchema
  },
  allOf: [
    {
      if: { properties: { status: { const: "concluded" } }, required: ["status"] },
      then: {
        required: ["concludedAt", "exitConditionsMet", "factsLearned", "hypothesesRejected"],
        properties: { exitConditionsMet: { const: true } }
      }
    },
    {
      if: { properties: { status: { const: "inconclusive" } }, required: ["status"] },
      then: { required: ["concludedAt", "remainingUnknowns", "nextDecision"] }
    }
  ]
} as const;

const validate = ajv.compile(discoveryProbeSchema);

export function validateDiscoveryProbe(value: unknown, filePath = "probe"): Issue[] {
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error: ErrorObject) =>
    issue("discovery.schema", `${filePath}.${formatSchemaPath(error)} ${error.message ?? "does not match schema"}`)
  );
}
