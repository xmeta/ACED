import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { defaultWbsPath, resolveFrom } from "../core/paths.js";
import { hasErrors, printIssues } from "../core/report.js";
import { runWjsValidate } from "../core/wbs.js";

export function runWbsValidate(root: string): number {
  const issues = runWjsValidate(root);
  if (issues.length === 0) {
    console.log(`${defaultWbsPath}: OK (wbs)`);
    return 0;
  }
  printIssues(issues);
  return hasErrors(issues) ? 1 : 0;
}

export function runWbsApply(root: string, changeSetPath: string, options: { force: boolean; output?: string }): number {
  const applyTool = path.resolve(root, "wjs/tools/apply.ts");
  if (!existsSync(applyTool)) {
    console.error("wjs/tools/apply.ts does not exist");
    return 1;
  }

  const toolArgs = [applyTool, resolveFrom(root, defaultWbsPath), resolveFrom(root, changeSetPath)];
  if (options.output) toolArgs.push("-o", resolveFrom(root, options.output));
  if (options.force) toolArgs.push("--force");

  let result = spawnSync(process.execPath, ["--experimental-strip-types", ...toolArgs], {
    cwd: path.resolve(root, "wjs"),
    encoding: "utf8"
  });
  if (result.status !== 0 && result.stderr?.includes("ERR_NO_TYPESCRIPT")) {
    result = spawnSync(process.execPath, toolArgs, {
      cwd: path.resolve(root, "wjs"),
      encoding: "utf8"
    });
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
}
