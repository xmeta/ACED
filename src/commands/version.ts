import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildUpgradeDryRunOutput,
  buildVersionCheckOutput,
  installedPackageFromJson,
  resolveReleaseManifest,
  verifyReleaseArtifact,
  type DistributionReason,
  type ReleaseResolverOptions
} from "../core/distribution.js";

export type VersionCommandOptions = ReleaseResolverOptions & { json?: boolean };

function cliPackageJson(): unknown {
  const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
  return JSON.parse(readFileSync(packagePath, "utf8"));
}

function print(value: unknown, json: boolean): void {
  console.log(json ? JSON.stringify(value) : JSON.stringify(value, null, 2));
}

function packageJsonAt(root: string): unknown {
  const packagePath = path.join(root, "package.json");
  if (!existsSync(packagePath)) return {};
  try {
    return JSON.parse(readFileSync(packagePath, "utf8"));
  } catch {
    return {};
  }
}

function appendResolverReasons<T extends { reasons: DistributionReason[] }>(result: T, reasons: DistributionReason[]): T {
  if (reasons.length === 0) return result;
  return { ...result, reasons: [...result.reasons, ...reasons] };
}

export function runVersion(root: string, options: VersionCommandOptions = {}): number {
  const installed = installedPackageFromJson(cliPackageJson());
  if (options.json) {
    print({ version: "scwbs.version.v1", status: "pass", packageVersion: installed.packageVersion, cliVersion: installed.cliVersion }, true);
  } else {
    console.log(installed.cliVersion);
  }
  return installed.integrity === "pass" ? 0 : 1;
}

export async function runVersionCheck(root: string, options: VersionCommandOptions = {}): Promise<number> {
  const installed = installedPackageFromJson(cliPackageJson());
  const resolved = await resolveReleaseManifest(options);
  const artifactReasons = resolved.manifest && options.artifactPath ? verifyReleaseArtifact(resolved.manifest, options.artifactPath) : [];
  const output = appendResolverReasons(buildVersionCheckOutput(installed, resolved.manifest), [...resolved.reasons, ...artifactReasons]);
  print(output, options.json ?? false);
  return output.status === "pass" ? 0 : 1;
}

export async function runUpgrade(root: string, options: VersionCommandOptions & { dryRun?: boolean } = {}): Promise<number> {
  if (!options.dryRun) {
    const output = {
      version: "scwbs.upgrade-dry-run.v1",
      status: "blocked",
      dryRun: false,
      unattendedUpgrade: "disabled",
      mutations: [],
      reasons: [{ code: "upgrade.unattended.disabled", message: "upgrade requires --dry-run; unattended mutation is disabled" }]
    };
    print(output, options.json ?? false);
    return 2;
  }
  const installed = installedPackageFromJson(cliPackageJson());
  const resolved = await resolveReleaseManifest(options);
  const output = buildUpgradeDryRunOutput(packageJsonAt(root), installed, resolved.manifest, resolved.reasons);
  print(output, options.json ?? false);
  return output.status === "pass" ? 0 : 1;
}
