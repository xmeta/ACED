import { createHash } from "node:crypto";
import path from "node:path";
import { checkCoverageSummary, checkCoverageSummaryForAllowedPaths, readCheckCoveragePolicy } from "./check-coverage.js";
import { readTask } from "./contracts.js";
import { matchesAny } from "./glob.js";
import { gitObject, headCommit, trackedTextFiles } from "./git.js";
import { fileSha256 } from "./hash.js";
import { taskPath } from "./paths.js";

const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_BYTES = 262_144;
const GLOB_PATTERN = /[*?[\]{}]/;
const SOURCE_PATTERN = /\.(?:cjs|js|mjs|ts|tsx)$/;

export type CodeContextOptions = {
  maxFiles?: number;
  maxBytes?: number;
};

export type CodeContextManifest = ReturnType<typeof buildCodeContextManifest>;

type LineRange = { start: number; end: number };

type ContextEntry = {
  path: string;
  contentHash: string;
  bytes: number;
  lines: number;
  lineRanges: LineRange[];
  reasons: string[];
  editable: boolean;
};

type ExcludedEntry = {
  path: string;
  reasons: string[];
  editable: false;
};

type WideningDiagnostic = {
  code: string;
  path: string;
  line?: number;
  detail: string;
};

type RelativeImport = { specifier: string; line: number };

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

function exactPath(value: string): boolean {
  return !GLOB_PATTERN.test(value);
}

type GitObjectReader = (root: string, ref: string, file: string) => string | undefined;

function entryFor(root: string, relativePath: string, reasons: string[], editable: boolean, readGitObject: GitObjectReader = gitObject): ContextEntry {
  const content = readGitObject(root, "HEAD", relativePath);
  if (content === undefined) throw new Error(`${relativePath} is not present at repository HEAD`);
  const lines = lineCount(content);
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  return {
    path: normalizePath(relativePath),
    contentHash: `sha256:${hash}`,
    bytes: Buffer.byteLength(content, "utf8"),
    lines,
    lineRanges: lines === 0 ? [] : [{ start: 1, end: lines }],
    reasons: [...new Set(reasons)].sort(),
    editable
  };
}

export type ParsedImports = { imports: RelativeImport[]; widening: WideningDiagnostic[] };

function parseRelativeImports(relativePath: string, content: string): ParsedImports {
  const imports: RelativeImport[] = [];
  const widening: WideningDiagnostic[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    const line = index + 1;
    const staticMatch = text.match(/^\s*import\s+(?:.+?\s+from\s+)?["'](\.[^"']+)["']\s*;?\s*$/);
    if (staticMatch) {
      imports.push({ specifier: staticMatch[1], line });
      continue;
    }
    if (/\bimport\s*\(/.test(text)) {
      widening.push({ code: "dynamic-import", path: relativePath, line, detail: "dynamic import is not resolved by manifest v1" });
    } else if (/^\s*export\s+.*\s+from\s+["']/.test(text)) {
      widening.push({ code: "re-export", path: relativePath, line, detail: "re-export is not traversed by manifest v1" });
    } else if (/^\s*import\b/.test(text) && /["'](?:@\/|~\/)/.test(text)) {
      widening.push({ code: "path-alias", path: relativePath, line, detail: "path alias is not resolved by manifest v1" });
    } else if (/^\s*import\b/.test(text) && /["'](?:src|tests|docs|contracts)\//.test(text)) {
      widening.push({ code: "path-alias", path: relativePath, line, detail: "repository path alias is not resolved by manifest v1" });
    } else if (/^\s*import\s*[{*]/.test(text) && !/["']/.test(text)) {
      widening.push({ code: "unsupported-import-syntax", path: relativePath, line, detail: "multi-line import is not resolved by manifest v1" });
    }
  }
  return { imports, widening };
}

function resolveRelativeImport(root: string, importer: string, specifier: string, readGitObject: GitObjectReader = gitObject): string | undefined {
  const base = normalizePath(path.posix.join(path.posix.dirname(importer), specifier));
  if (base === ".." || base.startsWith("../") || path.posix.isAbsolute(base)) return undefined;
  const extension = path.posix.extname(base);
  const candidates = extension === ".js"
    ? [base, `${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`]
    : extension.length > 0
      ? [base]
      : [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`];
  return candidates.find((candidate) => readGitObject(root, "HEAD", candidate) !== undefined);
}

function diagnosticSort(left: WideningDiagnostic, right: WideningDiagnostic): number {
  return left.path.localeCompare(right.path)
    || (left.line ?? 0) - (right.line ?? 0)
    || left.code.localeCompare(right.code)
    || left.detail.localeCompare(right.detail);
}

function excludedSort(left: ExcludedEntry, right: ExcludedEntry): number {
  return left.path.localeCompare(right.path) || left.reasons.join("\0").localeCompare(right.reasons.join("\0"));
}

export function reverseImporterCounts(manifest: CodeContextManifest): Map<string, number> {
  const counts = new Map<string, number>();
  const REVERSE_IMPORTER_PREFIX = "reverse-importer:";
  for (const entry of [...manifest.mustRead, ...manifest.candidates]) {
    const targets = new Set<string>();
    for (const reason of entry.reasons) {
      if (!reason.startsWith(REVERSE_IMPORTER_PREFIX)) continue;
      const target = reason.slice(REVERSE_IMPORTER_PREFIX.length).split(":")[0];
      if (target) targets.add(target);
    }
    for (const target of targets) {
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  }
  return counts;
}

export function buildCodeContextManifest(
  root: string,
  taskId: string,
  options: CodeContextOptions = {},
  sharedCache?: { parse?: Map<string, ParsedImports>; gitObject?: Map<string, string | undefined>; trackedFiles?: string[] }
) {
  const { task, issues } = readTask(root, taskId);
  if (!task) throw new Error(issues.map((issue) => issue.message).join("\n"));
  const head = headCommit(root);
  if (!head) throw new Error("Repository HEAD is unavailable");

  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES));
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES));
  const gitObjectCache = sharedCache?.gitObject ?? new Map<string, string | undefined>();
  const readGitObject: GitObjectReader = (gitRoot, ref, file) => {
    const cacheKey = `${ref}:${file}`;
    if (gitObjectCache.has(cacheKey)) return gitObjectCache.get(cacheKey);
    const content = gitObject(gitRoot, ref, file);
    gitObjectCache.set(cacheKey, content);
    return content;
  };
  const contractPath = taskPath(task.id);
  const mustRead = new Map<string, ContextEntry>();
  const candidateReasons = new Map<string, string[]>();
  const excluded: ExcludedEntry[] = [];
  const widening: WideningDiagnostic[] = [];

  const contractEntry = entryFor(root, contractPath, ["task-contract"], false, readGitObject);
  if (fileSha256(root, contractPath) !== contractEntry.contentHash) {
    throw new Error(`${contractPath} differs from repository HEAD`);
  }
  mustRead.set(contractPath, contractEntry);
  const seeds = task.allowedPaths.map(normalizePath).filter(exactPath).sort();
  const activeSeeds: string[] = [];
  for (const pattern of task.allowedPaths.map(normalizePath).filter((item) => !exactPath(item)).sort()) {
    excluded.push({ path: pattern, reasons: ["broad-glob-not-expanded"], editable: false });
    widening.push({ code: "broad-glob", path: pattern, detail: "manifest v1 does not enumerate broad allowedPaths" });
  }
  for (const seed of seeds) {
    if (readGitObject(root, "HEAD", seed) === undefined) {
      excluded.push({ path: seed, reasons: ["exact-allowed-path-missing"], editable: false });
      widening.push({ code: "missing-seed", path: seed, detail: "exact allowedPath does not exist at HEAD" });
      continue;
    }
    const protectedPath = matchesAny(seed, task.forbiddenPaths) || matchesAny(seed, task.humanGateRequiredPaths);
    if (protectedPath) {
      excluded.push({ path: seed, reasons: ["protected-path-not-promoted"], editable: false });
      widening.push({ code: "protected-seed", path: seed, detail: "forbidden or Human Gate path is not promoted" });
      continue;
    }
    candidateReasons.set(seed, ["exact-allowed-path"]);
    activeSeeds.push(seed);
  }

  const seedPaths = activeSeeds.filter((item) => SOURCE_PATTERN.test(item));
  const repositorySources = (sharedCache?.trackedFiles ?? trackedTextFiles(root))
    .map(normalizePath)
    .filter((item) => SOURCE_PATTERN.test(item) && readGitObject(root, "HEAD", item) !== undefined)
    .sort();
  const parsedByPath = sharedCache?.parse ?? new Map<string, ParsedImports>();
  const parse = (relativePath: string) => {
    const existing = parsedByPath.get(relativePath);
    if (existing) return existing;
    const content = readGitObject(root, "HEAD", relativePath);
    if (content === undefined) throw new Error(`${relativePath} is not present at repository HEAD`);
    const parsed = parseRelativeImports(relativePath, content);
    parsedByPath.set(relativePath, parsed);
    return parsed;
  };

  for (const seed of seedPaths) {
    const parsed = parse(seed);
    widening.push(...parsed.widening);
    for (const item of parsed.imports) {
      const resolved = resolveRelativeImport(root, seed, item.specifier, readGitObject);
      if (!resolved) {
        widening.push({ code: "unresolved-import", path: seed, line: item.line, detail: item.specifier });
        continue;
      }
      candidateReasons.set(resolved, [...(candidateReasons.get(resolved) ?? []), `direct-static-import:${seed}:${item.line}`]);
      if (resolved === seed) widening.push({ code: "import-cycle", path: seed, line: item.line, detail: "self import" });
    }
  }

  for (const importer of repositorySources) {
    if (seedPaths.includes(importer)) continue;
    const parsed = parse(importer);
    for (const item of parsed.imports) {
      const resolved = resolveRelativeImport(root, importer, item.specifier, readGitObject);
      if (resolved && seedPaths.includes(resolved)) {
        candidateReasons.set(importer, [...(candidateReasons.get(importer) ?? []), `reverse-importer:${resolved}:${item.line}`]);
      }
    }
  }

  const candidates: ContextEntry[] = [];
  const omitted: ExcludedEntry[] = [];
  let selectedFiles = mustRead.size;
  let selectedBytes = [...mustRead.values()].reduce((sum, item) => sum + item.bytes, 0);
  if (selectedFiles > maxFiles || selectedBytes > maxBytes) {
    widening.push({ code: "must-read-budget-exceeded", path: contractPath, detail: "mustRead entries exceed the configured budget" });
  }
  const orderedCandidates = [...candidateReasons.entries()].sort(([leftPath, leftReasons], [rightPath, rightReasons]) => {
    const leftPriority = leftReasons.includes("exact-allowed-path") ? 0 : 1;
    const rightPriority = rightReasons.includes("exact-allowed-path") ? 0 : 1;
    return leftPriority - rightPriority || leftPath.localeCompare(rightPath);
  });
  for (const [candidatePath, reasons] of orderedCandidates) {
    if (mustRead.has(candidatePath)) {
      const current = mustRead.get(candidatePath);
      if (current) current.reasons = [...new Set([...current.reasons, ...reasons])].sort();
      continue;
    }
    if (matchesAny(candidatePath, task.forbiddenPaths) || matchesAny(candidatePath, task.humanGateRequiredPaths)) {
      excluded.push({ path: candidatePath, reasons: ["protected-path-not-promoted", ...new Set(reasons)].sort(), editable: false });
      widening.push({ code: "protected-candidate", path: candidatePath, detail: "forbidden or Human Gate path is not promoted" });
      continue;
    }
    const reasonTarget = (reason: string, prefix: string): string | undefined => {
      if (!reason.startsWith(prefix)) return undefined;
      const value = reason.slice(prefix.length);
      return value.slice(0, value.lastIndexOf(":"));
    };
    const directImporters = new Set(reasons.map((reason) => reasonTarget(reason, "direct-static-import:")).filter(Boolean));
    const reverseTargets = reasons.map((reason) => reasonTarget(reason, "reverse-importer:")).filter(Boolean);
    if (reverseTargets.some((target) => directImporters.has(target))) {
      widening.push({ code: "import-cycle", path: candidatePath, detail: "candidate imports a seed that also imports the candidate" });
    }
    if (reasons.length > 8) {
      widening.push({ code: "high-fan-out", path: candidatePath, detail: `${reasons.length} one-hop relations reference this candidate` });
    }
    const entry = entryFor(root, candidatePath, reasons, matchesAny(candidatePath, task.allowedPaths), readGitObject);
    if (selectedFiles + 1 > maxFiles || selectedBytes + entry.bytes > maxBytes) {
      omitted.push({ path: candidatePath, reasons: ["budget-exceeded", ...entry.reasons].sort(), editable: false });
      continue;
    }
    candidates.push(entry);
    selectedFiles += 1;
    selectedBytes += entry.bytes;
  }
  if (omitted.length > 0) widening.push({ code: "budget-exceeded", path: "(manifest)", detail: `${omitted.length} candidate(s) omitted` });

  const { policy, issues: policyIssues } = readCheckCoveragePolicy(root);
  const predictedCoverage = checkCoverageSummaryForAllowedPaths(policy, task);
  const exactCoverage = checkCoverageSummary(policy, task, seeds);
  for (const issue of policyIssues) widening.push({ code: issue.code, path: "contracts/check-coverage.yaml", detail: issue.message });
  for (const file of exactCoverage.unclassifiedFiles) {
    widening.push({ code: "coverage-unclassified", path: file, detail: "implementation path is not classified" });
  }
  const coverageRequired = [...new Set([...predictedCoverage.required, ...exactCoverage.required])].sort();
  const coverageMissing = coverageRequired.filter((check) => !task.requiredChecks.includes(check));
  for (const check of coverageMissing) {
    widening.push({ code: "coverage-missing", path: contractPath, detail: `Task Contract is missing required check ${check}` });
  }

  const wideningReasons = widening.sort(diagnosticSort);
  const sortedMustRead = [...mustRead.values()].sort((left, right) => left.path.localeCompare(right.path));
  const sortedCandidates = candidates.sort((left, right) => left.path.localeCompare(right.path));
  const sortedExcluded = [...excluded, ...omitted].sort(excludedSort);
  return {
    schemaVersion: "1.0.0",
    task: { id: task.id, contractPath, contractHash: contractEntry.contentHash },
    repository: { head },
    mustRead: sortedMustRead,
    candidates: sortedCandidates,
    excluded: sortedExcluded,
    widening: wideningReasons,
    coverage: {
      required: coverageRequired,
      missing: coverageMissing,
      unclassified: [...exactCoverage.unclassifiedFiles].sort()
    },
    budget: {
      maxFiles,
      maxBytes,
      selectedFiles,
      selectedBytes,
      omitted: omitted.length
    },
    completeness: {
      status: wideningReasons.length === 0 ? "complete" : "widening-required",
      reasons: [...new Set(wideningReasons.map((item) => item.code))].sort()
    },
    constraints: {
      sourceContentIncluded: false,
      grantsEditAuthority: false,
      permitsRequiredCheckOmission: false
    }
  };
}

export function buildCodeContextManifestJson(root: string, taskId: string, options: CodeContextOptions = {}): string {
  return `${JSON.stringify(buildCodeContextManifest(root, taskId, options))}\n`;
}
