#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wjsRoot = path.join(root, "wjs");
const outputRoot = path.join(root, "dist", "wjs-runtime");
const require = createRequire(import.meta.url);

function rebuildCleanDist() {
  rmSync(path.join(root, "dist"), { recursive: true, force: true });
  const tsc = process.platform === "win32"
    ? path.join(root, "node_modules", ".bin", "tsc.cmd")
    : path.join(root, "node_modules", ".bin", "tsc");
  const result = spawnSync(tsc, ["-p", "tsconfig.json"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) throw new Error(`clean package build failed with status ${result.status ?? 1}`);
  for (const generatedOnlyModule of ["dist/core/schema/index.js", "dist/core/types.js"]) {
    rmSync(path.join(root, generatedOnlyModule), { force: true });
  }
}

function resolveEsbuild() {
  return require(require.resolve("esbuild", { paths: [wjsRoot, root] }));
}

function compactSchema(value) {
  if (Array.isArray(value)) return value.map(compactSchema);
  if (!value || typeof value !== "object") return value;
  const omitted = new Set(["$schema", "title", "description", "default"]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !omitted.has(key))
    .map(([key, item]) => [key, compactSchema(item)]));
}

async function buildRuntime() {
  rebuildCleanDist();
  const esbuild = resolveEsbuild();
  const toolsRoot = path.join(wjsRoot, "tools");
  const schemaRoot = path.join(wjsRoot, "schema");
  const outputToolsRoot = path.join(outputRoot, "tools");

  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputToolsRoot, { recursive: true });
  const validateEntry = path.join(toolsRoot, "validate.ts");
  const applyEntry = path.join(toolsRoot, "apply.ts");
  await esbuild.build({
    entryPoints: [validateEntry],
    outfile: path.join(outputToolsRoot, "validate.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: ["ajv", "ajv-formats"],
    minify: true,
    logLevel: "silent"
  });
  await esbuild.build({
    entryPoints: [applyEntry],
    outfile: path.join(outputToolsRoot, "apply.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: ["ajv", "ajv-formats"],
    minify: true,
    plugins: [{
      name: "strip-validator-cli-entrypoint",
      setup(build) {
        build.onLoad({ filter: /[\\/]validate\.ts$/ }, (args) => ({
          contents: readFileSync(args.path, "utf8").replace(
            /\nif \(import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href\) \{\n\x20{2}main\(\);\n\}\s*$/s,
            "\n"
          ),
          loader: "ts"
        }));
      }
    }],
    logLevel: "silent"
  });

  const outputSchemaRoot = path.join(outputRoot, "schema");
  mkdirSync(outputSchemaRoot, { recursive: true });
  for (const filename of ["wbs-json.schema.json", "wbs-operations.schema.json"]) {
    const sourcePath = path.join(schemaRoot, filename);
    const outputPath = path.join(outputSchemaRoot, filename);
    writeFileSync(outputPath, `${JSON.stringify(compactSchema(JSON.parse(readFileSync(sourcePath, "utf8"))))}\n`, "utf8");
  }
}

try {
  await buildRuntime();
  console.error(`bundled WJS runtime into ${path.relative(root, outputRoot)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
