import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultApprovalsDir, defaultEvidenceDir, defaultRegistryPath, defaultTasksDir, defaultWbsPath, resolveFrom } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import type { WbsDocument } from "../core/types.js";

function writeIfMissing(root: string, relativePath: string, content: string): boolean {
  const fullPath = resolveFrom(root, relativePath);
  if (existsSync(fullPath)) return false;
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
  return true;
}

export function runInit(root: string): number {
  for (const dir of [defaultTasksDir, defaultEvidenceDir, defaultApprovalsDir, "contracts/wbs"]) {
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
      language: "ja-JP"
    },
    extensions: {
      scwbs: {
        profile: "Standard"
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
