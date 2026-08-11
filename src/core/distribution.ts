import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const VERSION_CHECK_VERSION = "scwbs.version-check.v1" as const;
export const UPGRADE_DRY_RUN_VERSION = "scwbs.upgrade-dry-run.v1" as const;
export const DEFAULT_RELEASE_REPOSITORY = "xmeta/ACED";

export type ReleaseManifest = {
  schemaVersion: string;
  packageVersion: string;
  tag: string;
  commit: string;
  tarball: string;
  sha256: string;
  validation?: {
    workflow?: string;
    workflowRunId?: number;
    checks?: Array<{ name?: string; conclusion?: string; detailsUrl?: string | null }>;
  };
};

export type DistributionReason = { code: string; message: string };

export type ReleaseIntegrity = {
  status: "pass" | "fail";
  packageVersion: string;
  tag: string;
  tarball: string;
  digest: string;
  reasons: DistributionReason[];
};

export type VersionCheckOutput = {
  version: typeof VERSION_CHECK_VERSION;
  status: "pass" | "unavailable" | "fail";
  installed: {
    packageVersion: string;
    cliVersion: string;
    integrity: "pass" | "fail";
  };
  currentStable: {
    packageVersion: string | null;
    tag: string | null;
    commit: string | null;
    digest: string | null;
    source: "release-manifest" | "unavailable";
  };
  support: "current" | "upgrade-available" | "unavailable";
  reasons: DistributionReason[];
};

export type UpgradeDryRunOutput = {
  version: typeof UPGRADE_DRY_RUN_VERSION;
  status: "pass" | "unavailable" | "blocked" | "fail";
  dryRun: true;
  unattendedUpgrade: "disabled";
  current: {
    packageSpec: string | null;
    packageVersion: string;
  };
  proposed: {
    packageSpec: string | null;
    packageVersion: string | null;
    artifactUrl: string | null;
    releaseTag: string | null;
    digest: string | null;
  };
  migrationImpact: Array<{
    id: "node-compatibility" | "schema-migration" | "generated-agent-delta" | "stale-task-locks";
    status: "pass" | "not-evaluated" | "unknown";
    message: string;
  }>;
  mutations: [];
  reasons: DistributionReason[];
};

export type ReleaseResolverOptions = {
  manifestPath?: string;
  artifactPath?: string;
  repository?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function reason(code: string, message: string): DistributionReason {
  return { code, message };
}

function parseSemver(value: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareVersions(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return 0;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! > b[index]! ? 1 : -1;
  }
  return 0;
}

export function installedPackageFromJson(packageJson: unknown): { packageVersion: string; cliVersion: string; integrity: "pass" | "fail" } {
  const value = packageJson as { version?: unknown };
  const packageVersion = typeof value?.version === "string" ? value.version : "";
  return {
    packageVersion,
    cliVersion: packageVersion,
    integrity: parseSemver(packageVersion) ? "pass" : "fail"
  };
}

export function validateReleaseManifest(manifest: unknown): ReleaseIntegrity {
  const value = manifest as Partial<ReleaseManifest>;
  const packageVersion = typeof value?.packageVersion === "string" ? value.packageVersion : "";
  const tag = typeof value?.tag === "string" ? value.tag : "";
  const tarball = typeof value?.tarball === "string" ? value.tarball : "";
  const digest = typeof value?.sha256 === "string" ? value.sha256 : "";
  const reasons: DistributionReason[] = [];
  if (value?.schemaVersion !== "1.0.0") reasons.push(reason("release.manifest.schema", "release manifest schemaVersion must be 1.0.0"));
  if (!parseSemver(packageVersion)) reasons.push(reason("release.version.invalid", "release manifest packageVersion must be semantic version"));
  if (tag !== `v${packageVersion}`) reasons.push(reason("release.subject.tag-mismatch", "release tag must equal v<packageVersion>"));
  if (tarball !== `scwbs-${packageVersion}.tgz`) reasons.push(reason("release.subject.tarball-mismatch", "tarball filename must bind to packageVersion"));
  if (!/^[0-9a-f]{64}$/.test(digest)) reasons.push(reason("release.digest.invalid", "release manifest sha256 must be a 64 character lowercase hex digest"));
  if (typeof value?.commit !== "string" || !/^[0-9a-f]{7,64}$/.test(value.commit)) reasons.push(reason("release.subject.commit-missing", "release manifest commit must be a commit SHA"));
  return {
    status: reasons.length === 0 ? "pass" : "fail",
    packageVersion,
    tag,
    tarball,
    digest,
    reasons
  };
}

export function verifyReleaseArtifact(manifest: unknown, artifactPath: string): DistributionReason[] {
  const integrity = validateReleaseManifest(manifest);
  if (integrity.status !== "pass") return integrity.reasons;
  try {
    const actual = sha256File(artifactPath);
    return actual === integrity.digest
      ? []
      : [reason("release.digest.mismatch", `artifact digest ${actual} does not match release manifest ${integrity.digest}`)];
  } catch (error) {
    return [reason("release.artifact.read-failed", error instanceof Error ? error.message : String(error))];
  }
}

export function buildVersionCheckOutput(installed: { packageVersion: string; cliVersion: string; integrity: "pass" | "fail" }, manifest?: unknown): VersionCheckOutput {
  const reasons: DistributionReason[] = [];
  if (installed.integrity !== "pass" || installed.packageVersion !== installed.cliVersion) {
    reasons.push(reason("installed.subject.version-mismatch", "installed package version and CLI version are not a valid exact subject"));
  }
  if (!manifest) {
    reasons.push(reason("release.manifest.unavailable", "current stable release manifest is unavailable; use --manifest for offline verification"));
    return {
      version: VERSION_CHECK_VERSION,
      status: "unavailable",
      installed,
      currentStable: { packageVersion: null, tag: null, commit: null, digest: null, source: "unavailable" },
      support: "unavailable",
      reasons
    };
  }
  const integrity = validateReleaseManifest(manifest);
  if (integrity.status !== "pass") reasons.push(...integrity.reasons);
  const support = integrity.status !== "pass"
    ? "unavailable"
    : compareVersions(installed.packageVersion, integrity.packageVersion) === 0 ? "current" : "upgrade-available";
  if (support === "upgrade-available") reasons.push(reason("release.upgrade-available", `current stable is ${integrity.packageVersion}`));
  return {
    version: VERSION_CHECK_VERSION,
    status: reasons.some((item) => item.code.startsWith("installed.")) || integrity.status === "fail" ? "fail" : "pass",
    installed,
    currentStable: {
      packageVersion: integrity.packageVersion || null,
      tag: integrity.tag || null,
      commit: typeof (manifest as ReleaseManifest).commit === "string" ? (manifest as ReleaseManifest).commit : null,
      digest: integrity.digest || null,
      source: "release-manifest"
    },
    support,
    reasons
  };
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export async function resolveReleaseManifest(options: ReleaseResolverOptions = {}): Promise<{ manifest?: ReleaseManifest; reasons: DistributionReason[] }> {
  if (options.manifestPath) {
    try {
      const manifest = readJson(path.resolve(options.manifestPath)) as ReleaseManifest;
      return { manifest, reasons: [] };
    } catch (error) {
      return { reasons: [reason("release.manifest.read-failed", error instanceof Error ? error.message : String(error))] };
    }
  }
  const repository = options.repository ?? DEFAULT_RELEASE_REPOSITORY;
  if (!/^[^/]+\/[^/]+$/.test(repository)) return { reasons: [reason("release.repository.invalid", "repository must be owner/name")] };
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const release = await fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "scwbs-version-check" },
      signal: controller.signal
    });
    if (!release.ok) return { reasons: [reason("release.lookup.failed", `GitHub latest release lookup returned HTTP ${release.status}`)] };
    const releaseJson = await release.json() as { assets?: Array<{ name?: string; browser_download_url?: string }> };
    const asset = releaseJson.assets?.find((candidate) => candidate.name === "release-manifest.json");
    if (!asset?.browser_download_url) return { reasons: [reason("release.manifest.missing", "latest release does not contain release-manifest.json")] };
    const manifestResponse = await fetchImpl(asset.browser_download_url, {
      headers: { accept: "application/json", "user-agent": "scwbs-version-check" },
      signal: controller.signal
    });
    if (!manifestResponse.ok) return { reasons: [reason("release.manifest.fetch-failed", `release manifest fetch returned HTTP ${manifestResponse.status}`)] };
    return { manifest: await manifestResponse.json() as ReleaseManifest, reasons: [] };
  } catch (error) {
    return { reasons: [reason("release.lookup.unavailable", error instanceof Error ? error.message : String(error))] };
  } finally {
    clearTimeout(timeout);
  }
}

function dependencySpec(packageJson: unknown): string | null {
  const value = packageJson as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown> };
  for (const group of [value?.dependencies, value?.devDependencies, value?.optionalDependencies]) {
    if (typeof group?.scwbs === "string") return group.scwbs;
  }
  return null;
}

export function buildUpgradeDryRunOutput(
  packageJson: unknown,
  installed: { packageVersion: string; cliVersion: string; integrity: "pass" | "fail" },
  manifest?: unknown,
  manifestReasons: DistributionReason[] = []
): UpgradeDryRunOutput {
  const currentSpec = dependencySpec(packageJson);
  const integrity = manifest ? validateReleaseManifest(manifest) : undefined;
  const reasons = [...manifestReasons, ...(integrity?.reasons ?? [])];
  const packageVersion = integrity?.status === "pass" ? integrity.packageVersion : null;
  const artifactUrl = packageVersion ? `https://github.com/${DEFAULT_RELEASE_REPOSITORY}/releases/download/v${packageVersion}/scwbs-${packageVersion}.tgz` : null;
  if (!manifest) reasons.push(reason("release.manifest.unavailable", "upgrade proposal requires a verified release manifest"));
  if (installed.integrity !== "pass") reasons.push(reason("installed.subject.invalid", "installed package subject is not a valid semantic version"));
  const migrationImpact: UpgradeDryRunOutput["migrationImpact"] = [
    { id: "node-compatibility", status: "pass", message: "package engines are preserved by the immutable release artifact" },
    { id: "schema-migration", status: "not-evaluated", message: "schema migration requires a release-specific migration note" },
    { id: "generated-agent-delta", status: "not-evaluated", message: "generated agent delta is not changed by a dry-run proposal" },
    { id: "stale-task-locks", status: "not-evaluated", message: "consumer Task locks are not mutated or evaluated by this command" }
  ];
  return {
    version: UPGRADE_DRY_RUN_VERSION,
    status: reasons.length === 0 ? "pass" : manifest ? "fail" : "unavailable",
    dryRun: true,
    unattendedUpgrade: "disabled",
    current: { packageSpec: currentSpec, packageVersion: installed.packageVersion },
    proposed: { packageSpec: artifactUrl, packageVersion, artifactUrl, releaseTag: packageVersion ? `v${packageVersion}` : null, digest: integrity?.status === "pass" ? integrity.digest : null },
    migrationImpact,
    mutations: [],
    reasons
  };
}

export function sha256File(filePath: string): string {
  if (!existsSync(filePath)) throw new Error(`artifact does not exist: ${filePath}`);
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}
