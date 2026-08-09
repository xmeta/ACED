import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectCheckIssues } from "./check.js";
import { collectHealthIssues } from "./health.js";
import { resolveFrom } from "../core/paths.js";
import type { Issue } from "../core/types.js";

type EnvironmentRuntime = {
  nodeVersion?: string;
  npmVersion?: string;
};

export type DoctorDiagnostic = {
  id: string;
  label: string;
  status: "pass" | "fail";
  message: string;
  fix: string;
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

const FIX_RECIPES: Record<string, DoctorFixStep> = {
  "root.node_modules": { command: "npm", args: ["install"], cwd: "." },
  "wjs.node_modules": { command: "npm", args: ["install"], cwd: "." },
  "wjs.esbuild": { command: "npm", args: ["install"], cwd: "." }
};

function runShellVersion(command: string, args: string[]): string {
  try {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.status !== 0) return "";
    return (result.stdout ?? "").trim() || (result.stderr ?? "").trim();
  } catch {
    return "";
  }
}

function parseNodeVersion(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function meetsMinimumVersion(actual: [number, number, number], minimum: [number, number, number]): boolean {
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

function readRepoNodeEngine(root: string): { range?: string; missingEngine: boolean; corrupt: boolean } {
  const packagePath = resolveFrom(root, "package.json");
  if (!existsSync(packagePath)) {
    return { missingEngine: false, corrupt: false };
  }
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
      engines?: { node?: unknown };
    };
    return typeof packageJson.engines?.node === "string"
      ? { range: packageJson.engines.node, missingEngine: false, corrupt: false }
      : { missingEngine: true, corrupt: false };
  } catch {
    return { missingEngine: false, corrupt: true };
  }
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
      fix: "Repair package.json so it is valid JSON"
    };
  }

  if (!range) {
    return {
      id: "node",
      label,
      status: "fail",
      message: "package.json engines.node is missing",
      fix: "Declare engines.node in package.json using a >= semver range"
    };
  }
  if (!minimum) {
    return {
      id: "node",
      label,
      status: "fail",
      message: `Unsupported engines.node range: ${range}`,
      fix: "Use a >= semver range in package.json engines.node"
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
    fix: `Install Node.js ${range} from https://nodejs.org/`
  };
}

export function collectEnvironmentDiagnostics(root: string, runtime: EnvironmentRuntime = {}): DoctorDiagnostic[] {
  const diagnostics: DoctorDiagnostic[] = [];

  const nodeVersion = runtime.nodeVersion ?? process.versions.node ?? "";
  diagnostics.push(nodeEngineDiagnostic(root, nodeVersion));

  const npmVersion = runtime.npmVersion ?? runShellVersion("npm", ["--version"]);
  diagnostics.push({
    id: "npm",
    label: "npm available",
    status: npmVersion ? "pass" : "fail",
    message: npmVersion ? `npm ${npmVersion}` : "npm not found in PATH",
    fix: "Install Node.js (bundles npm) from https://nodejs.org/"
  });

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
    fix: "Run: npm install"
  });

  const wjsNm = resolveFrom(root, "wjs/node_modules");
  const rootEsbuild = resolveFrom(root, "node_modules/@esbuild");
  const wjsDepsOk = existsSync(wjsNm) || existsSync(rootEsbuild);
  diagnostics.push({
    id: "wjs.node_modules",
    label: "wjs dependencies installed",
    status: wjsDepsOk ? "pass" : "fail",
    message: wjsDepsOk ? "wjs dependencies present" : "wjs dependencies are missing",
    fix: "Run: npm install"
  });

  const esbuildPkg = resolveFrom(root, "wjs/node_modules/@esbuild");
  const esbuildOk = existsSync(esbuildPkg) || existsSync(rootEsbuild);
  diagnostics.push({
    id: "wjs.esbuild",
    label: "wjs esbuild resolved",
    status: esbuildOk ? "pass" : "fail",
    message: esbuildOk ? "esbuild present" : "esbuild missing",
    fix: "Run: npm install"
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

  return diagnostics;
}

export function applyDoctorFixes(root: string, diagnostics: DoctorDiagnostic[]): { id: string; status: "ok" | "fail"; message: string }[] {
  const results: { id: string; status: "ok" | "fail"; message: string }[] = [];
  for (const diag of diagnostics) {
    if (diag.status !== "fail") continue;
    const recipe = FIX_RECIPES[diag.id];
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
