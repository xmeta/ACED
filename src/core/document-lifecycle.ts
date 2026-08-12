import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { matchesAny } from "./glob.js";
import { resolveFrom } from "./paths.js";
import type { Issue } from "./types.js";

export const documentLifecyclePath = "docs/document-lifecycle.json";
export const documentationCapabilitiesPath = "docs/documentation-capabilities.json";
export const documentLifecycleSchemaVersion = "1.1.0";
export const documentLifecycleLegacySchemaVersion = "1.0.0";
export const documentStatuses = ["normative", "informative", "proposal", "deprecated", "superseded"] as const;
export const documentationCapabilityStatuses = ["implemented", "partial", "missing", "deferred"] as const;
export const documentLanguages = ["ja", "en"] as const;

export type DocumentStatus = (typeof documentStatuses)[number];
export type DocumentationCapabilityStatus = (typeof documentationCapabilityStatuses)[number];
export type DocumentLanguage = (typeof documentLanguages)[number];

export type DocumentSet = {
  documentId: string;
  status: DocumentStatus;
  version: string;
  appliesToCli: string;
  entrypoint: string;
  paths: string[];
  supersedes: string[];
  language: DocumentLanguage;
};

export type DocumentQualityException = {
  path: string;
  reason: string;
  owner: string;
  expiresAt: string;
};

export type DocumentLifecycleManifest = {
  schemaVersion: "1.0.0" | "1.1.0";
  standardEntrypoints: string[];
  documents: DocumentSet[];
  ignoredPaths: string[];
  maxLines: number;
  qualityExceptions: DocumentQualityException[];
};

export type DocumentLifecycleResult = {
  manifest?: DocumentLifecycleManifest;
  cliVersion?: string;
  issues: Issue[];
};

export type DocumentationCapability = {
  id: string;
  status: DocumentationCapabilityStatus;
  summary: string;
  evidence: {
    commands: string[];
    files: string[];
    tests: string[];
  };
};

export type DocumentationCapabilitiesResult = {
  capabilities?: DocumentationCapability[];
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
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:/.test(normalized) &&
    !segments.some((segment) => segment === "." || segment === "..")
  );
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

function capabilityError(code: string, message: string): Issue {
  return {
    severity: "error",
    code,
    message,
    fixCommand: `Fix ${documentationCapabilitiesPath} or docs/implementation-gaps.md, then run: npm run scwbs -- docs check`
  };
}

function readText(root: string, relativePath: string): string | undefined {
  const absolutePath = resolveFrom(root, relativePath);
  if (!existsSync(absolutePath)) return undefined;
  try {
    return readFileSync(absolutePath, "utf8");
  } catch {
    return undefined;
  }
}

function collectMarkdownFiles(root: string): string[] {
  const docsRoot = resolveFrom(root, "docs");
  if (!existsSync(docsRoot)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path.relative(root, absolutePath).replace(/\\/g, "/"));
      }
    }
  };
  visit(docsRoot);
  return files.sort();
}

function physicalLineCount(text: string): number {
  return text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function languageCandidate(line: string): { japanese: boolean; english: boolean } {
  const withoutCode = line
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/^\s{4,}/, "")
    .trim();
  if (!withoutCode || withoutCode.startsWith("#") || /^[-*+]\s+[`<]/.test(withoutCode)) {
    return { japanese: false, english: false };
  }
  const japanese = /[\u3040-\u30ff\u3400-\u9fff]/.test(withoutCode);
  const words = withoutCode.toLowerCase().match(/[a-z]{3,}/g) ?? [];
  const englishWords = new Set([
    "the", "and", "for", "with", "this", "that", "from", "when", "must", "should", "use", "only", "current", "document", "repository", "run", "check", "work", "file", "source", "does", "not", "are", "is"
  ]);
  const english = !japanese && (words.filter((word) => englishWords.has(word)).length >= 2 || words.length >= 8);
  return { japanese, english };
}

function documentFiles(root: string, manifest: DocumentLifecycleManifest): string[] {
  const candidates = new Set<string>(manifest.standardEntrypoints);
  for (const file of collectMarkdownFiles(root)) {
    if (manifest.documents.some((document) => matchesAny(file, document.paths))) candidates.add(file);
  }
  return [...candidates].filter((file) => file.endsWith(".md")).sort();
}

function collectDocumentationQualityIssues(root: string, manifest: DocumentLifecycleManifest): Issue[] {
  const issues: Issue[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const exceptions = new Map<string, DocumentQualityException>();
  for (const [index, exception] of manifest.qualityExceptions.entries()) {
    const prefix = `qualityExceptions[${index}]`;
    const valid =
      safeRepositoryPath(exception.path) &&
      exception.reason.trim().length > 0 &&
      exception.owner.trim().length > 0 &&
      isIsoDate(exception.expiresAt) &&
      exception.expiresAt >= today &&
      existsSync(resolveFrom(root, exception.path)) &&
      !exceptions.has(exception.path);
    if (!valid) {
      issues.push(
        error(
          "docs.quality.exceptionInvalid",
          `${prefix} is invalid, expired, duplicated, or points to a missing path: ${exception.path}`
        )
      );
    } else {
      exceptions.set(exception.path, exception);
    }
  }

  const languageByPath = new Map<string, DocumentLanguage>();
  for (const document of manifest.documents) {
    for (const file of documentFiles(root, { ...manifest, documents: [document] })) languageByPath.set(file, document.language);
  }
  for (const file of documentFiles(root, manifest)) {
    const text = readText(root, file);
    if (text === undefined) continue;
    const lineCount = physicalLineCount(text);
    if (lineCount > manifest.maxLines && !exceptions.has(file)) {
      issues.push(error("docs.size.exceeded", `${file} has ${lineCount} physical lines; expected at most ${manifest.maxLines}`));
    }
    const declared = languageByPath.get(file);
    if (!declared) continue;
    let inFence = false;
    let japaneseLines = 0;
    let englishLines = 0;
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const candidate = languageCandidate(line);
      if (candidate.japanese) japaneseLines += 1;
      if (candidate.english) englishLines += 1;
    }
    const oppositeDetected = declared === "ja" ? englishLines >= 1 && japaneseLines === 0 : japaneseLines >= 1 && englishLines === 0;
    if (oppositeDetected) {
      issues.push(
        error("docs.language.mixedProse", `${file}:1 declared language ${declared}, expected ${declared} prose; opposite-language prose detected`)
      );
    }
  }
  return issues;
}

function collectInternalLinkIssues(root: string, manifest: DocumentLifecycleManifest): Issue[] {
  const issues: Issue[] = [];
  for (const file of documentFiles(root, manifest)) {
    const text = readText(root, file) ?? "";
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
      const target = match[1];
      if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const targetPath = target.split("#", 1)[0];
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), targetPath));
      if (!safeRepositoryPath(resolved) || !existsSync(resolveFrom(root, resolved))) {
        issues.push(error("docs.link.missing", `${file} links to missing path ${target}`));
      }
    }
  }
  return issues;
}

function repositoryPackage(root: string): { version?: string; lintScript?: string } | undefined {
  const text = readText(root, "package.json");
  if (!text) return undefined;
  try {
    const packageJson = JSON.parse(text) as { version?: unknown; scripts?: { lint?: unknown } };
    return {
      version: typeof packageJson.version === "string" ? packageJson.version : undefined,
      lintScript: typeof packageJson.scripts?.lint === "string" ? packageJson.scripts.lint : undefined
    };
  } catch {
    return undefined;
  }
}

function collectOrphanDocumentationIssues(root: string, manifest: DocumentLifecycleManifest): Issue[] {
  return collectMarkdownFiles(root)
    .filter((file) => !manifest.documents.some((document) => matchesAny(file, document.paths)))
    .filter((file) => !manifest.ignoredPaths.some((pattern) => matchesAny(file, [pattern])))
    .map((file) =>
      error(
        "docs.orphan.unregistered",
        `${file} is a maintained Markdown file not covered by document lifecycle or ignoredPaths`
      )
    );
}

function collectFactualDocumentationIssues(root: string): Issue[] {
  const issues: Issue[] = [];
  const packageJson = repositoryPackage(root);
  const readme = readText(root, "README.md") ?? "";
  const gaps = readText(root, "docs/implementation-gaps.md") ?? "";
  const mergeProtection = readText(root, "docs/scwbs/merge-protection.md") ?? "";
  const cliSource = readText(root, "src/cli.ts") ?? "";

  const configuredLintWarnings = packageJson?.lintScript?.match(/--max-warnings(?:=|\s+)(\d+)/)?.[1];
  const documentedLintWarnings = readme.match(/(?:baseline|up to)\s+(\d+)\s+warnings/i)?.[1];
  if (configuredLintWarnings && documentedLintWarnings && configuredLintWarnings !== documentedLintWarnings) {
    issues.push(
      error(
        "docs.fact.lintThreshold",
        `README documents ${documentedLintWarnings} lint warnings but package.json lint uses --max-warnings=${configuredLintWarnings}`
      )
    );
  }

  if (
    /Documentation automation\s*\|[^\n]*Markdown generation from contracts/i.test(gaps) &&
    /runDocsGenerate|\.command\("generate"\)/.test(cliSource)
  ) {
    issues.push(
      error(
        "docs.fact.implementedMissing",
        "docs/implementation-gaps.md lists contract Markdown generation as missing although docs generate is implemented"
      )
    );
  }

  if (
    mergeProtection &&
    /(?:currently|現行)[^\n]*(?:private|public)/i.test(mergeProtection) &&
    !/(?:snapshot|観測|revalidat|再検証|gh api)/i.test(mergeProtection)
  ) {
    issues.push(
      error(
        "docs.fact.transientRepositoryState",
        "merge protection documentation contains an unbounded repository visibility claim; record a dated snapshot and live revalidation guidance"
      )
    );
  }

  if (readme.includes("docs check") && !/\.command\("check"\)/.test(cliSource)) {
    issues.push(
      error("docs.fact.commandMissing", "README documents docs check but the command is not registered in src/cli.ts")
    );
  }
  return issues;
}

const COMMAND_EVIDENCE: Record<string, { path: string; pattern: RegExp }> = {
  "index rebuild": {
    path: "src/cli.ts",
    pattern: /const index = program\.command\("index"\)[\s\S]*?index\.command\("rebuild"\)/
  },
  "index status": {
    path: "src/cli.ts",
    pattern: /const index = program\.command\("index"\)[\s\S]*?index\.command\("status"\)/
  },
  "index verify": {
    path: "src/cli.ts",
    pattern: /const index = program\.command\("index"\)[\s\S]*?index\.command\("verify"\)/
  },
  query: { path: "src/cli.ts", pattern: /program\s*\.command\("query"\)/ },
  "spec-change new": {
    path: "src/cli/register-governance.ts",
    pattern: /program\.command\("spec-change"\)[\s\S]*?\.command\("new"\)/
  },
  "wbs merge-plan": {
    path: "src/cli/register-wbs.ts",
    pattern: /program\.command\("wbs"\)[\s\S]*?\.command\("merge-plan"\)/
  }
};

const CAPABILITY_MARKER =
  /<!--\s*scwbs-capability:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s+status=(implemented|partial|missing|deferred)\s*-->/g;
const CAPABILITY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function optionalStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function parseDocumentationCapabilities(text: string): DocumentationCapabilitiesResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (parseError) {
    return {
      issues: [
        capabilityError("docs.capability.parse", parseError instanceof Error ? parseError.message : String(parseError))
      ]
    };
  }
  if (!record(raw))
    return { issues: [capabilityError("docs.capability.shape", `${documentationCapabilitiesPath} must be an object`)] };
  const issues: Issue[] = [];
  if (raw.schemaVersion !== "scwbs.documentation-capabilities.v1") {
    issues.push(
      capabilityError(
        "docs.capability.schemaVersion",
        `${documentationCapabilitiesPath} schemaVersion must be scwbs.documentation-capabilities.v1`
      )
    );
  }
  if (!Array.isArray(raw.capabilities)) {
    return { issues: [...issues, capabilityError("docs.capability.list", "capabilities must be an array")] };
  }

  const capabilities: DocumentationCapability[] = [];
  const ids = new Set<string>();
  for (const [index, value] of raw.capabilities.entries()) {
    const prefix = `capabilities[${index}]`;
    if (!record(value)) {
      issues.push(capabilityError("docs.capability.entry", `${prefix} must be an object`));
      continue;
    }
    const id = typeof value.id === "string" ? value.id : "";
    const status = typeof value.status === "string" ? value.status : "";
    const summary = typeof value.summary === "string" ? value.summary : "";
    if (!CAPABILITY_ID.test(id))
      issues.push(capabilityError("docs.capability.id", `${prefix}.id must be a stable kebab-case id`));
    if (ids.has(id)) issues.push(capabilityError("docs.capability.id.duplicate", `duplicate capability id ${id}`));
    ids.add(id);
    if (!documentationCapabilityStatuses.includes(status as DocumentationCapabilityStatus)) {
      issues.push(
        capabilityError(
          "docs.capability.status",
          `${prefix}.status must be one of ${documentationCapabilityStatuses.join(", ")}`
        )
      );
    }
    if (!summary.trim()) issues.push(capabilityError("docs.capability.summary", `${prefix}.summary must be non-empty`));
    if (!record(value.evidence)) {
      issues.push(capabilityError("docs.capability.evidence", `${prefix}.evidence must be an object`));
      continue;
    }
    const commands = optionalStringArray(value.evidence.commands) ? value.evidence.commands : [];
    const files = optionalStringArray(value.evidence.files) ? value.evidence.files : [];
    const tests = optionalStringArray(value.evidence.tests) ? value.evidence.tests : [];
    if (!optionalStringArray(value.evidence.commands))
      issues.push(
        capabilityError("docs.capability.evidence.commands", `${prefix}.evidence.commands must be a string array`)
      );
    if (!optionalStringArray(value.evidence.files))
      issues.push(capabilityError("docs.capability.evidence.files", `${prefix}.evidence.files must be a string array`));
    if (!optionalStringArray(value.evidence.tests))
      issues.push(capabilityError("docs.capability.evidence.tests", `${prefix}.evidence.tests must be a string array`));
    if (id && documentationCapabilityStatuses.includes(status as DocumentationCapabilityStatus)) {
      capabilities.push({
        id,
        status: status as DocumentationCapabilityStatus,
        summary,
        evidence: { commands, files, tests }
      });
    }
  }
  if (issues.some((item) => item.severity === "error")) return { issues };
  return { capabilities, issues };
}

function validateCapabilityEvidence(root: string, capability: DocumentationCapability): Issue[] {
  const issues: Issue[] = [];
  let validEvidence = 0;
  for (const command of capability.evidence.commands) {
    const descriptor = COMMAND_EVIDENCE[command];
    if (!descriptor) {
      issues.push(
        capabilityError("docs.capability.command.unknown", `${capability.id} documents unknown command: ${command}`)
      );
      continue;
    }
    const source = readText(root, descriptor.path);
    if (!source || !descriptor.pattern.test(source)) {
      issues.push(
        capabilityError(
          "docs.capability.command.missing",
          `${capability.id} documents command ${command}, but its CLI registration is missing from ${descriptor.path}`
        )
      );
      continue;
    }
    validEvidence += 1;
  }
  for (const pathValue of [...capability.evidence.files, ...capability.evidence.tests]) {
    if (!safeRepositoryPath(pathValue)) {
      issues.push(
        capabilityError(
          "docs.capability.path.invalid",
          `${capability.id} documents an unsafe evidence path: ${pathValue}`
        )
      );
      continue;
    }
    if (!existsSync(resolveFrom(root, pathValue))) {
      issues.push(
        capabilityError(
          "docs.capability.evidence.missing",
          `${capability.id} evidence path does not exist: ${pathValue}`
        )
      );
      continue;
    }
    validEvidence += 1;
  }
  if ((capability.status === "implemented" || capability.status === "partial") && validEvidence === 0) {
    issues.push(
      capabilityError(
        "docs.capability.evidence.required",
        `${capability.id} status ${capability.status} requires at least one valid command, file, or test evidence`
      )
    );
  }
  return issues;
}

function validateCapabilityMatrix(markdown: string, capabilities: DocumentationCapability[]): Issue[] {
  const issues: Issue[] = [];
  const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
  const markers = new Map<string, DocumentationCapabilityStatus>();
  for (const match of markdown.matchAll(CAPABILITY_MARKER)) {
    const id = match[1];
    const status = match[2] as DocumentationCapabilityStatus;
    if (markers.has(id)) {
      issues.push(
        capabilityError(
          "docs.capability.matrix.duplicate",
          `capability ${id} appears more than once in docs/implementation-gaps.md`
        )
      );
      continue;
    }
    markers.set(id, status);
    const capability = byId.get(id);
    if (!capability) {
      issues.push(
        capabilityError(
          "docs.capability.matrix.unknown",
          `docs/implementation-gaps.md references unknown capability ${id}`
        )
      );
    } else if (capability.status !== status) {
      issues.push(
        capabilityError(
          "docs.capability.matrix.mismatch",
          `${id} is ${capability.status} in ${documentationCapabilitiesPath} but ${status} in docs/implementation-gaps.md`
        )
      );
    }
  }
  for (const capability of capabilities) {
    if (!markers.has(capability.id)) {
      issues.push(
        capabilityError(
          "docs.capability.matrix.missing",
          `docs/implementation-gaps.md has no status marker for capability ${capability.id}`
        )
      );
    }
  }
  return issues;
}

function collectDocumentationCapabilityIssues(root: string): Issue[] {
  const capabilityText = readText(root, documentationCapabilitiesPath);
  const gapsText = readText(root, "docs/implementation-gaps.md");
  if (!capabilityText && !gapsText) return [];
  if (!capabilityText)
    return [capabilityError("docs.capability.missing", `${documentationCapabilitiesPath} does not exist`)];
  if (!gapsText)
    return [capabilityError("docs.capability.matrix.missingFile", "docs/implementation-gaps.md does not exist")];
  const parsed = parseDocumentationCapabilities(capabilityText);
  if (!parsed.capabilities) return parsed.issues;
  return [
    ...parsed.issues,
    ...parsed.capabilities.flatMap((capability) => validateCapabilityEvidence(root, capability)),
    ...validateCapabilityMatrix(gapsText, parsed.capabilities)
  ];
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
      case ">=":
        return comparison >= 0;
      case "<=":
        return comparison <= 0;
      case ">":
        return comparison > 0;
      case "<":
        return comparison < 0;
      default:
        return comparison === 0;
    }
  });
}

export function parseDocumentLifecycleManifest(text: string): DocumentLifecycleResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (parseError) {
    return {
      issues: [error("docs.manifest.parse", parseError instanceof Error ? parseError.message : String(parseError))]
    };
  }
  if (!record(raw)) return { issues: [error("docs.manifest.shape", "document lifecycle manifest must be an object")] };

  const issues: Issue[] = [];
  const legacy = raw.schemaVersion === documentLifecycleLegacySchemaVersion;
  if (!legacy && raw.schemaVersion !== documentLifecycleSchemaVersion) {
    issues.push(error("docs.manifest.schemaVersion", `schemaVersion must be "${documentLifecycleSchemaVersion}"`));
  }
  if (!stringArray(raw.standardEntrypoints) || raw.standardEntrypoints.length === 0) {
    issues.push(error("docs.manifest.standardEntrypoints", "standardEntrypoints must be a non-empty string array"));
  }
  const validIgnoredPaths = raw.ignoredPaths === undefined || stringArray(raw.ignoredPaths);
  if (
    !validIgnoredPaths ||
    (raw.ignoredPaths as unknown[] | undefined)?.some((item) => !safeRepositoryPath(item as string))
  ) {
    issues.push(
      error("docs.manifest.ignoredPaths", "ignoredPaths must be a string array of safe repository-relative paths")
    );
  }
  if (!Array.isArray(raw.documents) || raw.documents.length === 0) {
    issues.push(error("docs.manifest.documents", "documents must be a non-empty array"));
    return { issues };
  }

  const maxLines = raw.maxLines === undefined && legacy ? 500 : raw.maxLines;
  if (typeof maxLines !== "number" || !Number.isInteger(maxLines) || maxLines < 1) {
    issues.push(error("docs.manifest.maxLines", "maxLines must be a positive integer"));
  }
  const rawExceptions = raw.qualityExceptions === undefined && legacy ? [] : raw.qualityExceptions;
  if (!Array.isArray(rawExceptions)) {
    issues.push(error("docs.manifest.qualityExceptions", "qualityExceptions must be an array"));
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
    const validSupersedes =
      Array.isArray(value.supersedes) && value.supersedes.every((item) => typeof item === "string" && item.length > 0);
    const supersedes = validSupersedes ? (value.supersedes as string[]) : [];
    const language = value.language;

    if (!documentId) issues.push(error("docs.document.documentId", `${prefix}.documentId must be a non-empty string`));
    if (!documentStatuses.includes(status as DocumentStatus)) {
      issues.push(error("docs.document.status", `${prefix}.status must be one of ${documentStatuses.join(", ")}`));
    }
    if (!parseVersion(version))
      issues.push(error("docs.document.version", `${prefix}.version must be semantic version x.y.z`));
    if (!appliesToCli || appliesToCli.split(/\s+/).some((clause) => !RANGE_CLAUSE.test(clause))) {
      issues.push(
        error("docs.document.appliesToCli", `${prefix}.appliesToCli must be a supported semantic version range`)
      );
    }
    if (!entrypoint || !safeRepositoryPath(entrypoint)) {
      issues.push(error("docs.document.entrypoint", `${prefix}.entrypoint must be a safe repository-relative path`));
    }
    if (paths.length === 0 || paths.some((item) => !safeRepositoryPath(item))) {
      issues.push(
        error("docs.document.paths", `${prefix}.paths must be a non-empty array of safe repository-relative paths`)
      );
    }
    if (!validSupersedes) {
      issues.push(error("docs.document.supersedes", `${prefix}.supersedes must be a string array`));
    }
    if (!legacy && !documentLanguages.includes(language as DocumentLanguage)) {
      issues.push(error("docs.language.missing", `${prefix}.language must be one of ${documentLanguages.join(", ")}`));
    }

    if (
      documentId &&
      documentStatuses.includes(status as DocumentStatus) &&
      parseVersion(version) &&
      appliesToCli &&
      entrypoint &&
      paths.length > 0
    ) {
      documents.push({
        documentId,
        status: status as DocumentStatus,
        version,
        appliesToCli,
        entrypoint,
        paths,
        supersedes,
        language: documentLanguages.includes(language as DocumentLanguage) ? (language as DocumentLanguage) : "ja"
      });
    }
  }

  if (issues.some((item) => item.severity === "error")) return { issues };
  return {
    manifest: {
      schemaVersion: legacy ? documentLifecycleLegacySchemaVersion : documentLifecycleSchemaVersion,
      standardEntrypoints: raw.standardEntrypoints as string[],
      documents,
      ignoredPaths: raw.ignoredPaths === undefined ? [] : (raw.ignoredPaths as string[]),
      maxLines: maxLines as number,
      qualityExceptions: (Array.isArray(rawExceptions) ? rawExceptions : []).flatMap((value) => {
        if (!record(value)) return [];
        return [{
          path: typeof value.path === "string" ? value.path : "",
          reason: typeof value.reason === "string" ? value.reason : "",
          owner: typeof value.owner === "string" ? value.owner : "",
          expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : ""
        }];
      })
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
        issues.push(
          error("docs.supersedes.missing", `${document.documentId} supersedes unknown documentId ${predecessor}`)
        );
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
    if (
      (document.status === "deprecated" || document.status === "superseded") &&
      (successors.get(document.documentId)?.length ?? 0) === 0
    ) {
      issues.push(
        error(
          "docs.successor.missing",
          `${document.documentId} is ${document.status} but no successor document supersedes it`
        )
      );
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
      issues: required ? [error("docs.manifest.missing", `${documentLifecyclePath} does not exist`)] : []
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
      issues.push(
        error("docs.entrypoint.missing", `${document.documentId} entrypoint does not exist: ${document.entrypoint}`)
      );
    }
    if (!matchesAny(document.entrypoint, document.paths)) {
      issues.push(
        error(
          "docs.entrypoint.scope",
          `${document.documentId} entrypoint is not covered by its paths: ${document.entrypoint}`
        )
      );
    }
    if (cliVersion && !versionSatisfiesRange(cliVersion, document.appliesToCli)) {
      issues.push(
        error(
          "docs.appliesToCli.mismatch",
          `${document.documentId} appliesToCli ${document.appliesToCli} does not include CLI ${cliVersion}`
        )
      );
    }
  }

  const normative = manifest.documents.filter((item) => item.status === "normative");
  for (let leftIndex = 0; leftIndex < normative.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < normative.length; rightIndex += 1) {
      const left = normative[leftIndex];
      const right = normative[rightIndex];
      if (normativeConflict(left, right)) {
        issues.push(
          error(
            "docs.normative.conflict",
            `${left.documentId} and ${right.documentId} claim overlapping normative scope`
          )
        );
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
      issues.push(
        error("docs.standardEntrypoint.unregistered", `standard entrypoint is not a document entrypoint: ${entrypoint}`)
      );
      continue;
    }
    if (NON_CURRENT.has(owner.status)) {
      issues.push(
        warning(
          "docs.standardEntrypoint.nonCurrent",
          `${entrypoint} is ${owner.status} and should not be in the standard execution path`
        )
      );
    }
  }
  issues.push(...validateSuccessorGraph(manifest));
  issues.push(...collectOrphanDocumentationIssues(root, manifest));
  issues.push(...collectFactualDocumentationIssues(root));
  issues.push(...collectDocumentationCapabilityIssues(root));
  issues.push(...collectDocumentationQualityIssues(root, manifest));
  issues.push(...collectInternalLinkIssues(root, manifest));

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
