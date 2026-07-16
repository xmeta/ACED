import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { profileRequiredDirs, resolveFrom } from "../core/paths.js";
import type { Profile } from "../core/types.js";
import { parseSimpleYaml } from "../core/yaml.js";
import { readProfile } from "./profile.js";
import { readGithubActionsHistory, type GithubActionsHistory } from "../core/github-actions.js";

const GOVERNANCE_DIRS = [
  "contracts/tasks",
  "contracts/evidence",
  "contracts/approvals",
  "contracts/reviews",
  "contracts/blocks",
  "contracts/specs",
  "contracts/spec-changes",
  "contracts/changesets",
  "contracts/wbs"
] as const;

type Bucket = { files: number; bytes: number; lines: number };
type FileMeasurement = Bucket & {
  activeFiles: number;
  activeBytes: number;
  activeLines: number;
  archivedFiles: number;
  archivedBytes: number;
  archivedLines: number;
};

export type GovernanceCostSummary = {
  schemaVersion: "1.0.0";
  metric: "governance-cost";
  generatedAt: string;
  profile: Profile;
  definitions: {
    lineCount: string;
    activeArchive: string;
    ratios: string;
    hardLimitEnforced: false;
  };
  categories: Record<string, FileMeasurement>;
  profiles: Record<Profile, Bucket>;
  totals: {
    governance: FileMeasurement;
    source: Bucket;
    tests: Bucket;
    governanceToSourceLineRatio: number | null;
    governanceToTestLineRatio: number | null;
  };
  historicalCi: GithubActionsHistory;
  unmeasured: string[];
};

export type MetricsOptions = { json?: boolean };

function emptyMeasurement(): FileMeasurement {
  return {
    files: 0,
    bytes: 0,
    lines: 0,
    activeFiles: 0,
    activeBytes: 0,
    activeLines: 0,
    archivedFiles: 0,
    archivedBytes: 0,
    archivedLines: 0
  };
}

function addBucket(target: Bucket, value: Bucket): void {
  target.files += value.files;
  target.bytes += value.bytes;
  target.lines += value.lines;
}

function addMeasurement(target: FileMeasurement, value: FileMeasurement): void {
  addBucket(target, value);
  target.activeFiles += value.activeFiles;
  target.activeBytes += value.activeBytes;
  target.activeLines += value.activeLines;
  target.archivedFiles += value.archivedFiles;
  target.archivedBytes += value.archivedBytes;
  target.archivedLines += value.archivedLines;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return (text.match(/\n/g)?.length ?? 0) + (text.endsWith("\n") ? 0 : 1);
}

function isArchived(relativePath: string, text: string): boolean {
  if (relativePath.split(path.sep).some((part) => ["archive", "archived"].includes(part.toLowerCase()))) return true;
  if (!relativePath.endsWith(".yaml") && !relativePath.endsWith(".yml")) return false;
  try {
    return parseSimpleYaml(text).status === "archived";
  } catch {
    return false;
  }
}

function filesUnder(root: string, relativeDir: string): string[] {
  const fullDir = resolveFrom(root, relativeDir);
  if (!existsSync(fullDir) || !statSync(fullDir).isDirectory()) return [];
  const result: string[] = [];
  for (const entry of readdirSync(fullDir, { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(root, relativePath));
    else if (entry.isFile()) result.push(relativePath);
  }
  return result;
}

function measureFiles(root: string, relativePaths: string[], filter?: (file: string) => boolean): FileMeasurement {
  const result = emptyMeasurement();
  for (const relativePath of relativePaths.filter((file) => !filter || filter(file))) {
    const text = readFileSync(resolveFrom(root, relativePath), "utf8");
    const bytes = Buffer.byteLength(text, "utf8");
    const lines = countLines(text);
    const archived = isArchived(relativePath, text);
    result.files += 1;
    result.bytes += bytes;
    result.lines += lines;
    if (archived) {
      result.archivedFiles += 1;
      result.archivedBytes += bytes;
      result.archivedLines += lines;
    } else {
      result.activeFiles += 1;
      result.activeBytes += bytes;
      result.activeLines += lines;
    }
  }
  return result;
}

function asBucket(measurement: FileMeasurement): Bucket {
  return { files: measurement.files, bytes: measurement.bytes, lines: measurement.lines };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

function profileBucket(root: string, profile: Profile, categories: Record<string, FileMeasurement>): Bucket {
  const result: Bucket = { files: 0, bytes: 0, lines: 0 };
  for (const directory of profileRequiredDirs(profile)) {
    const category = categories[directory];
    if (category) addBucket(result, asBucket(category));
  }
  return result;
}

export function buildGovernanceCostSummary(root: string, now = new Date()): GovernanceCostSummary {
  const categories: Record<string, FileMeasurement> = {};
  for (const directory of GOVERNANCE_DIRS) {
    categories[directory] = measureFiles(root, filesUnder(root, directory));
  }
  categories["contracts/registry.yaml"] = measureFiles(
    root,
    existsSync(resolveFrom(root, "contracts/registry.yaml")) ? ["contracts/registry.yaml"] : []
  );

  const governance = emptyMeasurement();
  for (const category of Object.values(categories)) addMeasurement(governance, category);
  const source = measureFiles(root, filesUnder(root, "src"), (file) => file.endsWith(".ts"));
  const tests = measureFiles(root, filesUnder(root, "tests"), (file) => file.endsWith(".ts"));
  const profiles: Record<Profile, Bucket> = {
    Lean: profileBucket(root, "Lean", categories),
    Standard: profileBucket(root, "Standard", categories),
    Strict: profileBucket(root, "Strict", categories)
  };
  const historicalCi = readGithubActionsHistory(root);

  return {
    schemaVersion: "1.0.0",
    metric: "governance-cost",
    generatedAt: now.toISOString(),
    profile: readProfile(root),
    definitions: {
      lineCount: "UTF-8 newline count, plus one for a non-empty file without a trailing newline",
      activeArchive: "active is the default; status: archived or an archive/archived directory is separated",
      ratios: "governance lines divided by src TypeScript lines or test TypeScript lines; null means zero denominator",
      hardLimitEnforced: false
    },
    categories,
    profiles,
    totals: {
      governance,
      source: asBucket(source),
      tests: asBucket(tests),
      governanceToSourceLineRatio: ratio(governance.lines, source.lines),
      governanceToTestLineRatio: ratio(governance.lines, tests.lines)
    },
    historicalCi,
    unmeasured: [
      "historical local check duration",
      "finish attempts and metadata-only descendant count",
      "Human Gate wait time and publish-loop duration",
      "warning budgets and hard enforcement"
    ]
  };
}

export function runMetricsGovernance(root: string, options: MetricsOptions = {}): number {
  try {
    const summary = buildGovernanceCostSummary(root);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      return 0;
    }
    console.log(`Governance cost (${summary.profile})`);
    console.log(`- governance: ${summary.totals.governance.files} files, ${summary.totals.governance.lines} lines, ${summary.totals.governance.bytes} bytes`);
    console.log(`- source: ${summary.totals.source.files} files, ${summary.totals.source.lines} lines`);
    console.log(`- tests: ${summary.totals.tests.files} files, ${summary.totals.tests.lines} lines`);
    console.log(`- hard limit: not enforced; unmeasured dimensions: ${summary.unmeasured.length}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
