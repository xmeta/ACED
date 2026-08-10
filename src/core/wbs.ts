import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFile } from "./json.js";
import { defaultWbsPath, resolveFrom } from "./paths.js";
import { asWbsDocument, validateWbsShape } from "./schema.js";
import { classifyDecisionReadiness } from "./discovery.js";
import type { Issue, WbsDocument, WbsNode } from "./types.js";

export type WjsRuntime = {
  kind: "bundled" | "submodule";
  root: string;
  validator: string;
  apply: string;
  wbsSchema: string;
  operationsSchema: string;
};

type WjsRuntimePurpose = "validate" | "apply";

function runtimeFromRoot(kind: WjsRuntime["kind"], root: string, purpose: WjsRuntimePurpose): WjsRuntime | undefined {
  const extension = kind === "bundled" ? ".mjs" : ".ts";
  const validator = path.join(root, `tools/validate${extension}`);
  const apply = path.join(root, `tools/apply${extension}`);
  const schemaRoot = path.join(root, "schema");
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

export function readWbs(root: string, relativePath = defaultWbsPath): WbsDocument {
  return readJsonFile<WbsDocument>(resolveFrom(root, relativePath));
}

export function findNode(wbs: WbsDocument, nodeId: string): WbsNode | undefined {
  return wbs.nodes.find((node) => node.id === nodeId);
}

export function isDoneNode(node: WbsNode): boolean {
  const scwbs = node.extensions?.scwbs;
  const scwbsStatus = typeof scwbs === "object" && scwbs !== null ? (scwbs as Record<string, unknown>).status : undefined;
  return node.status === "completed" || scwbsStatus === "Done";
}

export function validateWbsDocument(root: string, relativePath = defaultWbsPath): Issue[] {
  const fullPath = resolveFrom(root, relativePath);
  if (!existsSync(fullPath)) {
    return [{ severity: "error", code: "wbs.missing", message: `${relativePath} does not exist` }];
  }

  const document = readJsonFile<unknown>(fullPath);
  const issues = validateWbsShape(document);
  if (issues.length > 0) return issues;

  const wbs = asWbsDocument(document);
  const nodeIds = new Set<string>();
  const nodeCodes = new Set<string>();
  let rootCount = 0;

  for (const node of wbs.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({ severity: "error", code: "wbs.node.duplicate", message: `duplicate node id: ${node.id}` });
    }
    nodeIds.add(node.id);

    if (node.code) {
      if (nodeCodes.has(node.code)) {
        issues.push({ severity: "error", code: "wbs.code.duplicate", message: `duplicate WBS code: ${node.code}` });
      }
      nodeCodes.add(node.code);
    }

    if (node.status === "completed" && node.progressPercent !== undefined && node.progressPercent < 100) {
      issues.push({
        severity: "error",
        code: "wbs.status.progress.mismatch",
        message: `node ${node.id} status is completed but progressPercent is ${node.progressPercent}%`
      });
    }
    if (node.status !== "completed" && node.progressPercent === 100) {
      issues.push({
        severity: "error",
        code: "wbs.status.progress.mismatch",
        message: `node ${node.id} progressPercent is 100% but status is ${node.status}`
      });
    }

    if (node.workMode === "discovery" && node.discovery) {
      const expected = classifyDecisionReadiness(
        node.discovery.exitConditionsMet,
        node.discovery.openUnknowns,
        node.discovery.blockingUnknowns
      );
      if (expected !== node.discovery.decisionReadiness) {
        issues.push({
          severity: "error",
          code: "wbs.discovery.readiness.mismatch",
          message: `node ${node.id} discovery decisionReadiness is ${node.discovery.decisionReadiness}, expected ${expected}`
        });
      }
    }

    if (node.parentId === null) rootCount += 1;
  }

  if (!nodeIds.has(wbs.rootId)) {
    issues.push({ severity: "error", code: "wbs.rootId", message: `rootId does not reference an existing node: ${wbs.rootId}` });
  }
  if (rootCount !== 1) {
    issues.push({ severity: "error", code: "wbs.root", message: `WBS must have exactly one root node, found ${rootCount}` });
  }
  const rootNode = wbs.nodes.find((node) => node.parentId === null);
  if (rootNode && rootNode.id !== wbs.rootId) {
    issues.push({ severity: "error", code: "wbs.root", message: `root node ${rootNode.id} must match rootId ${wbs.rootId}` });
  }
  for (const node of wbs.nodes) {
    if (node.parentId !== null) {
      if (!nodeIds.has(node.parentId)) {
        issues.push({ severity: "error", code: "wbs.parent", message: `node ${node.id} parentId does not exist: ${node.parentId}` });
      } else {
        const parent = wbs.nodes.find((n) => n.id === node.parentId);
        if (parent && parent.status === "completed" && node.status !== "completed") {
          issues.push({
            severity: "error",
            code: "wbs.hierarchy.incomplete_child",
            message: `parent node ${parent.id} is completed but child node ${node.id} is ${node.status}`
          });
        }
      }
    }
  }

  const artifactIds = new Set((wbs.artifacts ?? []).map((artifact) => artifact.id));
  for (const node of wbs.nodes) {
    for (const output of node.outputs ?? []) {
      if (!artifactIds.has(output)) {
        issues.push({ severity: "error", code: "wbs.output", message: `node ${node.id} output references missing artifact: ${output}` });
      }
    }
  }

  return issues;
}

function wjsValidatorUnavailable(kind: "wbs" | "operations", target: string, reason: string, runtime?: WjsRuntime): Issue {
  return {
    severity: "error",
    code: "wjs.validator.unavailable",
    message: `canonical WJS ${kind} validator is unavailable for ${target}: ${reason}`,
    fixCommand: runtime?.kind === "bundled"
      ? "Reinstall the scwbs package so its bundled WJS runtime is restored"
      : "git submodule update --init --recursive wjs"
  };
}

function isWjsRuntimeUnavailable(result: { error?: Error; stderr?: string; stdout?: string }): boolean {
  const output = `${result.error?.message ?? ""}\n${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  return /ENOENT|ERR_NO_TYPESCRIPT|ERR_UNKNOWN_FILE_EXTENSION|MODULE_NOT_FOUND|Cannot find (?:module|package)/i.test(output);
}

export function runWjsValidate(root: string, relativePath = defaultWbsPath, kind: "wbs" | "operations" = "wbs"): Issue[] {
  const runtime = resolveWjsRuntime(root);
  const target = resolveFrom(root, relativePath);
  if (!runtime) {
    return kind === "operations"
      ? [wjsValidatorUnavailable(kind, relativePath, "bundled runtime and wjs submodule are missing")]
      : validateWbsDocument(root, relativePath);
  }

  const result = runtime.kind === "bundled"
    ? spawnSync(process.execPath, ["--experimental-strip-types", runtime.validator, `--${kind}`, target], { cwd: runtime.root, encoding: "utf8" })
    : runSubmoduleValidator(runtime, kind, target);
  if (result.status !== 0 && isWjsRuntimeUnavailable(result)) {
    return kind === "operations"
      ? [wjsValidatorUnavailable(kind, relativePath, "validator runtime or dependencies could not be executed", runtime)]
      : validateWbsDocument(root, relativePath);
  }

  if (result.status === 0) return [];
  const lines = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    return [{ severity: "error", code: "wjs.validate", message: `${relativePath} failed WJS ${kind} validation` }];
  }
  return lines.map((line) => ({ severity: "error", code: "wjs.validate", message: line }));
}

type MergeRecord = Record<string, unknown>;
type MergeCollection = "nodes" | "relations" | "resources" | "artifacts";

export type WbsMergeConflict = {
  class: string;
  identity: string;
  path: string;
  message: string;
  base?: unknown;
  ours?: unknown;
  theirs?: unknown;
};

export type WbsMergePlan = {
  version: "scwbs.wbs-merge-plan.v1";
  status: "clean" | "conflicted";
  autoMergeableOperations: Array<Record<string, unknown>>;
  conflicts: WbsMergeConflict[];
  warnings: string[];
};

const mergeCollections: Array<{ key: MergeCollection; kind: string }> = [
  { key: "nodes", kind: "node" },
  { key: "relations", kind: "relation" },
  { key: "resources", kind: "resource" },
  { key: "artifacts", kind: "artifact" }
];

function mergeClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mergeCanonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as MergeRecord)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, mergeCanonical(item)])
    );
  }
  return value;
}

function mergeEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(mergeCanonical(left)) === JSON.stringify(mergeCanonical(right));
}

function mergeItems(document: WbsDocument, key: MergeCollection): MergeRecord[] {
  const items = document[key] as unknown;
  return Array.isArray(items) ? items.filter((item): item is MergeRecord => Boolean(item && typeof item === "object")) : [];
}

function itemMap(items: MergeRecord[]): Map<string, MergeRecord> {
  return new Map(items.filter((item) => typeof item.id === "string").map((item) => [item.id as string, item]));
}

function hasKey(value: MergeRecord | undefined, key: string): boolean {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

function mergeCollection(
  baseItems: MergeRecord[],
  oursItems: MergeRecord[],
  theirsItems: MergeRecord[],
  kind: string
): { items: MergeRecord[]; conflicts: WbsMergeConflict[] } {
  const base = itemMap(baseItems);
  const ours = itemMap(oursItems);
  const theirs = itemMap(theirsItems);
  const ids = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged: MergeRecord[] = [];
  const conflicts: WbsMergeConflict[] = [];

  for (const id of [...ids].sort()) {
    const baseItem = base.get(id);
    const oursItem = ours.get(id);
    const theirsItem = theirs.get(id);
    if (!baseItem) {
      if (oursItem && theirsItem && !mergeEqual(oursItem, theirsItem)) {
        conflicts.push({
          class: `${kind}.id.collision`,
          identity: id,
          path: `${kind}[${id}]`,
          message: `both sides added different values for ${kind} ${id}`,
          ours: mergeClone(oursItem),
          theirs: mergeClone(theirsItem)
        });
        merged.push(mergeClone(oursItem));
      } else if (oursItem || theirsItem) {
        const addedItem = oursItem ?? theirsItem;
        if (addedItem) merged.push(mergeClone(addedItem));
      }
      continue;
    }

    if (!oursItem && !theirsItem) continue;
    if (!oursItem || !theirsItem) {
      const changedSide = oursItem ?? theirsItem;
      if (!changedSide || !mergeEqual(changedSide, baseItem)) {
        conflicts.push({
          class: `${kind}.delete-vs-modify`,
          identity: id,
          path: `${kind}[${id}]`,
          message: `one side deleted ${kind} ${id} while the other modified it`,
          base: mergeClone(baseItem),
          ours: oursItem ? mergeClone(oursItem) : undefined,
          theirs: theirsItem ? mergeClone(theirsItem) : undefined
        });
        merged.push(mergeClone(changedSide ?? baseItem));
      }
      continue;
    }

    const result: MergeRecord = { id };
    const fields = new Set([...Object.keys(baseItem), ...Object.keys(oursItem), ...Object.keys(theirsItem)]);
    for (const field of [...fields].sort()) {
      if (field === "id") continue;
      const basePresent = hasKey(baseItem, field);
      const oursPresent = hasKey(oursItem, field);
      const theirsPresent = hasKey(theirsItem, field);
      const baseValue = baseItem[field];
      const oursValue = oursItem[field];
      const theirsValue = theirsItem[field];
      const oursChanged = basePresent !== oursPresent || !mergeEqual(baseValue, oursValue);
      const theirsChanged = basePresent !== theirsPresent || !mergeEqual(baseValue, theirsValue);
      let selectedPresent = basePresent;
      let selectedValue = baseValue;

      if (!oursChanged && theirsChanged) {
        selectedPresent = theirsPresent;
        selectedValue = theirsValue;
      } else if (oursChanged && !theirsChanged) {
        selectedPresent = oursPresent;
        selectedValue = oursValue;
      } else if (oursChanged && theirsChanged) {
        if (oursPresent === theirsPresent && mergeEqual(oursValue, theirsValue)) {
          selectedPresent = oursPresent;
          selectedValue = oursValue;
        } else {
          conflicts.push({
            class: `${kind}.field.concurrent-edit`,
            identity: id,
            path: `${kind}[${id}].${field}`,
            message: `both sides changed ${kind} ${id} field ${field} differently`,
            base: basePresent ? mergeClone(baseValue) : undefined,
            ours: oursPresent ? mergeClone(oursValue) : undefined,
            theirs: theirsPresent ? mergeClone(theirsValue) : undefined
          });
          selectedPresent = oursPresent;
          selectedValue = oursValue;
        }
      }

      if (selectedPresent) result[field] = mergeClone(selectedValue);
    }
    merged.push(result);
  }

  return { items: merged.sort((left, right) => String(left.id).localeCompare(String(right.id))), conflicts };
}

function mergeExtensions(
  base: Record<string, unknown> | undefined,
  ours: Record<string, unknown> | undefined,
  theirs: Record<string, unknown> | undefined
): { value: Record<string, unknown>; conflicts: WbsMergeConflict[] } {
  const baseValue = base ?? {};
  const oursValue = ours ?? {};
  const theirsValue = theirs ?? {};
  const namespaces = new Set([...Object.keys(baseValue), ...Object.keys(oursValue), ...Object.keys(theirsValue)]);
  const result: Record<string, unknown> = {};
  const conflicts: WbsMergeConflict[] = [];
  for (const namespace of [...namespaces].sort()) {
    const basePresent = Object.prototype.hasOwnProperty.call(baseValue, namespace);
    const oursPresent = Object.prototype.hasOwnProperty.call(oursValue, namespace);
    const theirsPresent = Object.prototype.hasOwnProperty.call(theirsValue, namespace);
    const oursChanged = basePresent !== oursPresent || !mergeEqual(baseValue[namespace], oursValue[namespace]);
    const theirsChanged = basePresent !== theirsPresent || !mergeEqual(baseValue[namespace], theirsValue[namespace]);
    let present = basePresent;
    let value = baseValue[namespace];
    if (!oursChanged && theirsChanged) {
      present = theirsPresent;
      value = theirsValue[namespace];
    } else if (oursChanged && !theirsChanged) {
      present = oursPresent;
      value = oursValue[namespace];
    } else if (oursChanged && theirsChanged) {
      if (oursPresent === theirsPresent && mergeEqual(oursValue[namespace], theirsValue[namespace])) {
        present = oursPresent;
        value = oursValue[namespace];
      } else {
        conflicts.push({
          class: "extension.concurrent-edit",
          identity: namespace,
          path: `extensions.${namespace}`,
          message: `both sides changed extension namespace ${namespace} differently`,
          base: basePresent ? mergeClone(baseValue[namespace]) : undefined,
          ours: oursPresent ? mergeClone(oursValue[namespace]) : undefined,
          theirs: theirsPresent ? mergeClone(theirsValue[namespace]) : undefined
        });
        present = oursPresent;
        value = oursValue[namespace];
      }
    }
    if (!present) {
      if (basePresent) {
        conflicts.push({
          class: "extension.delete-unsupported",
          identity: namespace,
          path: `extensions.${namespace}`,
          message: `deleting extension namespace ${namespace} cannot be represented by the current WJS operation contract`
        });
      }
    } else result[namespace] = mergeClone(value);
  }
  return { value: result, conflicts };
}

function mergeConflict(
  conflicts: WbsMergeConflict[],
  item: Omit<WbsMergeConflict, "identity" | "path" | "message"> & { identity: string; path: string; message: string }
): void {
  conflicts.push(item);
}

function mergePatch(base: MergeRecord, next: MergeRecord): MergeRecord {
  const patch: MergeRecord = {};
  for (const key of Object.keys(next).sort()) {
    if (key === "id" || key === "parentId") continue;
    if (!mergeEqual(base[key], next[key]) || hasKey(base, key) !== hasKey(next, key)) patch[key] = mergeClone(next[key]);
  }
  return patch;
}

function mergeOperations(base: WbsDocument, merged: WbsDocument): Array<Record<string, unknown>> {
  const operations: Array<Record<string, unknown>> = [];
  const addOperation = (operation: Record<string, unknown>): void => {
    operations.push({ operationId: `merge-${String(operations.length + 1).padStart(3, "0")}`, ...operation });
  };

  for (const descriptor of mergeCollections) {
    const before = itemMap(mergeItems(base, descriptor.key));
    const after = itemMap(mergeItems(merged, descriptor.key));
    for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const left = before.get(id);
      const right = after.get(id);
      if (!left && right) {
        addOperation({ operation: `add${descriptor.kind[0].toUpperCase()}${descriptor.kind.slice(1)}`, [descriptor.kind]: mergeClone(right) });
        continue;
      }
      if (left && !right) {
        addOperation({
          operation: `delete${descriptor.kind[0].toUpperCase()}${descriptor.kind.slice(1)}`,
          [`${descriptor.kind}Id`]: id,
          ...(descriptor.kind === "node" ? { deleteMode: "subtree", relationHandling: "failIfReferenced" } : {})
        });
        continue;
      }
      if (!left || !right) continue;
      const changes = mergePatch(left, right);
      if (descriptor.kind === "node" && !mergeEqual(left.parentId, right.parentId)) {
        addOperation({ operation: "moveNode", nodeId: id, newParentId: right.parentId, ...(left.code !== right.code ? { newCode: right.code } : {}) });
        delete changes.code;
      }
      if (Object.keys(changes).length > 0) {
        addOperation({
          operation: `update${descriptor.kind[0].toUpperCase()}${descriptor.kind.slice(1)}`,
          [`${descriptor.kind}Id`]: id,
          changes
        });
      }
    }
  }

  const beforeExtensions = base.extensions ?? {};
  const afterExtensions = merged.extensions ?? {};
  for (const namespace of Object.keys(afterExtensions).sort()) {
    if (!mergeEqual(beforeExtensions[namespace], afterExtensions[namespace])) {
      addOperation({ operation: "setDocumentExtension", namespace, value: mergeClone(afterExtensions[namespace]) });
    }
  }
  return operations;
}

export function buildWbsMergePlan(base: WbsDocument, ours: WbsDocument, theirs: WbsDocument): WbsMergePlan {
  const conflicts: WbsMergeConflict[] = [];
  if (ours.schemaVersion !== base.schemaVersion || theirs.schemaVersion !== base.schemaVersion || ours.schemaVersion !== theirs.schemaVersion) {
    mergeConflict(conflicts, {
      class: "schema.version.mismatch",
      identity: "document",
      path: "schemaVersion",
      message: "base, ours, and theirs must use the same WBS schema version",
      base: base.schemaVersion,
      ours: ours.schemaVersion,
      theirs: theirs.schemaVersion
    });
  }

  const merged = mergeClone(base);
  for (const key of ["id", "name", "description", "rootId", "metadata"] as const) {
    if (!mergeEqual(base[key], ours[key]) || !mergeEqual(base[key], theirs[key])) {
      mergeConflict(conflicts, {
        class: `document.${key}.unsupported-change`,
        identity: "document",
        path: key,
        message: `document field ${key} changed; the first slice only emits collection operations`,
        base: base[key],
        ours: ours[key],
        theirs: theirs[key]
      });
    }
  }

  const extensionMerge = mergeExtensions(base.extensions, ours.extensions, theirs.extensions);
  if (Object.keys(extensionMerge.value).length > 0) merged.extensions = extensionMerge.value;
  else delete merged.extensions;
  conflicts.push(...extensionMerge.conflicts);

  for (const descriptor of mergeCollections) {
    const result = mergeCollection(mergeItems(base, descriptor.key), mergeItems(ours, descriptor.key), mergeItems(theirs, descriptor.key), descriptor.kind);
    if (result.items.length > 0) (merged[descriptor.key] as unknown) = result.items;
    else delete merged[descriptor.key];
    conflicts.push(...result.conflicts);
  }

  const identityIds = new Set([
    ...mergeItems(merged, "nodes").map((item) => item.id),
    ...mergeItems(merged, "relations").map((item) => item.id),
    ...mergeItems(merged, "resources").map((item) => item.id),
    ...mergeItems(merged, "artifacts").map((item) => item.id)
  ]);
  for (const relation of mergeItems(merged, "relations")) {
    for (const endpoint of ["source", "target"] as const) {
      const endpointValue = relation[endpoint];
      const externalEndpoint = typeof endpointValue === "string" && /^(?:req|issue|requirement):/.test(endpointValue);
      if (typeof endpointValue === "string" && !identityIds.has(endpointValue) && !externalEndpoint) {
        conflicts.push({
          class: "relation.endpoint.missing",
          identity: String(relation.id),
          path: `relation[${String(relation.id)}].${endpoint}`,
          message: `relation endpoint ${String(endpointValue)} does not exist in the merged identity set`
        });
      }
    }
  }
  const codes = new Map<string, string>();
  for (const node of mergeItems(merged, "nodes")) {
    if (typeof node.code !== "string") continue;
    const previous = codes.get(node.code);
    if (previous && previous !== node.id) {
      conflicts.push({
        class: "node.code.duplicate",
        identity: node.code,
        path: `nodes.code.${node.code}`,
        message: `nodes ${previous} and ${String(node.id)} use duplicate code ${node.code}`
      });
    } else codes.set(node.code, String(node.id));
  }

  conflicts.sort((left, right) => `${left.class}:${left.path}`.localeCompare(`${right.class}:${right.path}`));
  const status = conflicts.length === 0 ? "clean" : "conflicted";
  return {
    version: "scwbs.wbs-merge-plan.v1",
    status,
    autoMergeableOperations: status === "clean" ? mergeOperations(base, merged) : [],
    conflicts,
    warnings: status === "clean" ? [] : ["Conflicts are not auto-resolved; review and produce a new explicit changeset after human decision."]
  };
}

export function buildWbsMergeChangeset(plan: WbsMergePlan, targetWbsId: string): Record<string, unknown> {
  if (plan.status !== "clean") throw new Error("Cannot generate a changeset from a conflicted WBS merge plan");
  return {
    schemaVersion: "0.1.0",
    targetWbsId,
    changeSetId: `changeset-wbs-merge-plan-${targetWbsId}`,
    author: "scwbs-cli",
    reason: "Explicit changeset generated from a clean read-only three-way WBS merge plan. Review before applying.",
    dryRun: true,
    operations: plan.autoMergeableOperations
  };
}

function runSubmoduleValidator(runtime: WjsRuntime, kind: "wbs" | "operations", target: string) {
  let result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "validate", "--", `--${kind}`, target], {
    cwd: runtime.root,
    encoding: "utf8"
  });
  if (result.status !== 0 && /missing script: validate/i.test(result.stderr ?? "")) {
    result = spawnSync(process.execPath, ["--experimental-strip-types", runtime.validator, `--${kind}`, target], {
      cwd: runtime.root,
      encoding: "utf8"
    });
  }
  return result;
}
