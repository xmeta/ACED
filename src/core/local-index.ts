import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { headCommit } from "./git.js";
import { fileSha256 } from "./hash.js";
import { resolveFrom } from "./paths.js";
import { readJsonFile } from "./json.js";
import { readYamlFile } from "./yaml.js";

export const LOCAL_INDEX_VERSION = "scwbs.local-index.v1" as const;
export const QUERY_VERSION = "scwbs.query.v1" as const;
export const INDEX_STATUS_VERSION = "scwbs.index-status.v1" as const;
export const INDEX_VERIFY_VERSION = "scwbs.index-verify.v1" as const;
export const INDEX_REBUILD_VERSION = "scwbs.index-rebuild.v1" as const;
export const LOCAL_INDEX_PATH = ".scwbs/cache/index.sqlite";
const MAX_QUERY_RESULTS = 100;
const MAX_SNIPPET_LENGTH = 500;
const require = createRequire(import.meta.url);
type DatabaseOptions = ConstructorParameters<typeof import("node:sqlite").DatabaseSync>[1];

function openDatabase(filePath: string, options?: DatabaseOptions): import("node:sqlite").DatabaseSync {
  const sqlite = require("node:sqlite") as typeof import("node:sqlite");
  return options === undefined ? new sqlite.DatabaseSync(filePath) : new sqlite.DatabaseSync(filePath, options);
}

type JsonObject = Record<string, unknown>;
type IndexKind = "spec" | "requirement" | "task" | "evidence" | "review" | "approval" | "block" | "discovery" | "wbs" | "finding";

export type IndexedRecord = {
  id: string;
  kind: IndexKind;
  title: string;
  body: string;
  status: string;
  sourcePath: string;
  sourceHash: string;
  schemaVersion: string;
  indexedAt: string;
  repositoryHead: string;
  locator: string;
};

export type IndexStatus = {
  version: typeof INDEX_STATUS_VERSION;
  status: "ready" | "missing" | "stale" | "corrupt";
  path: string;
  indexedAt?: string;
  repositoryHead?: string;
  recordCount?: number;
  sourceManifestHash?: string;
  reasons: string[];
};

export type QueryOptions = {
  text?: string;
  kinds?: string[];
  status?: string;
  unverified?: boolean;
  stale?: boolean;
  limit?: number;
};

export type QueryOutput = {
  version: typeof QUERY_VERSION;
  status: IndexStatus["status"];
  query: { text?: string; kinds: string[]; status?: string; unverified: boolean; stale: boolean; limit: number };
  indexedAt?: string;
  repositoryHead?: string;
  total: number;
  omitted: number;
  results: Array<Omit<IndexedRecord, "body"> & { snippet: string; stale: boolean }>;
  reasons: string[];
};

const sourceRoots = [
  "contracts/specs",
  "contracts/tasks",
  "contracts/evidence",
  "contracts/approvals",
  "contracts/reviews",
  "contracts/blocks",
  "contracts/discovery"
] as const;
const taskIndexSourcePath = "contracts/tasks/index.yaml";

const kindAliases: Record<string, IndexKind> = {
  spec: "spec", specs: "spec",
  requirement: "requirement", requirements: "requirement",
  task: "task", tasks: "task",
  evidence: "evidence", evidences: "evidence",
  review: "review", reviews: "review",
  approval: "approval", approvals: "approval",
  block: "block", blocks: "block",
  discovery: "discovery", discoveries: "discovery",
  wbs: "wbs", finding: "finding", findings: "finding"
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 50_000 ? `${text.slice(0, 49_997)}...` : text;
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function schemaVersion(value: JsonObject): string {
  return textValue(value.schemaVersion ?? value.version, "unknown");
}

function walkFiles(root: string, directory: string): string[] {
  const full = resolveFrom(root, directory);
  if (!existsSync(full)) return [];
  const output: string[] = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(root, relative));
    else if (entry.isFile() && /\.(yaml|yml|json)$/.test(entry.name)) output.push(relative);
  }
  return output.sort();
}

function uniqueSortedPaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))].sort();
}

function canonicalArtifactPaths(root: string): string[] {
  return uniqueSortedPaths(
    sourceRoots.flatMap((directory) => walkFiles(root, directory))
      .filter((relative) => relative !== taskIndexSourcePath)
  );
}

function freshnessManifestPaths(root: string): string[] {
  return uniqueSortedPaths([
    ...canonicalArtifactPaths(root),
    existsSync(resolveFrom(root, taskIndexSourcePath)) ? taskIndexSourcePath : "",
    existsSync(resolveFrom(root, "contracts/wbs/project.wbs.json")) ? "contracts/wbs/project.wbs.json" : ""
  ]);
}

function sourceManifest(root: string): { paths: string[]; hash: string } {
  const paths = freshnessManifestPaths(root);
  const hash = createHash("sha256");
  for (const relative of paths) {
    hash.update(relative);
    hash.update("\0");
    try { hash.update(fileSha256(root, relative)); } catch { hash.update("missing"); }
    hash.update("\n");
  }
  return { paths, hash: `sha256:${hash.digest("hex")}` };
}

function parseCanonical(root: string, relative: string): unknown {
  const full = resolveFrom(root, relative);
  return relative.endsWith(".json") ? readJsonFile(full) : readYamlFile(full);
}

function statusMap(root: string): Map<string, string> {
  const result = new Map<string, string>();
  const relative = taskIndexSourcePath;
  if (!existsSync(resolveFrom(root, relative))) return result;
  const value = parseCanonical(root, relative);
  if (!isObject(value) || !Array.isArray(value.tasks)) return result;
  for (const item of value.tasks) {
    if (!isObject(item) || typeof item.id !== "string") continue;
    if (typeof item.status === "string") result.set(item.id, item.status);
  }
  return result;
}

function sourceKind(relative: string): IndexKind | undefined {
  if (relative === taskIndexSourcePath) return undefined;
  if (relative.includes("/specs/")) return "spec";
  if (relative.includes("/tasks/")) return "task";
  if (relative.includes("/evidence/")) return "evidence";
  if (relative.includes("/approvals/")) return "approval";
  if (relative.includes("/reviews/")) return "review";
  if (relative.includes("/blocks/")) return "block";
  if (relative.includes("/discovery/")) return "discovery";
  if (relative === "contracts/wbs/project.wbs.json") return "wbs";
  return undefined;
}

type IndexBuildContext = { indexedAt: string; repositoryHead: string; sourceHash: string };

function baseRecord(relative: string, raw: JsonObject, kind: IndexKind, id: string, title: string, status: string, context: IndexBuildContext, locator = ""): IndexedRecord {
  return {
    id,
    kind,
    title,
    body: safeJson(raw),
    status,
    sourcePath: relative,
    sourceHash: context.sourceHash,
    schemaVersion: schemaVersion(raw),
    indexedAt: context.indexedAt,
    repositoryHead: context.repositoryHead,
    locator: locator || relative
  };
}

function recordsForSource(root: string, relative: string, statuses: Map<string, string>, context: Omit<IndexBuildContext, "sourceHash">): IndexedRecord[] {
  const rawValue = parseCanonical(root, relative);
  if (!isObject(rawValue)) return [];
  const kind = sourceKind(relative);
  if (!kind) return [];
  const id = textValue(rawValue.id, relative);
  const title = textValue(rawValue.title ?? rawValue.name ?? rawValue.question ?? rawValue.reason, id);
  const status = kind === "task" ? statuses.get(id) ?? textValue(rawValue.status, "planned") : textValue(rawValue.status, "unclassified");
  const buildContext = { ...context, sourceHash: fileSha256(root, relative) };
  const records = [baseRecord(relative, rawValue, kind, id, title, status, buildContext)];

  if (kind === "spec") {
    const requirements = Array.isArray(rawValue.requirements) ? rawValue.requirements : Array.isArray(rawValue.acceptanceCriteria) ? rawValue.acceptanceCriteria : [];
    requirements.forEach((item, index) => {
      const value = typeof item === "string" ? { statement: item } : isObject(item) ? item : {};
      const requirementId = textValue(value.id, `${id}:requirement:${index + 1}`);
      records.push(baseRecord(relative, rawValue, "requirement", requirementId, textValue(value.statement ?? value.title, requirementId), value.verified === true ? "verified" : "unverified", buildContext, `${relative}#/requirements/${index}`));
    });
  }
  if (kind === "wbs" && Array.isArray(rawValue.nodes)) {
    rawValue.nodes.forEach((item, index) => {
      if (!isObject(item)) return;
      const nodeId = textValue(item.id, `${id}:node:${index}`);
      records.push(baseRecord(relative, rawValue, "wbs", nodeId, textValue(item.name, nodeId), textValue(item.status, "planned"), buildContext, `${relative}#/nodes/${index}`));
    });
  }
  for (const field of ["findings", "issues", "remediations"]) {
    if (!Array.isArray(rawValue[field])) continue;
    rawValue[field].forEach((item, index) => {
      const value = isObject(item) ? item : { message: String(item) };
      const findingId = textValue(value.id ?? value.code, `${id}:${field}:${index}`);
      records.push(baseRecord(relative, rawValue, "finding", findingId, textValue(value.message ?? value.title ?? value.reason, findingId), textValue(value.status ?? value.severity, "open"), buildContext, `${relative}#/${field}/${index}`));
    });
  }
  return records;
}

function databasePath(root: string): string {
  return resolveFrom(root, LOCAL_INDEX_PATH);
}

function schemaSql(): string {
  return `CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  repository_head TEXT NOT NULL,
  locator TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS records_kind_idx ON records(kind);
CREATE INDEX IF NOT EXISTS records_status_idx ON records(status);
CREATE INDEX IF NOT EXISTS records_title_idx ON records(title);`;
}

function readMetadata(root: string): Map<string, string> {
  const db = openDatabase(databasePath(root), { readOnly: true });
  try {
    const rows = db.prepare("SELECT key, value FROM metadata").all() as Array<{ key: string; value: string }>;
    return new Map(rows.map((row) => [row.key, row.value]));
  } finally {
    db.close();
  }
}

export function indexStatus(root: string): IndexStatus {
  const pathValue = LOCAL_INDEX_PATH;
  if (!existsSync(databasePath(root))) return { version: INDEX_STATUS_VERSION, status: "missing", path: pathValue, reasons: ["index.missing"] };
  try {
    const metadata = readMetadata(root);
    if (metadata.get("schemaVersion") !== LOCAL_INDEX_VERSION) return { version: INDEX_STATUS_VERSION, status: "corrupt", path: pathValue, reasons: ["index.schema.invalid"] };
    const current = sourceManifest(root);
    const reasons: string[] = [];
    if (metadata.get("sourceManifestHash") !== current.hash) reasons.push("index.source.stale");
    const currentHead = headCommit(root) ?? "unavailable";
    if (metadata.get("repositoryHead") !== currentHead) reasons.push("index.head.stale");
    const status: IndexStatus["status"] = reasons.length > 0 ? "stale" : "ready";
    return {
      version: INDEX_STATUS_VERSION,
      status,
      path: pathValue,
      indexedAt: metadata.get("indexedAt"),
      repositoryHead: metadata.get("repositoryHead"),
      recordCount: Number(metadata.get("recordCount") ?? 0),
      sourceManifestHash: metadata.get("sourceManifestHash"),
      reasons: reasons.length > 0 ? reasons : ["index.current"]
    };
  } catch (error) {
    return { version: INDEX_STATUS_VERSION, status: "corrupt", path: pathValue, reasons: ["index.corrupt", error instanceof Error ? error.message : String(error)] };
  }
}

export function verifyIndex(root: string): JsonObject {
  const status = indexStatus(root);
  const statusFields: Omit<IndexStatus, "version"> = {
    status: status.status,
    path: status.path,
    indexedAt: status.indexedAt,
    repositoryHead: status.repositoryHead,
    recordCount: status.recordCount,
    sourceManifestHash: status.sourceManifestHash,
    reasons: status.reasons
  };
  return { version: INDEX_VERIFY_VERSION, ...statusFields, recoverCommand: "scwbs index rebuild --json" };
}

export function rebuildIndex(root: string): JsonObject {
  const indexedAt = new Date().toISOString();
  const repositoryHead = headCommit(root) ?? "unavailable";
  const manifest = sourceManifest(root);
  const statuses = statusMap(root);
  const records = canonicalArtifactPaths(root).flatMap((relative) => recordsForSource(root, relative, statuses, { indexedAt, repositoryHead }));
  const destination = databasePath(root);
  const directory = path.dirname(destination);
  mkdirSync(directory, { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  const db = openDatabase(temporary);
  try {
    db.exec(schemaSql());
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO records (id, kind, title, body, status, source_path, source_hash, schema_version, indexed_at, repository_head, locator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const record of records) insert.run(record.id + ":" + record.kind + ":" + record.locator, record.kind, record.title, record.body, record.status, record.sourcePath, record.sourceHash, record.schemaVersion, indexedAt, repositoryHead, record.locator);
    const metadata = db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
    for (const [key, value] of [["schemaVersion", LOCAL_INDEX_VERSION], ["indexedAt", indexedAt], ["repositoryHead", repositoryHead], ["sourceManifestHash", manifest.hash], ["recordCount", String(records.length)]] as const) metadata.run(key, value);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
    throw error;
  } finally {
    db.close();
  }
  rmSync(destination, { force: true });
  renameSync(temporary, destination);
  return { version: INDEX_REBUILD_VERSION, status: "pass", path: LOCAL_INDEX_PATH, indexedAt, repositoryHead, recordCount: records.length, sourceManifestHash: manifest.hash };
}

function canonicalKinds(input: string[] | undefined): IndexKind[] {
  return Array.from(new Set((input ?? []).map((item) => kindAliases[item.trim().toLowerCase()]).filter((item): item is IndexKind => item !== undefined)));
}

function recordIsStale(root: string, record: { sourcePath: string; sourceHash: string }): boolean {
  try { return fileSha256(root, record.sourcePath) !== record.sourceHash; } catch { return true; }
}

export function queryIndex(root: string, options: QueryOptions = {}): QueryOutput {
  const index = indexStatus(root);
  const requestedKinds = options.kinds ?? [];
  const kinds = canonicalKinds(options.kinds);
  const limit = Math.max(1, Math.min(MAX_QUERY_RESULTS, Math.floor(options.limit ?? MAX_QUERY_RESULTS)));
  const query = { ...(options.text ? { text: options.text.slice(0, 256) } : {}), kinds: kinds.map((kind) => kind), ...(options.status ? { status: options.status.slice(0, 64) } : {}), unverified: options.unverified === true, stale: options.stale === true, limit };
  const invalidKinds = requestedKinds.filter((item) => !kindAliases[item.trim().toLowerCase()]);
  if (index.status === "missing" || index.status === "corrupt" || invalidKinds.length > 0) {
    return { version: QUERY_VERSION, status: invalidKinds.length > 0 ? "corrupt" : index.status, query, total: 0, omitted: 0, results: [], reasons: invalidKinds.length > 0 ? ["query.kind.invalid"] : index.reasons };
  }
  const db = openDatabase(databasePath(root), { readOnly: true });
  try {
    const where: string[] = [];
    const parameters: Array<string> = [];
    if (kinds.length > 0) { where.push(`kind IN (${kinds.map(() => "?").join(",")})`); parameters.push(...kinds); }
    if (options.status) { where.push("status = ?"); parameters.push(options.status.slice(0, 64)); }
    if (options.unverified) where.push("kind = 'requirement' AND status <> 'verified'");
    if (options.text) { where.push("(lower(title) LIKE lower(?) OR lower(body) LIKE lower(?))"); const text = `%${options.text.slice(0, 256)}%`; parameters.push(text, text); }
    const sql = `SELECT id, kind, title, body, status, source_path AS sourcePath, source_hash AS sourceHash, schema_version AS schemaVersion, indexed_at AS indexedAt, repository_head AS repositoryHead, locator FROM records${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY kind, id LIMIT ?`;
    parameters.push(String(limit));
    const rows = db.prepare(sql).all(...parameters) as Array<IndexedRecord & { sourcePath: string; sourceHash: string; schemaVersion: string; indexedAt: string; repositoryHead: string }>;
    const filtered = rows.map((record) => ({ ...record, stale: recordIsStale(root, record) })).filter((record) => !options.stale || record.stale);
    return {
      version: QUERY_VERSION,
      status: index.status,
      query,
      indexedAt: index.indexedAt,
      repositoryHead: index.repositoryHead,
      total: filtered.length,
      omitted: Math.max(0, (index.recordCount ?? 0) - filtered.length),
      results: filtered.map(({ body, ...record }) => ({ ...record, snippet: body.slice(0, MAX_SNIPPET_LENGTH) })),
      reasons: index.reasons
    };
  } finally {
    db.close();
  }
}

export function normalizeQueryKind(value: string | undefined): { text?: string; kinds?: string[] } {
  if (!value) return {};
  if (kindAliases[value.toLowerCase()]) return { kinds: [value] };
  return { text: value };
}
