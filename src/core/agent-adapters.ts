import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Agent, Language } from "./types.js";

export const AGENT_ADAPTER_SCHEMA_VERSION = "scwbs.agent-adapter.v1" as const;

export type AgentAdapterStatus = "supported" | "preview" | "deprecated" | "unsupported";

export type AgentAdapterFile = {
  path: string;
  guidance: string;
};

export type AgentAdapter = {
  id: Agent;
  displayName: string;
  version: "1.0.0";
  status: AgentAdapterStatus;
  capabilities: {
    instructions: boolean;
    mcp: boolean;
    localeKeys: string[];
  };
  files: AgentAdapterFile[];
};

export type AgentAdapterDiagnostic = {
  id: Agent;
  status: "ready" | "preview" | "error";
  adapterStatus: AgentAdapterStatus;
  files: Array<{ path: string; safe: boolean; present: boolean }>;
  issues: string[];
};

const commonGuidance = (language: Language): string => {
  const languageLine = language === "ja" ? "Use Japanese for handoffs when practical." : "Use English for handoffs.";
  return `<!-- scwbs; keep customizations separate. -->\n\n# SC-WBS\n\nFollow AGENTS.md and Task Contract.\n${languageLine}\n\n- Stay in allowed paths.\n- Run checks and collect Evidence.\n- Stop for Human Gate or schema, dependency, auth, release decisions.\n`;
};

const adapters: AgentAdapter[] = [
  {
    id: "codex",
    displayName: "OpenAI Codex",
    version: "1.0.0",
    status: "supported",
    capabilities: { instructions: true, mcp: true, localeKeys: ["agent.guidance.common", "agent.guidance.codex"] },
    files: [{ path: "AGENTS.md", guidance: "Use scwbs packet --task <id>." }]
  },
  {
    id: "claude",
    displayName: "Anthropic Claude",
    version: "1.0.0",
    status: "supported",
    capabilities: { instructions: true, mcp: true, localeKeys: ["agent.guidance.common", "agent.guidance.claude"] },
    files: [{ path: ".claude/commands/scwbs.md", guidance: "Use npm run scwbs -- packet --task <id>." }]
  },
  {
    id: "cursor",
    displayName: "Cursor",
    version: "1.0.0",
    status: "supported",
    capabilities: { instructions: true, mcp: true, localeKeys: ["agent.guidance.common", "agent.guidance.cursor"] },
    files: [{ path: ".cursor/rules/scwbs.mdc", guidance: "Use the Task Contract for every edit." }]
  },
  {
    id: "copilot",
    displayName: "GitHub Copilot",
    version: "1.0.0",
    status: "supported",
    capabilities: { instructions: true, mcp: true, localeKeys: ["agent.guidance.common", "agent.guidance.copilot"] },
    files: [{ path: ".github/copilot-instructions.md", guidance: "Use SC-WBS CLI commands through npm." }]
  },
  {
    id: "gemini",
    displayName: "Gemini CLI",
    version: "1.0.0",
    status: "preview",
    capabilities: { instructions: true, mcp: true, localeKeys: ["agent.guidance.common", "agent.guidance.gemini"] },
    files: [{ path: ".gemini/commands/scwbs.md", guidance: "Use npm run scwbs -- packet --task <id>." }]
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    version: "1.0.0",
    status: "preview",
    capabilities: { instructions: true, mcp: true, localeKeys: ["agent.guidance.common", "agent.guidance.opencode"] },
    files: [{ path: ".opencode/commands/scwbs.md", guidance: "Use the Task Contract for every edit." }]
  }
];

export function listAgentAdapters(): AgentAdapter[] {
  return adapters.map((adapter) => ({ ...adapter, capabilities: { ...adapter.capabilities, localeKeys: [...adapter.capabilities.localeKeys] }, files: adapter.files.map((file) => ({ ...file })) }));
}

export function getAgentAdapter(id: string): AgentAdapter | undefined {
  return adapters.find((adapter) => adapter.id === id);
}

export function isAgentId(value: unknown): value is Agent {
  return typeof value === "string" && adapters.some((adapter) => adapter.id === value && ["supported", "preview"].includes(adapter.status));
}

export function agentNames(): string {
  return adapters.filter((adapter) => adapter.status !== "unsupported").map((adapter) => adapter.id).join(", ");
}

export function renderAgentFiles(id: Agent, language: Language): AgentAdapterFile[] {
  const adapter = getAgentAdapter(id);
  if (!adapter || adapter.status === "unsupported") throw new Error(`Unsupported agent adapter: ${id}`);
  const common = commonGuidance(language);
  return adapter.files.map((file) => ({ path: file.path, guidance: `${common}\n${file.guidance}\n` }));
}

export function assertSafeAgentPath(root: string, relativePath: string): string {
  if (relativePath.includes("\0") || relativePath.includes("\\") || path.isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    throw new Error(`Unsafe agent adapter path: ${relativePath}`);
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath || normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new Error(`Unsafe agent adapter path: ${relativePath}`);
  }
  const rootPath = realpathSync(root);
  const target = path.resolve(rootPath, ...normalized.split("/"));
  const relative = path.relative(rootPath, target);
  if (relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Unsafe agent adapter path: ${relativePath}`);
  }
  let current = rootPath;
  for (const segment of normalized.split("/")) {
    current = path.join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`Agent adapter path crosses symlink: ${relativePath}`);
    }
  }
  return target;
}

export function diagnoseAgentAdapters(root: string): AgentAdapterDiagnostic[] {
  return listAgentAdapters().map((adapter) => {
    const issues: string[] = [];
    const files = adapter.files.map((file) => {
      let safe = true;
      try {
        assertSafeAgentPath(root, file.path);
      } catch (error) {
        safe = false;
        issues.push(error instanceof Error ? error.message : String(error));
      }
      return { path: file.path, safe, present: safe && existsSync(path.resolve(root, file.path)) };
    });
    return {
      id: adapter.id,
      status: issues.length > 0 ? "error" : adapter.status === "preview" ? "preview" : "ready",
      adapterStatus: adapter.status,
      files,
      issues
    };
  });
}
