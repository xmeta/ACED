import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { defaultWbsPath, resolveFrom } from "../core/paths.js";
import type { Profile, WbsDocument } from "../core/types.js";
import { readWbs } from "../core/wbs.js";
import { runWbsApply } from "./wbs.js";

function normalizeProfile(value: string): Profile | undefined {
  const lowered = value.toLowerCase();
  if (lowered === "lean") return "Lean";
  if (lowered === "standard") return "Standard";
  if (lowered === "strict") return "Strict";
  return undefined;
}

export function readProfile(root: string): Profile {
  if (!existsSync(resolveFrom(root, defaultWbsPath))) return "Standard";
  const wbs = readWbs(root);
  const scwbs = wbs.extensions?.scwbs;
  const profile = typeof scwbs === "object" && scwbs !== null ? (scwbs as Record<string, unknown>).profile : undefined;
  return profile === "Lean" || profile === "Strict" || profile === "Standard" ? profile : "Standard";
}

export function runProfileShow(root: string): number {
  try {
    console.log(`Profile: ${readProfile(root)}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

type ProfileSetOptions = {
  now?: string;
  apply?: typeof runWbsApply;
};

function profileChangeSetPath(profile: Profile, createdAt: string): string {
  const stamp = createdAt.replace(/[^0-9]/g, "").slice(0, 17);
  return `contracts/changesets/profile-set-${profile.toLowerCase()}-${stamp}.json`;
}

export function buildProfileChangeSet(wbs: WbsDocument, profile: Profile, createdAt: string): Record<string, unknown> {
  const current = typeof wbs.extensions?.scwbs === "object" && wbs.extensions.scwbs !== null
    ? wbs.extensions.scwbs as Record<string, unknown>
    : {};
  return {
    schemaVersion: "0.1.0",
    targetWbsId: wbs.id,
    changeSetId: `changeset-profile-set-${profile.toLowerCase()}-${createdAt}`,
    author: "scwbs",
    createdAt,
    reason: `Set SC-WBS operations profile to ${profile}`,
    dryRun: true,
    operations: [{
      operationId: "op-001",
      operation: "setDocumentExtension",
      namespace: "scwbs",
      value: {
        ...current,
        profile
      }
    }]
  };
}

export function runProfileSet(root: string, value: string, options: ProfileSetOptions = {}): number {
  try {
    const profile = normalizeProfile(value);
    if (!profile) {
      console.error("Profile must be lean, standard, or strict");
      return 2;
    }
    const wbs = readWbs(root);
    const createdAt = options.now ?? new Date().toISOString();
    const changeSetPath = profileChangeSetPath(profile, createdAt);
    const fullChangeSetPath = resolveFrom(root, changeSetPath);
    if (existsSync(fullChangeSetPath)) {
      throw new Error(`${changeSetPath} already exists`);
    }
    mkdirSync(resolveFrom(root, "contracts/changesets"), { recursive: true });
    writeFileSync(fullChangeSetPath, `${JSON.stringify(buildProfileChangeSet(wbs, profile, createdAt), null, 2)}\n`, "utf8");

    const apply = options.apply ?? runWbsApply;
    const applyStatus = apply(root, changeSetPath, { force: true, output: defaultWbsPath });
    if (applyStatus !== 0) {
      console.error(`Profile changeset was not applied; WBS remains unchanged. Review ${changeSetPath}`);
      return applyStatus;
    }

    console.log(`Profile: ${profile}`);
    console.log(`changeset: ${changeSetPath}`);
    console.log("Task locks may be stale; run: npm run scwbs -- task refresh --affected");
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
