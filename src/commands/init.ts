import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultRegistryPath, defaultWbsPath, profileRequiredDirs, resolveFrom } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import type { Agent, Language, Profile, WbsDocument } from "../core/types.js";

function writeIfMissing(root: string, relativePath: string, content: string): boolean {
  const fullPath = resolveFrom(root, relativePath);
  if (existsSync(fullPath)) return false;
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
  return true;
}

export type InitOptions = {
  profile?: string;
  agent?: string;
  lang?: string;
};

function normalizeProfile(value: string | undefined): Profile | undefined {
  if (value === undefined) return "Standard";
  const lowered = value.toLowerCase();
  if (lowered === "lean") return "Lean";
  if (lowered === "standard") return "Standard";
  if (lowered === "strict") return "Strict";
  return undefined;
}

function normalizeAgent(value: string | undefined): Agent | undefined {
  if (value === undefined) return "codex";
  return value.toLowerCase() === "codex" ? "codex" : undefined;
}

function normalizeLanguage(value: string | undefined): Language | undefined {
  if (value === undefined) return "ja";
  const lowered = value.toLowerCase();
  if (lowered === "ja" || lowered === "ja-jp") return "ja";
  if (lowered === "en" || lowered === "en-us") return "en";
  return undefined;
}

export function runInit(root: string, options: InitOptions = {}): number {
  const profile = normalizeProfile(options.profile);
  if (!profile) {
    console.error("Profile must be lean, standard, or strict");
    return 2;
  }
  const agent = normalizeAgent(options.agent);
  if (!agent) {
    console.error("Agent must be codex");
    return 2;
  }
  const lang = normalizeLanguage(options.lang);
  if (!lang) {
    console.error("Language must be ja or en");
    return 2;
  }

  for (const dir of profileRequiredDirs(profile)) {
    mkdirSync(resolveFrom(root, dir), { recursive: true });
  }

  const wbs: WbsDocument = {
    schemaVersion: "0.1.0",
    id: "scwbs-project",
    name: "SC-WBS Project",
    rootId: "node-project",
    nodes: [
      {
        id: "node-project",
        parentId: null,
        code: "1",
        name: "Project",
        type: "deliverable",
        status: "planned",
        progressPercent: 0,
        extensions: {
          scwbs: {
            status: "Not Started"
          }
        }
      }
    ],
    relations: [],
    resources: [
      {
        id: "resource-human",
        name: "Human",
        type: "role"
      },
      {
        id: "resource-ai",
        name: "AI Agent",
        type: "role"
      }
    ],
    artifacts: [],
    metadata: {
      createdBy: "scwbs",
      language: lang === "ja" ? "ja-JP" : "en-US"
    },
    extensions: {
      scwbs: {
        profile,
        agent,
        lang
      }
    }
  };

  const created: string[] = [];
  if (writeIfMissing(root, defaultWbsPath, `${JSON.stringify(wbs, null, 2)}\n`)) created.push(defaultWbsPath);
  if (writeIfMissing(root, defaultRegistryPath, stringifySimpleYaml({ projectId: "scwbs-project", contracts: [] }))) created.push(defaultRegistryPath);

  if (created.length === 0) {
    console.log("scwbs init: nothing to create");
  } else {
    for (const item of created) console.log(`created ${item}`);
  }
  return 0;
}
