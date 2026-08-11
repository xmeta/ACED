import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseSimpleYaml } from "./yaml.js";

export const PACK_SCHEMA_VERSION = "scwbs.pack.v1" as const;
export const PACK_LOCK_SCHEMA_VERSION = "scwbs.packs-lock.v1" as const;
const lockPath = ".scwbs/packs.lock.json";
const maxPackBytes = 256_000;
const maxFiles = 200;

type PackFile = { source: string; target: string };
type PackPolicy = {
  requiredChecks: string[];
  humanGatePaths: string[];
  forbiddenPaths: string[];
  removed: string[];
};
export type GovernancePack = {
  schemaVersion: typeof PACK_SCHEMA_VERSION;
  id: string;
  version: string;
  description: string;
  requires: Record<string, string>;
  files: PackFile[];
  policy: PackPolicy;
  allowExecutableCode: boolean;
};

export type PackLockEntry = {
  id: string;
  version: string;
  source: string;
  digest: string;
  installedFiles: Array<{ path: string; sha256: string }>;
  policyFingerprint: string;
  installedAt: string;
};

type PackLock = { schemaVersion: typeof PACK_LOCK_SCHEMA_VERSION; packs: PackLockEntry[] };
type PackSource = {
  locator: string;
  read(relativePath: string): string;
};

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fail(message: string): never {
  throw new Error(message);
}

function safeRelative(relativePath: string): string {
  if (!relativePath || relativePath.includes("\0") || relativePath.includes("\\") || path.isAbsolute(relativePath)) {
    fail(`Unsafe pack path: ${relativePath}`);
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    fail(`Unsafe pack path: ${relativePath}`);
  }
  return normalized;
}

function safeRef(ref: string): string {
  if (!ref || ref.startsWith("-") || ref.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(ref)) fail(`Invalid pinned Git ref: ${ref}`);
  return ref;
}

function safeRepositoryPath(root: string, candidate: string): string {
  const rootPath = realpathSync(root);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(rootPath, resolved);
  if (relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) fail(`Pack source must be inside the repository: ${candidate}`);
  if (existsSync(resolved)) {
    const real = realpathSync(resolved);
    const realRelative = path.relative(rootPath, real);
    if (realRelative.startsWith(".." + path.sep) || realRelative === ".." || path.isAbsolute(realRelative)) fail(`Pack source crosses a symlink boundary: ${candidate}`);
  }
  return resolved;
}

function safeWritePath(root: string, relativePath: string): string {
  const normalized = safeRelative(relativePath);
  const rootPath = realpathSync(root);
  const target = path.resolve(rootPath, ...normalized.split("/"));
  const relative = path.relative(rootPath, target);
  if (relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) fail(`Unsafe pack path: ${relativePath}`);
  let current = rootPath;
  for (const segment of normalized.split("/")) {
    current = path.join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail(`Pack path crosses symlink: ${relativePath}`);
  }
  return target;
}

function text(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail(`Invalid pack ${field}`);
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxFiles || value.some((item) => typeof item !== "string" || item.length > 512)) fail(`Invalid pack ${field}`);
  return value.map((item) => item as string);
}

function mapRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parsePack(value: unknown): GovernancePack {
  const input = mapRecord(value);
  if (input.schemaVersion !== PACK_SCHEMA_VERSION) fail("Unsupported Governance Pack schemaVersion");
  const id = text(input.id, "id", 64);
  if (!/^[a-z0-9][a-z0-9.-]{1,63}$/.test(id)) fail(`Invalid pack id: ${id}`);
  const version = text(input.version, "version", 32);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail(`Invalid pack version: ${version}`);
  const contents = mapRecord(input.contents);
  const rawFiles = contents.files;
  if (rawFiles !== undefined && !Array.isArray(rawFiles)) fail("Invalid pack contents.files");
  const files = (rawFiles as unknown[] | undefined ?? []).map((item) => {
    if (typeof item === "string") {
      const source = safeRelative(item);
      return { source, target: source };
    }
    const record = mapRecord(item);
    const source = safeRelative(text(record.source, "contents.files.source", 512));
    const target = safeRelative(typeof record.target === "string" ? record.target : source);
    return { source, target };
  });
  if (files.length > maxFiles) fail("Governance Pack contains too many files");
  const policyInput = mapRecord(input.policy);
  const removed = [
    ...stringList(policyInput.removeRequiredChecks, "policy.removeRequiredChecks"),
    ...stringList(policyInput.removeHumanGatePaths, "policy.removeHumanGatePaths"),
    ...stringList(policyInput.removeForbiddenPaths, "policy.removeForbiddenPaths")
  ];
  const security = mapRecord(input.security);
  const allowExecutableCode = security.allowExecutableCode === true || input.allowExecutableCode === true;
  if (allowExecutableCode || Object.keys(contents).some((key) => /^(hooks|scripts|executables|commands)$/.test(key))) fail("Governance Pack executable code is forbidden");
  if (files.some((file) => /\.(?:js|mjs|cjs|sh|bash|zsh|ps1|bat|cmd)$/i.test(file.source))) fail("Governance Pack executable file is forbidden");
  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    id,
    version,
    description: typeof input.description === "string" ? input.description.slice(0, 1000) : "",
    requires: Object.fromEntries(Object.entries(mapRecord(input.requires)).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")),
    files,
    policy: {
      requiredChecks: stringList(policyInput.requiredChecks, "policy.requiredChecks"),
      humanGatePaths: stringList(policyInput.humanGatePaths, "policy.humanGatePaths"),
      forbiddenPaths: stringList(policyInput.forbiddenPaths, "policy.forbiddenPaths"),
      removed
    },
    allowExecutableCode
  };
}

function localSource(root: string, source: string): PackSource {
  const sourcePath = safeRepositoryPath(root, source);
  const packPath = existsSync(sourcePath) && lstatSync(sourcePath).isDirectory() ? path.join(sourcePath, "pack.yaml") : sourcePath;
  if (!existsSync(packPath)) fail(`Pack source is missing: ${source}`);
  return {
    locator: path.relative(root, path.dirname(packPath)).replaceAll(path.sep, "/") || ".",
    read(relativePath) {
      const resolved = safeRepositoryPath(path.dirname(packPath), relativePath);
      return readFileSync(resolved, "utf8");
    }
  };
}

function gitSource(root: string, repository: string, ref: string): PackSource {
  const repositoryPath = safeRepositoryPath(root, repository);
  safeRef(ref);
  const read = (relativePath: string): string => {
    safeRelative(relativePath);
    try {
      return execFileSync("git", ["-C", repositoryPath, "show", `${ref}:${relativePath}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      fail(`Pinned Git pack file is missing: ${relativePath}`);
    }
  };
  return { locator: `${path.relative(root, repositoryPath).replaceAll(path.sep, "/") || "."}#${ref}`, read };
}

function loadSource(root: string, source: string, ref?: string): { source: PackSource; pack: GovernancePack; fileContent: Map<string, string> } {
  const sourceValue = text(source, "source", 512);
  const hashIndex = sourceValue.lastIndexOf("#");
  const embeddedRef = hashIndex > 0 ? sourceValue.slice(hashIndex + 1) : undefined;
  const repository = embeddedRef ? sourceValue.slice(0, hashIndex) : sourceValue;
  const selectedRef = ref ?? embeddedRef;
  const packSource = selectedRef ? gitSource(root, repository, selectedRef) : localSource(root, sourceValue);
  const pack = parsePack(parseSimpleYaml(packSource.read("pack.yaml")));
  const fileContent = new Map<string, string>();
  for (const file of pack.files) {
    const content = packSource.read(file.source);
    if (Buffer.byteLength(content, "utf8") > maxPackBytes) fail(`Pack file is too large: ${file.source}`);
    fileContent.set(file.source, content);
  }
  return { source: packSource, pack, fileContent };
}

function policyDelta(pack: GovernancePack): { additions: Record<string, string[]>; rejectedDowngrades: string[] } {
  return {
    additions: {
      requiredChecks: [...pack.policy.requiredChecks],
      humanGatePaths: [...pack.policy.humanGatePaths],
      forbiddenPaths: [...pack.policy.forbiddenPaths]
    },
    rejectedDowngrades: [...pack.policy.removed]
  };
}

function policyFingerprint(pack: GovernancePack): string {
  return sha256(JSON.stringify({ policy: pack.policy, requires: pack.requires, security: { allowExecutableCode: pack.allowExecutableCode } }));
}

function digestPack(pack: GovernancePack, fileContent: Map<string, string>): string {
  const parts = [`${pack.schemaVersion}\0${pack.id}\0${pack.version}`];
  for (const file of [...pack.files].sort((a, b) => a.source.localeCompare(b.source))) parts.push(`${file.source}\0${sha256(fileContent.get(file.source) ?? "")}`);
  return sha256(parts.join("\0"));
}

function readLock(root: string): PackLock {
  const fullPath = safeWritePath(root, lockPath);
  if (!existsSync(fullPath)) return { schemaVersion: PACK_LOCK_SCHEMA_VERSION, packs: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(fullPath, "utf8")); } catch { fail("Pack lockfile is corrupt"); }
  const input = mapRecord(parsed);
  if (input.schemaVersion !== PACK_LOCK_SCHEMA_VERSION || !Array.isArray(input.packs)) fail("Unsupported or corrupt pack lockfile");
  return { schemaVersion: PACK_LOCK_SCHEMA_VERSION, packs: input.packs as PackLockEntry[] };
}

function writeLock(root: string, lock: PackLock): void {
  const fullPath = safeWritePath(root, lockPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

export function inspectPack(root: string, source: string, ref?: string): Record<string, unknown> {
  const loaded = loadSource(root, source, ref);
  const digest = digestPack(loaded.pack, loaded.fileContent);
  return {
    version: "scwbs.pack-inspect.v1",
    pack: loaded.pack,
    source: loaded.source.locator,
    digest,
    files: loaded.pack.files.map((file) => ({ path: file.target, sha256: sha256(loaded.fileContent.get(file.source) ?? "") })),
    effectivePolicyDelta: policyDelta(loaded.pack)
  };
}

export function listPacks(root: string): Record<string, unknown> {
  const lock = readLock(root);
  return { version: "scwbs.pack-list.v1", packs: lock.packs };
}

export function searchPacks(root: string, term: string): Record<string, unknown> {
  const query = term.toLowerCase();
  const lock = readLock(root);
  const matches = lock.packs.filter((pack) => `${pack.id} ${pack.version} ${pack.source}`.toLowerCase().includes(query));
  return { version: "scwbs.pack-search.v1", query: term, trust: "discovery-only", packs: matches };
}

export function infoPack(root: string, id: string): Record<string, unknown> {
  const lock = readLock(root);
  const pack = lock.packs.find((item) => item.id === id);
  if (!pack) fail(`Pack is not installed: ${id}`);
  return { version: "scwbs.pack-info.v1", trust: "discovery-only", pack };
}

export function installPack(root: string, source: string, options: { ref?: string; dryRun?: boolean; pin?: boolean; now?: string } = {}): Record<string, unknown> {
  if (!options.pin) fail("pack install requires --pin");
  const loaded = loadSource(root, source, options.ref);
  const digest = digestPack(loaded.pack, loaded.fileContent);
  const delta = policyDelta(loaded.pack);
  if (delta.rejectedDowngrades.length > 0) fail(`Pack policy downgrade rejected: ${delta.rejectedDowngrades.join(", ")}`);
  const lock = readLock(root);
  const existing = lock.packs.find((item) => item.id === loaded.pack.id);
  if (existing && (existing.digest !== digest || existing.version !== loaded.pack.version)) fail(`Pack ${loaded.pack.id} is already installed; use pack update`);
  const decisions: Array<{ action: string; path: string }> = [];
  const installedFiles = loaded.pack.files.map((file) => {
    const targetRelative = `.scwbs/packs/${loaded.pack.id}/${loaded.pack.version}/${file.target}`;
    const target = safeWritePath(root, targetRelative);
    const content = loaded.fileContent.get(file.source) ?? "";
    const contentHash = sha256(content);
    if (!existsSync(target)) decisions.push({ action: "create", path: targetRelative });
    else if (sha256(readFileSync(target)) === contentHash) decisions.push({ action: "unchanged", path: targetRelative });
    else decisions.push({ action: "divergent-preserved", path: targetRelative });
    if (!options.dryRun && !existsSync(target)) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    return { path: targetRelative, sha256: contentHash };
  });
  if (!options.dryRun) {
    const next: PackLock = {
      schemaVersion: PACK_LOCK_SCHEMA_VERSION,
      packs: [...lock.packs.filter((item) => item.id !== loaded.pack.id), { id: loaded.pack.id, version: loaded.pack.version, source: loaded.source.locator, digest, installedFiles, policyFingerprint: policyFingerprint(loaded.pack), installedAt: options.now ?? new Date().toISOString() }]
    };
    writeLock(root, next);
  }
  return { version: "scwbs.pack-operation.v1", operation: "install", dryRun: options.dryRun ?? false, source: loaded.source.locator, digest, effectivePolicyDelta: delta, decisions };
}

export function updatePack(root: string, id: string, options: { source?: string; ref?: string; dryRun?: boolean; pin?: boolean; now?: string } = {}): Record<string, unknown> {
  const installed = readLock(root).packs.find((pack) => pack.id === id);
  if (!installed) fail(`Pack is not installed: ${id}`);
  return installPack(root, options.source ?? installed.source.split("#")[0], { ref: options.ref ?? installed.source.split("#")[1], dryRun: options.dryRun, pin: options.pin ?? true, now: options.now });
}

export function removePack(root: string, id: string, options: { dryRun?: boolean } = {}): Record<string, unknown> {
  const lock = readLock(root);
  const installed = lock.packs.find((pack) => pack.id === id);
  if (!installed) fail(`Pack is not installed: ${id}`);
  const decision = { action: "policy-downgrade-blocked", id, reason: "Removing a Governance Pack can weaken effective policy; Human Gate is required." };
  if (!options.dryRun) fail(decision.reason);
  return { version: "scwbs.pack-operation.v1", operation: "remove", dryRun: true, decisions: [decision], pack: installed };
}
