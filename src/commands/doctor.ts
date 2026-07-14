import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { collectCheckIssues } from "./check.js";
import { collectHealthIssues } from "./health.js";
import { resolveFrom } from "../core/paths.js";
import type { Issue } from "../core/types.js";

const MIN_NODE_MAJOR = 18;

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

export function collectEnvironmentDiagnostics(root: string): DoctorDiagnostic[] {
  const diagnostics: DoctorDiagnostic[] = [];

  const nodeVersion = process.versions.node ?? "";
  const nodeMajor = Number(nodeVersion.split(".")[0]);
  diagnostics.push({
    id: "node",
    label: `Node.js >= ${MIN_NODE_MAJOR}`,
    status: Number.isFinite(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR ? "pass" : "fail",
    message: nodeVersion ? `Node.js ${nodeVersion}` : "Node.js version unknown",
    fix: `Install Node.js >= ${MIN_NODE_MAJOR} from https://nodejs.org/`
  });

  const npmVersion = runShellVersion("npm", ["--version"]);
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
