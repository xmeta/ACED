import { existsSync, writeFileSync } from "node:fs";
import { defaultWbsPath, resolveFrom } from "../core/paths.js";
import type { Profile } from "../core/types.js";
import { readWbs } from "../core/wbs.js";

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

export function runProfileSet(root: string, value: string): number {
  try {
    const profile = normalizeProfile(value);
    if (!profile) {
      console.error("Profile must be lean, standard, or strict");
      return 2;
    }
    const wbs = readWbs(root);
    wbs.extensions = {
      ...(wbs.extensions ?? {}),
      scwbs: {
        ...((typeof wbs.extensions?.scwbs === "object" && wbs.extensions.scwbs !== null ? wbs.extensions.scwbs : {}) as Record<string, unknown>),
        profile
      }
    };
    writeFileSync(resolveFrom(root, defaultWbsPath), `${JSON.stringify(wbs, null, 2)}\n`, "utf8");
    console.log(`Profile: ${profile}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
