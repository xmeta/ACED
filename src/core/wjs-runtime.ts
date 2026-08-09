import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type WjsRuntime = {
  kind: "bundled" | "submodule";
  root: string;
  validator: string;
  apply: string;
  wbsSchema: string;
  operationsSchema: string;
};

export type WjsRuntimePurpose = "validate" | "apply";

function runtimeFromRoot(kind: WjsRuntime["kind"], root: string, purpose: WjsRuntimePurpose): WjsRuntime | undefined {
  const extension = kind === "bundled" ? ".mjs" : ".ts";
  const validator = path.join(root, `tools/validate${extension}`);
  const apply = path.join(root, `tools/apply${extension}`);
  const schemaRoot = kind === "bundled" ? path.join(root, "schema") : path.join(root, "schema");
  const wbsSchema = path.join(schemaRoot, "wbs-json.schema.json");
  const operationsSchema = path.join(schemaRoot, "wbs-operations.schema.json");
  const required = [purpose === "validate" ? validator : apply];
  if (kind === "bundled") required.push(wbsSchema, operationsSchema);
  if (!required.every(existsSync)) return undefined;
  return { kind, root, validator, apply, wbsSchema, operationsSchema };
}

export function resolveWjsRuntime(projectRoot: string, purpose: WjsRuntimePurpose = "validate"): WjsRuntime | undefined {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const bundled = runtimeFromRoot("bundled", path.resolve(moduleDirectory, "../wjs-runtime"), purpose);
  if (bundled) return bundled;

  return runtimeFromRoot("submodule", path.resolve(projectRoot, "wjs"), purpose);
}

export function wjsRepairCommand(runtime?: WjsRuntime): string {
  return runtime?.kind === "bundled"
    ? "Reinstall the scwbs package so its bundled WJS runtime is restored"
    : "Run: git submodule update --init --recursive wjs";
}
