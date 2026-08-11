import { infoPack, installPack, inspectPack, listPacks, removePack, searchPacks, updatePack } from "../core/packs.js";

type PackOutputOptions = { json?: boolean };
type PackSourceOptions = PackOutputOptions & { source?: string; ref?: string; dryRun?: boolean; pin?: boolean };

function printResult(result: Record<string, unknown>, json: boolean | undefined): number {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

function run(action: () => Record<string, unknown>, json: boolean | undefined): number {
  try {
    return printResult(action(), json);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function runPackInspect(root: string, source: string, options: PackSourceOptions = {}): number {
  return run(() => inspectPack(root, source, options.ref), options.json);
}

export function runPackList(root: string, options: PackOutputOptions = {}): number {
  return run(() => listPacks(root), options.json);
}

export function runPackSearch(root: string, term: string, options: PackOutputOptions = {}): number {
  return run(() => searchPacks(root, term), options.json);
}

export function runPackInfo(root: string, id: string, options: PackOutputOptions = {}): number {
  return run(() => infoPack(root, id), options.json);
}

export function runPackInstall(root: string, source: string, options: PackSourceOptions = {}): number {
  return run(() => installPack(root, source, options), options.json);
}

export function runPackUpdate(root: string, id: string, options: PackSourceOptions = {}): number {
  return run(() => updatePack(root, id, options), options.json);
}

export function runPackRemove(root: string, id: string, options: PackOutputOptions & { dryRun?: boolean } = {}): number {
  return run(() => removePack(root, id, options), options.json);
}
