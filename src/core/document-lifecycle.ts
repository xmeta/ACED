import { existsSync, readFileSync } from "node:fs";
import { matchesAny } from "./glob.js";
import { resolveFrom } from "./paths.js";
import type { Issue } from "./types.js";

export const documentLifecyclePath = "docs/document-lifecycle.json";
export const documentStatuses = ["normative", "informative", "proposal", "deprecated", "superseded"] as const;

export type DocumentStatus = typeof documentStatuses[number];

export type DocumentSet = {
  documentId: string;
  status: DocumentStatus;
  version: string;
  appliesToCli: string;
  entrypoint: string;
  paths: string[];
  supersedes: string[];
};

export type DocumentLifecycleManifest = {
  schemaVersion: "1.0.0";
  standardEntrypoints: string[];
  documents: DocumentSet[];
};

export type DocumentLifecycleResult = {
  manifest?: DocumentLifecycleManifest;
  cliVersion?: string;
  issues: Issue[];
};

const NON_CURRENT = new Set<DocumentStatus>(["proposal", "deprecated", "superseded"]);
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const RANGE_CLAUSE = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function safeRepositoryPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return normalized.length > 0
    && !normalized.startsWith("/")
    && !/^[A-Za-z]:/.test(normalized)
    && !segments.some((segment) => segment === "." || segment === "..");
}

function error(code: string, message: string): Issue {
  return {
    severity: "error",
    code,
    message,
    fixCommand: `Fix ${documentLifecyclePath}, then run: npm run scwbs -- docs check`
  };
}

function warning(code: string, message: string): Issue {
  return { severity: "warn", code, message };
}

function parseVersion(value: string): [number, number, number] | undefined {
  const match = value.match(SEMVER);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function versionSatisfiesRange(version: string, range: string): boolean {
  const parsedVersion = parseVersion(version);
  if (!parsedVersion) return false;
  const clauses = range.trim().split(/\s+/).filter(Boolean);
  if (clauses.length === 0) return false;
  return clauses.every((clause) => {
    const match = clause.match(RANGE_CLAUSE);
    if (!match) return false;
    const target = parseVersion(match[2]);
    if (!target) return false;
    const comparison = compareVersion(parsedVersion, target);
    switch (match[1] ?? "=") {
      case ">=": return comparison >= 0;
      case "<=": return comparison <= 0;
      case ">": return comparison > 0;
      case "<": return comparison < 0;
      default: return comparison === 0;
    }
  });
}

export function parseDocumentLifecycleManifest(text: string): DocumentLifecycleResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (parseError) {
    return { issues: [error("docs.manifest.parse", parseError instanceof Error ? parseError.message : String(parseError))] };
  }
  if (!record(raw)) return { issues: [error("docs.manifest.shape", "document lifecycle manifest must be an object")] };

  const issues: Issue[] = [];
  if (raw.schemaVersion !== "1.0.0") {
    issues.push(error("docs.manifest.schemaVersion", 'schemaVersion must be "1.0.0"'));
  }
  if (!stringArray(raw.standardEntrypoints) || raw.standardEntrypoints.length === 0) {
    issues.push(error("docs.manifest.standardEntrypoints", "standardEntrypoints must be a non-empty string array"));
  }
  if (!Array.isArray(raw.documents) || raw.documents.length === 0) {
    issues.push(error("docs.manifest.documents", "documents must be a non-empty array"));
    return { issues };
  }

  const documents: DocumentSet[] = [];
  for (const [index, value] of raw.documents.entries()) {
    if (!record(value)) {
      issues.push(error("docs.document.shape", `documents[${index}] must be an object`));
      continue;
    }
    const prefix = `documents[${index}]`;
    const documentId = typeof value.documentId === "string" ? value.documentId : "";
    const status = typeof value.status === "string" ? value.status : "";
    const version = typeof value.version === "string" ? value.version : "";
    const appliesToCli = typeof value.appliesToCli === "string" ? value.appliesToCli : "";
    const entrypoint = typeof value.entrypoint === "string" ? value.entrypoint : "";
    const paths = stringArray(value.paths) ? value.paths : [];
    const validSupersedes = Array.isArray(value.supersedes)
      && value.supersedes.every((item) => typeof item === "string" && item.length > 0);
    const supersedes = validSupersedes ? value.supersedes as string[] : [];

    if (!documentId) issues.push(error("docs.document.documentId", `${prefix}.documentId must be a non-empty string`));
    if (!documentStatuses.includes(status as DocumentStatus)) {
      issues.push(error("docs.document.status", `${prefix}.status must be one of ${documentStatuses.join(", ")}`));
    }
    if (!parseVersion(version)) issues.push(error("docs.document.version", `${prefix}.version must be semantic version x.y.z`));
    if (!appliesToCli || appliesToCli.split(/\s+/).some((clause) => !RANGE_CLAUSE.test(clause))) {
      issues.push(error("docs.document.appliesToCli", `${prefix}.appliesToCli must be a supported semantic version range`));
    }
    if (!entrypoint || !safeRepositoryPath(entrypoint)) {
      issues.push(error("docs.document.entrypoint", `${prefix}.entrypoint must be a safe repository-relative path`));
    }
    if (paths.length === 0 || paths.some((item) => !safeRepositoryPath(item))) {
      issues.push(error("docs.document.paths", `${prefix}.paths must be a non-empty array of safe repository-relative paths`));
    }
    if (!validSupersedes) {
      issues.push(error("docs.document.supersedes", `${prefix}.supersedes must be a string array`));
    }

    if (documentId && documentStatuses.includes(status as DocumentStatus) && parseVersion(version) && appliesToCli && entrypoint && paths.length > 0) {
      documents.push({
        documentId,
        status: status as DocumentStatus,
        version,
        appliesToCli,
        entrypoint,
        paths,
        supersedes
      });
    }
  }

  if (issues.some((item) => item.severity === "error")) return { issues };
  return {
    manifest: {
      schemaVersion: "1.0.0",
      standardEntrypoints: raw.standardEntrypoints as string[],
      documents
    },
    issues
  };
}

function validateSuccessorGraph(manifest: DocumentLifecycleManifest): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set(manifest.documents.map((item) => item.documentId));
  const successors = new Map<string, string[]>();
  const graph = new Map<string, string[]>();
  for (const document of manifest.documents) {
    graph.set(document.documentId, [...document.supersedes]);
    for (const predecessor of document.supersedes) {
      if (!ids.has(predecessor)) {
        issues.push(error("docs.supersedes.missing", `${document.documentId} supersedes unknown documentId ${predecessor}`));
        continue;
      }
      if (predecessor === document.documentId) {
        issues.push(error("docs.supersedes.self", `${document.documentId} cannot supersede itself`));
      }
      successors.set(predecessor, [...(successors.get(predecessor) ?? []), document.documentId]);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      issues.push(error("docs.supersedes.cycle", `supersedes cycle includes ${id}`));
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const predecessor of graph.get(id) ?? []) visit(predecessor);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);

  for (const document of manifest.documents) {
    if ((document.status === "deprecated" || document.status === "superseded")
      && (successors.get(document.documentId)?.length ?? 0) === 0) {
      issues.push(error(
        "docs.successor.missing",
        `${document.documentId} is ${document.status} but no successor document supersedes it`
      ));
    }
  }
  return issues;
}

function normativeConflict(left: DocumentSet, right: DocumentSet): boolean {
  if (left.entrypoint === right.entrypoint) return true;
  if (left.paths.some((pattern) => right.paths.includes(pattern))) return true;
  return matchesAny(left.entrypoint, right.paths) || matchesAny(right.entrypoint, left.paths);
}

export function collectDocumentLifecycleIssues(root: string, required = true): DocumentLifecycleResult {
  const absolutePath = resolveFrom(root, documentLifecyclePath);
  if (!existsSync(absolutePath)) {
    return {
      issues: required
        ? [error("docs.manifest.missing", `${documentLifecyclePath} does not exist`)]
        : []
    };
  }

  const parsed = parseDocumentLifecycleManifest(readFileSync(absolutePath, "utf8"));
  if (!parsed.manifest) return parsed;
  const manifest = parsed.manifest;
  const issues = [...parsed.issues];

  let cliVersion: string | undefined;
  try {
    const packageJson = JSON.parse(readFileSync(resolveFrom(root, "package.json"), "utf8")) as { version?: unknown };
    if (typeof packageJson.version === "string" && parseVersion(packageJson.version)) {
      cliVersion = packageJson.version;
    } else {
      issues.push(error("docs.cliVersion.invalid", "package.json version is missing or invalid"));
    }
  } catch (readError) {
    issues.push(error("docs.cliVersion.read", readError instanceof Error ? readError.message : String(readError)));
  }

  const byId = new Map<string, DocumentSet>();
  for (const document of manifest.documents) {
    if (byId.has(document.documentId)) {
      issues.push(error("docs.documentId.duplicate", `duplicate documentId ${document.documentId}`));
    } else {
      byId.set(document.documentId, document);
    }
    if (!existsSync(resolveFrom(root, document.entrypoint))) {
      issues.push(error("docs.entrypoint.missing", `${document.documentId} entrypoint does not exist: ${document.entrypoint}`));
    }
    if (!matchesAny(document.entrypoint, document.paths)) {
      issues.push(error("docs.entrypoint.scope", `${document.documentId} entrypoint is not covered by its paths: ${document.entrypoint}`));
    }
    if (cliVersion && !versionSatisfiesRange(cliVersion, document.appliesToCli)) {
      issues.push(error(
        "docs.appliesToCli.mismatch",
        `${document.documentId} appliesToCli ${document.appliesToCli} does not include CLI ${cliVersion}`
      ));
    }
  }

  const normative = manifest.documents.filter((item) => item.status === "normative");
  for (let leftIndex = 0; leftIndex < normative.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < normative.length; rightIndex += 1) {
      const left = normative[leftIndex];
      const right = normative[rightIndex];
      if (normativeConflict(left, right)) {
        issues.push(error("docs.normative.conflict", `${left.documentId} and ${right.documentId} claim overlapping normative scope`));
      }
    }
  }

  const entrypointOwner = new Map(manifest.documents.map((item) => [item.entrypoint, item]));
  for (const entrypoint of manifest.standardEntrypoints) {
    if (!existsSync(resolveFrom(root, entrypoint))) {
      issues.push(error("docs.standardEntrypoint.missing", `standard entrypoint does not exist: ${entrypoint}`));
      continue;
    }
    const owner = entrypointOwner.get(entrypoint);
    if (!owner) {
      issues.push(error("docs.standardEntrypoint.unregistered", `standard entrypoint is not a document entrypoint: ${entrypoint}`));
      continue;
    }
    if (NON_CURRENT.has(owner.status)) {
      issues.push(warning(
        "docs.standardEntrypoint.nonCurrent",
        `${entrypoint} is ${owner.status} and should not be in the standard execution path`
      ));
    }
  }
  issues.push(...validateSuccessorGraph(manifest));

  return { manifest, cliVersion, issues };
}

export function documentStatusForPath(manifest: DocumentLifecycleManifest, file: string): DocumentStatus | undefined {
  const priority: DocumentStatus[] = ["superseded", "deprecated", "proposal", "informative", "normative"];
  const matches = manifest.documents
    .filter((document) => matchesAny(file.replace(/\\/g, "/"), document.paths))
    .map((document) => document.status);
  return priority.find((status) => matches.includes(status));
}

export function isNonCurrentDocumentStatus(status: DocumentStatus | undefined): boolean {
  return status !== undefined && NON_CURRENT.has(status);
}
