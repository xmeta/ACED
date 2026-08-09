import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectCheckIssues } from "./check.js";
import { collectHealthIssues } from "./health.js";
import { resolveFrom } from "../core/paths.js";
import type { Issue } from "../core/types.js";

export type EnvironmentRuntime = {
  nodeVersion?: string;
  npmVersion?: string;
  corepackAvailable?: boolean;
  corepackVersion?: string;
  corepackNpmVersion?: string;
  dependencyGraphStatus?: number;
  dependencyGraphOutput?: string;
};

export type DoctorDiagnostic = {
  id: string;
  label: string;
  status: "pass" | "fail";
  message: string;
  fix: string;
  details?: Record<string, string | number | boolean>;
};

export type DoctorOptions = {
  fix?: boolean;
  json?: boolean;
};

export type DoctorJsonOutput = {
  status: "pass" | "fail";
  diagnostics: DoctorDiagnostic[];
  contractIssues: Array<{ source: "check" | "health"; issue: Issue }>;
  fixResults?: Array<{ id: string; status: "ok" | "fail"; message: string }>;
};

export type DoctorFixStep = {
  command: string;
  args: string[];
  cwd: string;
};

type CommandResult = { status: number | null; stdout: string; stderr: string };

function runCommand(command: string, args: string[], cwd?: string): CommandResult {
  try {
    const result = spawnSync(command, args, { cwd, encoding: "utf8" });
    return {
      status: result.status,
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim()
    };
  } catch {
    return { status: null, stdout: "", stderr: "" };
  }
}

function runShellVersion(command: string, args: string[]): string {
  const result = runCommand(command, args);
  if (result.status !== 0) return "";
  return result.stdout || result.stderr;
}

type Version = [number, number, number];

function parseVersion(version: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseMinimumVersion(range: string): Version | undefined {
  const match = /(?:^|\s)>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function parseNodeVersion(version: string): Version | undefined {
  return parseVersion(version);
}

function meetsMinimumVersion(actual: Version, minimum: Version): boolean {
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index]! > minimum[index]!) return true;
    if (actual[index]! < minimum[index]!) return false;
  }
  return true;
}

type NodeEngineSource = "package.json" | "scwbs CLI package.json";

type NodeEngineInfo =
  | { range: string; source: NodeEngineSource }
  | { range: undefined; source: undefined }
  | { range: undefined; source: undefined; corrupt: true };

type RepositoryPackageJson = {
  engines?: { node?: unknown; npm?: unknown };
  packageManager?: unknown;
  workspaces?: unknown;
};

type RepositoryPackageInfo = {
  packageJson?: RepositoryPackageJson;
  corrupt: boolean;
};

function readRepositoryPackage(root: string): RepositoryPackageInfo {
  const packagePath = resolveFrom(root, "package.json");
  if (!existsSync(packagePath)) return { corrupt: false };
  try {
    return { packageJson: JSON.parse(readFileSync(packagePath, "utf8")) as RepositoryPackageJson, corrupt: false };
  } catch {
    return { corrupt: true };
  }
}

function readRepoNodeEngine(root: string): { range?: string; missingEngine: boolean; corrupt: boolean } {
  const repository = readRepositoryPackage(root);
  if (repository.corrupt) return { missingEngine: false, corrupt: true };
  if (!repository.packageJson) return { missingEngine: false, corrupt: false };
  return typeof repository.packageJson?.engines?.node === "string"
    ? { range: repository.packageJson.engines.node, missingEngine: false, corrupt: false }
    : { missingEngine: true, corrupt: false };
}

function readCliNodeEngine(): string | undefined {
  try {
    const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
      engines?: { node?: unknown };
    };
    return typeof packageJson.engines?.node === "string" ? packageJson.engines.node : undefined;
  } catch {
    return undefined;
  }
}

function readNodeEngine(root: string): NodeEngineInfo {
  const repo = readRepoNodeEngine(root);
  if (repo.corrupt) {
    return { range: undefined, source: undefined, corrupt: true };
  }
  if (repo.range) {
    return { range: repo.range, source: "package.json" };
  }
  if (repo.missingEngine) {
    return { range: undefined, source: undefined };
  }
  const cliRange = readCliNodeEngine();
  if (cliRange) {
    return { range: cliRange, source: "scwbs CLI package.json" };
  }
  return { range: undefined, source: undefined };
}

function nodeEngineDiagnostic(root: string, nodeVersion: string): DoctorDiagnostic {
  const engine = readNodeEngine(root);
  const range = engine.range;
  const source = engine.source;
  const minimum = range ? parseNodeVersion(range.replace(/^>=\s*/, "")) : undefined;
  const actual = parseNodeVersion(nodeVersion);
  const label = range ? `Node.js ${range} (${source} engines.node)` : "Node.js requirement declared in package.json";

  if ("corrupt" in engine) {
    return {
      id: "node",
      label,
      status: "fail",
      message: "package.json could not be parsed",
      fix: "Repair package.json so it is valid JSON",
      details: { required: range ?? "(unknown)", actual: nodeVersion || "(unknown)", source: "package.json#engines.node" }
    };
  }

  if (!range) {
    return {
      id: "node",
      label,
      status: "fail",
      message: "package.json engines.node is missing",
      fix: "Declare engines.node in package.json using a >= semver range",
      details: { required: "(missing)", actual: nodeVersion || "(unknown)", source: "package.json#engines.node" }
    };
  }
  if (!minimum) {
    return {
      id: "node",
      label,
      status: "fail",
      message: `Unsupported engines.node range: ${range}`,
      fix: "Use a >= semver range in package.json engines.node",
      details: { required: range, actual: nodeVersion || "(unknown)", source: `${source}#engines.node` }
    };
  }
  const supported = actual !== undefined && meetsMinimumVersion(actual, minimum);
  return {
    id: "node",
    label,
    status: supported ? "pass" : "fail",
    message: nodeVersion
      ? supported
        ? `Node.js ${nodeVersion} satisfies ${source} engines.node ${range}`
        : `Node.js ${nodeVersion} does not satisfy ${source} engines.node ${range}`
      : "Node.js version unknown",
    fix: `Install Node.js ${range} from https://nodejs.org/`,
    details: { required: range, actual: nodeVersion || "(unknown)", source: `${source}#engines.node` }
  };
}

type PackageManagerPin =
  | { raw: string; name: "npm"; version: string }
  | { raw: string; name: "unsupported"; version: string };

function readPackageManagerPin(root: string): PackageManagerPin | undefined {
  const repository = readRepositoryPackage(root);
  if (repository.corrupt || typeof repository.packageJson?.packageManager !== "string") return undefined;
  const raw = repository.packageJson.packageManager.trim();
  const match = /^npm@(.+)$/.exec(raw);
  return match
    ? { raw, name: "npm", version: match[1]! }
    : { raw, name: "unsupported", version: raw.split("@", 2)[1] ?? "" };
}

function exactVersionMatches(expected: string, actual: string): boolean {
  const expectedVersion = parseVersion(expected);
  const actualVersion = parseVersion(actual);
  return expectedVersion !== undefined && actualVersion !== undefined
    ? expectedVersion.every((value, index) => value === actualVersion[index])
    : expected.trim() === actual.trim();
}

function packageManagerInstallStep(root: string): DoctorFixStep {
  const pin = readPackageManagerPin(root);
  return pin?.name === "npm"
    ? { command: "corepack", args: ["npm", "install"], cwd: "." }
    : { command: "npm", args: ["install"], cwd: "." };
}

function packageManagerInstallCommand(root: string): string {
  const step = packageManagerInstallStep(root);
  return `${step.command} ${step.args.join(" ")}`;
}

function npmDiagnostic(root: string, npmVersion: string): DoctorDiagnostic {
  const repository = readRepositoryPackage(root);
  const range = typeof repository.packageJson?.engines?.npm === "string" ? repository.packageJson.engines.npm : undefined;
  const details = {
    required: range ?? "(not declared)",
    actual: npmVersion || "(unknown)",
    source: range ? "package.json#engines.npm" : "npm --version"
  };
  if (repository.corrupt) {
    return {
      id: "npm",
      label: "npm available",
      status: "fail",
      message: "package.json could not be parsed",
      fix: "Repair package.json so it is valid JSON",
      details
    };
  }
  if (!npmVersion) {
    return {
      id: "npm",
      label: range ? `npm ${range} (package.json engines.npm)` : "npm available",
      status: "fail",
      message: "npm not found in PATH",
      fix: "Install Node.js (bundles npm) from https://nodejs.org/",
      details
    };
  }
  if (!range) {
    return {
      id: "npm",
      label: "npm available",
      status: "pass",
      message: `npm ${npmVersion}`,
      fix: "Declare engines.npm in package.json to enforce a minimum npm version",
      details
    };
  }
  const minimum = parseMinimumVersion(range);
  const actual = parseVersion(npmVersion);
  if (!minimum) {
    return {
      id: "npm",
      label: `npm ${range} (package.json engines.npm)`,
      status: "fail",
      message: `Unsupported engines.npm range: ${range}`,
      fix: "Use a >= semver range in package.json engines.npm",
      details
    };
  }
  const supported = actual !== undefined && meetsMinimumVersion(actual, minimum);
  return {
    id: "npm",
    label: `npm ${range} (package.json engines.npm)`,
    status: supported ? "pass" : "fail",
    message: supported
      ? `npm ${npmVersion} satisfies package.json engines.npm ${range}`
      : `npm ${npmVersion} does not satisfy package.json engines.npm ${range}`,
    fix: "Install a compatible npm version through the repository packageManager pin",
    details
  };
}

type CorepackRuntime = { available: boolean; version: string; npmVersion: string };

function corepackRuntime(runtime: EnvironmentRuntime, resolvePinnedNpm: boolean): CorepackRuntime {
  if (runtime.corepackAvailable !== undefined) {
    return {
      available: runtime.corepackAvailable,
      version: runtime.corepackVersion ?? (runtime.corepackAvailable ? "test runtime" : "(unavailable)"),
      npmVersion: runtime.corepackNpmVersion ?? ""
    };
  }
  const version = runShellVersion("corepack", ["--version"]);
  return {
    available: Boolean(version),
    version: version || "(unavailable)",
    npmVersion: version && resolvePinnedNpm ? runShellVersion("corepack", ["npm", "--version"]) : ""
  };
}

function corepackDiagnostic(corepack: CorepackRuntime): DoctorDiagnostic {
  return {
    id: "corepack",
    label: "Corepack available",
    status: corepack.available ? "pass" : "fail",
    message: corepack.available ? `Corepack ${corepack.version}` : "Corepack is unavailable or disabled",
    fix: "Run: corepack enable",
    details: { required: "available", actual: corepack.version, source: "corepack --version" }
  };
}

function packageManagerDiagnostic(root: string, corepack: CorepackRuntime): DoctorDiagnostic {
  const repository = readRepositoryPackage(root);
  const raw = typeof repository.packageJson?.packageManager === "string" ? repository.packageJson.packageManager.trim() : "";
  const pin = readPackageManagerPin(root);
  const details = {
    required: raw || "(not declared)",
    actual: corepack.npmVersion || "(unknown)",
    source: "package.json#packageManager via corepack npm --version"
  };
  if (repository.corrupt) {
    return {
      id: "packageManager",
      label: "packageManager pin",
      status: "fail",
      message: "package.json could not be parsed",
      fix: "Repair package.json so it is valid JSON",
      details
    };
  }
  if (!raw) {
    return {
      id: "packageManager",
      label: "packageManager pin",
      status: "pass",
      message: "packageManager is not declared; pin verification skipped",
      fix: "Declare packageManager in package.json for reproducible installs",
      details
    };
  }
  if (!pin || pin.name === "unsupported") {
    return {
      id: "packageManager",
      label: `packageManager ${raw}`,
      status: "fail",
      message: `Unsupported packageManager declaration: ${raw}; this repository supports npm pins only`,
      fix: "Declare packageManager as npm@<exact-version>",
      details
    };
  }
  const matches = corepack.available && exactVersionMatches(pin.version, corepack.npmVersion);
  return {
    id: "packageManager",
    label: `packageManager ${raw}`,
    status: matches ? "pass" : "fail",
    message: matches
      ? `Corepack resolved npm ${corepack.npmVersion}, matching ${raw}`
      : corepack.available
        ? `Corepack resolved npm ${corepack.npmVersion || "(unknown)"}, expected ${raw}`
        : `Cannot verify ${raw} because Corepack is unavailable or disabled`,
    fix: "Run: corepack enable, then verify with corepack npm --version",
    details
  };
}

function dependencyGraphDiagnostic(root: string, runtime: EnvironmentRuntime): DoctorDiagnostic {
  const repository = readRepositoryPackage(root);
  const workspaces = repository.packageJson?.workspaces;
  const hasWorkspaces = Array.isArray(workspaces) ? workspaces.length > 0 : Boolean(workspaces && typeof workspaces === "object");
  if (repository.corrupt) {
    return {
      id: "dependencies.graph",
      label: "workspace dependency graph",
      status: "fail",
      message: "package.json could not be parsed",
      fix: "Repair package.json so it is valid JSON",
      details: { required: "npm ls --workspaces --depth=0", actual: "(unknown)", source: "package.json#workspaces" }
    };
  }
  if (!hasWorkspaces) {
    return {
      id: "dependencies.graph",
      label: "workspace dependency graph",
      status: "pass",
      message: "No workspaces declared; graph check skipped",
      fix: packageManagerInstallCommand(root),
      details: { required: "(workspaces not declared)", actual: "(not applicable)", source: "package.json#workspaces" }
    };
  }
  const pin = readPackageManagerPin(root);
  const graphCommand = pin?.name === "npm" ? "corepack" : "npm";
  const graphArgs = pin?.name === "npm" ? ["npm", "ls", "--workspaces", "--depth=0"] : ["ls", "--workspaces", "--depth=0"];
  const graphSource = `${graphCommand} ${graphArgs.join(" ")}`;
  const result = runtime.dependencyGraphStatus === undefined
    ? runCommand(graphCommand, graphArgs, root)
    : { status: runtime.dependencyGraphStatus, stdout: runtime.dependencyGraphOutput ?? "", stderr: "" };
  const output = result.stdout || result.stderr;
  return {
    id: "dependencies.graph",
    label: "workspace dependency graph",
    status: result.status === 0 ? "pass" : "fail",
    message: result.status === 0 ? "npm workspace dependency graph is healthy" : output || `npm ls exited with status ${result.status}`,
    fix: packageManagerInstallCommand(root),
    details: { required: "npm ls --workspaces --depth=0", actual: result.status === 0 ? "healthy" : "failed", source: graphSource }
  };
}

export function collectEnvironmentDiagnostics(root: string, runtime: EnvironmentRuntime = {}): DoctorDiagnostic[] {
  const diagnostics: DoctorDiagnostic[] = [];

  const nodeVersion = runtime.nodeVersion ?? process.versions.node ?? "";
  diagnostics.push(nodeEngineDiagnostic(root, nodeVersion));

  const npmVersion = runtime.npmVersion ?? runShellVersion("npm", ["--version"]);
  diagnostics.push(npmDiagnostic(root, npmVersion));

  const repositoryPackage = readRepositoryPackage(root);
  const hasPackageManagerPin = typeof repositoryPackage.packageJson?.packageManager === "string"
    && repositoryPackage.packageJson.packageManager.trim().length > 0;
  const corepack = corepackRuntime(runtime, hasPackageManagerPin);
  diagnostics.push(corepackDiagnostic(corepack));
  diagnostics.push(packageManagerDiagnostic(root, corepack));

  const gitVersion = runShellVersion("git", ["--version"]);
  diagnostics.push({
    id: "git",
    label: "git available",
    status: gitVersion ? "pass" : "fail",
    message: gitVersion || "git not found in PATH",
    fix: "Install git from https://git-scm.com/"
  });

  const rootNm = resolveFrom(root, "node_modules");
  diagnostics.push({
    id: "root.node_modules",
    label: "root dependencies installed",
    status: existsSync(rootNm) ? "pass" : "fail",
    message: existsSync(rootNm) ? "node_modules present" : "node_modules is missing",
    fix: `Run: ${packageManagerInstallCommand(root)}`
  });

  const wjsNm = resolveFrom(root, "wjs/node_modules");
  const rootEsbuild = resolveFrom(root, "node_modules/@esbuild");
  const wjsDepsOk = existsSync(wjsNm) || existsSync(rootEsbuild);
  diagnostics.push({
    id: "wjs.node_modules",
    label: "wjs dependencies installed",
    status: wjsDepsOk ? "pass" : "fail",
    message: wjsDepsOk ? "wjs dependencies present" : "wjs dependencies are missing",
    fix: `Run: ${packageManagerInstallCommand(root)}`
  });

  const esbuildPkg = resolveFrom(root, "wjs/node_modules/@esbuild");
  const esbuildOk = existsSync(esbuildPkg) || existsSync(rootEsbuild);
  diagnostics.push({
    id: "wjs.esbuild",
    label: "wjs esbuild resolved",
    status: esbuildOk ? "pass" : "fail",
    message: esbuildOk ? "esbuild present" : "esbuild missing",
    fix: `Run: ${packageManagerInstallCommand(root)}`
  });

  const validatorPath = resolveFrom(root, "wjs/tools/validate.ts");
  diagnostics.push({
    id: "wjs.validator",
    label: "wjs canonical validator available",
    status: existsSync(validatorPath) ? "pass" : "fail",
    message: existsSync(validatorPath) ? "canonical validator present" : "canonical validator is missing",
    fix: "Run: git submodule update --init --recursive wjs"
  });

  const registryPath = resolveFrom(root, "contracts/registry.yaml");
  diagnostics.push({
    id: "contracts.registry",
    label: "contracts/registry.yaml exists",
    status: existsSync(registryPath) ? "pass" : "fail",
    message: existsSync(registryPath) ? "registry.yaml present" : "registry.yaml missing",
    fix: "Run: npm run scwbs -- registry rebuild"
  });

  const wbsPath = resolveFrom(root, "contracts/wbs/project.wbs.json");
  diagnostics.push({
    id: "contracts.wbs",
    label: "contracts/wbs/project.wbs.json exists",
    status: existsSync(wbsPath) ? "pass" : "fail",
    message: existsSync(wbsPath) ? "project.wbs.json present" : "project.wbs.json missing",
    fix: "Run: npm run scwbs -- wbs candidates"
  });

  const schemaPath = resolveFrom(root, "wjs/schema/wbs-json.schema.json");
  diagnostics.push({
    id: "wjs.schema",
    label: "wjs/schema/wbs-json.schema.json exists",
    status: existsSync(schemaPath) ? "pass" : "fail",
    message: existsSync(schemaPath) ? "schema present" : "schema missing",
    fix: "Re-initialize the wjs submodule: git submodule update --init --recursive wjs"
  });

  diagnostics.push(dependencyGraphDiagnostic(root, runtime));

  return diagnostics;
}

export function buildDoctorFixPlan(root: string, diagnostics: DoctorDiagnostic[]): DoctorFixStep[] {
  const installStep = packageManagerInstallStep(root);
  return diagnostics
    .filter((diagnostic) => diagnostic.status === "fail")
    .filter((diagnostic) => ["root.node_modules", "wjs.node_modules", "wjs.esbuild"].includes(diagnostic.id))
    .map(() => ({ ...installStep, args: [...installStep.args] }));
}

export function applyDoctorFixes(root: string, diagnostics: DoctorDiagnostic[]): { id: string; status: "ok" | "fail"; message: string }[] {
  const results: { id: string; status: "ok" | "fail"; message: string }[] = [];
  const fixPlan = buildDoctorFixPlan(root, diagnostics);
  let planIndex = 0;
  for (const diag of diagnostics) {
    if (diag.status !== "fail") continue;
    const recipe = ["root.node_modules", "wjs.node_modules", "wjs.esbuild"].includes(diag.id)
      ? fixPlan[planIndex++]
      : undefined;
    if (!recipe) {
      results.push({ id: diag.id, status: "fail", message: "no safe automated fix available" });
      continue;
    }
    const result = spawnSync(recipe.command, recipe.args, {
      cwd: path.resolve(root, recipe.cwd),
      encoding: "utf8"
    });
    if (result.status === 0) {
      results.push({ id: diag.id, status: "ok", message: `${recipe.command} ${recipe.args.join(" ")} succeeded` });
    } else {
      const stderr = (result.stderr ?? "").trim();
      const stdout = (result.stdout ?? "").trim();
      results.push({
        id: diag.id,
        status: "fail",
        message: stderr || stdout || `${recipe.command} exited with status ${result.status}`
      });
    }
  }
  return results;
}

function suggestedFix(issue: Issue): string {
  if (issue.fixCommand) return issue.fixCommand;
  if (issue.code.startsWith("task.contractLock")) return "scwbs task refresh --task <task-id>";
  if (issue.code === "health.task.contractLock.missing") return "scwbs task lock --task <task-id>";
  if (issue.code === "evidence.missing") return "scwbs evidence collect --task <task-id>";
  if (issue.code.startsWith("registry.") || issue.code === "spec.registry.missing") return "scwbs registry rebuild --check";
  if (issue.code.includes("approval") || issue.code.includes("humanGate")) return "scwbs approval request --task <task-id>";
  if (issue.code.startsWith("health.evidence.git")) return "scwbs evidence collect --task <task-id> --force";
  return "Inspect the reported contract and rerun scwbs check";
}

type DoctorContractIssue = { source: "check" | "health"; issue: Issue };

function doctorIssuePriority(issue: Issue): number {
  if (issue.severity === "error") return 0;
  if (/humanGate|approval/i.test(issue.code)) return 1;
  if (issue.fixCommand) return 2;
  return 3;
}

function groupDoctorContractIssues(contractIssues: DoctorContractIssue[]): DoctorContractIssue[][] {
  const groups = new Map<string, DoctorContractIssue[]>();
  for (const item of contractIssues) {
    const key = `${item.source}:${item.issue.severity}:${item.issue.code}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()].sort((left, right) =>
    doctorIssuePriority(left[0]!.issue) - doctorIssuePriority(right[0]!.issue)
    || left[0]!.issue.code.localeCompare(right[0]!.issue.code)
  );
}

export function buildDoctorReport(root: string, options: DoctorOptions = {}): string {
  const diagnostics = collectEnvironmentDiagnostics(root);
  const envHasFailure = diagnostics.some((d) => d.status === "fail");

  const contractIssues = [
    ...collectCheckIssues(root).map((issue) => ({ source: "check" as const, issue })),
    ...collectHealthIssues(root).map((issue) => ({ source: "health" as const, issue }))
  ];

  const lines: string[] = ["SC-WBS Doctor", ""];

  lines.push("Environment diagnostics:");
  for (const diag of diagnostics) {
    const tag = diag.status === "pass" ? "PASS" : "FAIL";
    lines.push(`  [${tag}] ${diag.label} -- ${diag.message}`);
    if (diag.status === "fail") {
      lines.push(`        Fix: ${diag.fix}`);
    }
  }

  lines.push("");
  if (contractIssues.length === 0) {
    lines.push("Contract and health: OK");
  } else {
    lines.push("Contract and health issues:");
    for (const group of groupDoctorContractIssues(contractIssues)) {
      const { source, issue } = group[0]!;
      const level = issue.severity === "error" ? "High" : "Medium";
      const count = group.length > 1 ? `, count=${group.length}` : "";
      lines.push(`  [${level}] ${issue.code} (${source}${count})`);
      lines.push(`        Reason: ${issue.message}`);
      if (group[1]) lines.push(`        Representative: ${group[1].issue.message}`);
      if (group.length > 2) lines.push(`        ... ${group.length - 2} more omitted; run scwbs health --verbose for all health issues`);
      lines.push(`        Suggested fix: ${suggestedFix(issue)}`);
    }
  }

  if (options.fix) {
    lines.push("");
    lines.push("--fix execution:");
    if (!envHasFailure) {
      lines.push("  No safe repair needed.");
    } else {
      const fixResults = applyDoctorFixes(root, diagnostics);
      if (fixResults.length === 0) {
        lines.push("  No automated recipe available for the detected failures.");
      }
      for (const result of fixResults) {
        const label = diagnostics.find((d) => d.id === result.id)?.label ?? result.id;
        const tag = result.status === "ok" ? "OK" : "FAIL";
        lines.push(`  [${tag}] ${label} -- ${result.message}`);
      }
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function runDoctor(root: string, options: DoctorOptions = {}): number {
  try {
    if (options.json) {
      const diagnostics = collectEnvironmentDiagnostics(root);
      const contractIssues = [
        ...collectCheckIssues(root).map((issue) => ({ source: "check" as const, issue })),
        ...collectHealthIssues(root).map((issue) => ({ source: "health" as const, issue }))
      ];
      const envHasFailure = diagnostics.some((d) => d.status === "fail");
      const hasContractErrors = contractIssues.some(({ issue }) => issue.severity === "error");
      const output: DoctorJsonOutput = {
        status: envHasFailure || hasContractErrors ? "fail" : "pass",
        diagnostics,
        contractIssues,
        fixResults: options.fix ? applyDoctorFixes(root, diagnostics) : undefined
      };
      console.log(JSON.stringify(output, null, 2));
      return envHasFailure || hasContractErrors ? 1 : 0;
    }
    process.stdout.write(buildDoctorReport(root, options));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
