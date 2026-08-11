import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultRegistryPath, defaultWbsPath, profileRequiredDirs, resolveFrom } from "../core/paths.js";
import { agentNames as supportedAgentNames, assertSafeAgentPath, diagnoseAgentAdapters, getAgentAdapter, isAgentId, listAgentAdapters, renderAgentFiles } from "../core/agent-adapters.js";
import { localeMetadata, normalizeLocaleId, resolveLocale, type LocaleId } from "../core/locales.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import type { Agent, Profile, WbsDocument } from "../core/types.js";

const agentManifestPath = ".scwbs/agent-files.json";
const agentError = `Unknown agent (${supportedAgentNames()})`;
const manifestError = "Invalid agent manifest";

function writeIfMissing(root: string, relativePath: string, content: string): void {
  const fullPath = resolveFrom(root, relativePath);
  if (existsSync(fullPath)) return;
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

export type InitOptions = {
  profile?: string;
  agent?: string;
  lang?: string;
};

export type AgentUpdateOptions = {
  agent?: string;
  dryRun?: boolean;
  json?: boolean;
};

export type AgentOperationOptions = {
  json?: boolean;
};

export type AgentDoctorOptions = {
  all?: boolean;
  json?: boolean;
};

type AgentFile = {
  path: string;
  content: string;
};

type AgentManifestFile = {
  path: string;
  owner: Agent;
  sha256: string;
};

type AgentManifestV1 = {
  schemaVersion: "1";
  agent: Agent;
  files: Array<{ path: string; sha256: string }>;
};

type AgentManifestV2 = {
  schemaVersion: "2";
  primaryAgent: Agent;
  agents: Agent[];
  files: AgentManifestFile[];
};

type AgentManifest = AgentManifestV1 | AgentManifestV2;

type ManifestState = {
  manifest?: AgentManifest;
  version: "none" | "invalid" | "1" | "2";
};

type ScwbsSettings = {
  profile?: Profile;
  agent?: Agent;
  primaryAgent?: Agent;
  agents?: Agent[];
  lang?: LocaleId;
  [key: string]: unknown;
};

type AgentDecisionAction = "create" | "update" | "unchanged" | "preserved" | "divergent" | "migrate" | "remove" | "removed" | "move";

export type AgentDecision = {
  action: AgentDecisionAction;
  agent?: Agent;
  path?: string;
};

function isAgent(value: unknown): value is Agent {
  return isAgentId(value);
}

function uniqueAgents(values: Agent[]): Agent[] {
  return [...new Set(values)];
}

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
  const lowered = value.toLowerCase();
  return isAgent(lowered) ? lowered : undefined;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function agentFiles(agent: Agent, language: LocaleId): AgentFile[] {
  return renderAgentFiles(agent, language).map((file) => ({ path: file.path, content: file.guidance }));
}

function readManifest(root: string): ManifestState {
  const fullPath = resolveFrom(root, agentManifestPath);
  if (!existsSync(fullPath)) return { version: "none" };
  try {
    const parsed = JSON.parse(readFileSync(fullPath, "utf8")) as Record<string, unknown>;
    const files = Array.isArray(parsed.files) ? parsed.files : [];
    const validV1 = files.every((entry) => {
      const candidate = entry as Record<string, unknown>;
      return entry !== null && typeof entry === "object" && typeof candidate.path === "string" && typeof candidate.sha256 === "string";
    });
    if (parsed.schemaVersion === "1" && isAgent(parsed.agent) && validV1) {
      return { version: "1", manifest: { schemaVersion: "1", agent: parsed.agent, files: files as AgentManifestV1["files"] } };
    }
    const agents = Array.isArray(parsed.agents) ? parsed.agents.filter(isAgent) : [];
    const validV2 = files.every((entry) => {
      const candidate = entry as Record<string, unknown>;
      return entry !== null && typeof entry === "object" && typeof candidate.path === "string" && isAgent(candidate.owner) && typeof candidate.sha256 === "string";
    });
    if (parsed.schemaVersion === "2" && isAgent(parsed.primaryAgent) && agents.length === (Array.isArray(parsed.agents) ? parsed.agents.length : 0) && agents.length > 0 && validV2) {
      return { version: "2", manifest: { schemaVersion: "2", primaryAgent: parsed.primaryAgent, agents: uniqueAgents(agents), files: files as AgentManifestV2["files"] } };
    }
    return { version: "invalid" };
  } catch {
    return { version: "invalid" };
  }
}

function asV2(state: ManifestState, agents: Agent[], primaryAgent: Agent): AgentManifestV2 {
  const existing = state.manifest;
  if (!existing) return { schemaVersion: "2", primaryAgent, agents: uniqueAgents(agents), files: [] };
  if (existing.schemaVersion === "1") {
    return {
      schemaVersion: "2",
      primaryAgent,
      agents: uniqueAgents([...agents, existing.agent]),
      files: existing.files.map((file) => ({ ...file, owner: existing.agent }))
    };
  }
  return {
    schemaVersion: "2",
    primaryAgent,
    agents: uniqueAgents([...agents, ...existing.agents]),
    files: existing.files.map((file) => ({ ...file }))
  };
}

function writeManifest(root: string, manifest: AgentManifestV2): void {
  const fullPath = resolveFrom(root, agentManifestPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function project(root: string): { wbs: WbsDocument; settings: ScwbsSettings } | undefined {
  const fullPath = resolveFrom(root, defaultWbsPath);
  if (!existsSync(fullPath)) return undefined;
  try {
    const wbs = JSON.parse(readFileSync(fullPath, "utf8")) as WbsDocument;
    const settings = (wbs.extensions?.scwbs ?? {}) as ScwbsSettings;
    return { wbs, settings };
  } catch {
    return undefined;
  }
}

function agentsFor(settings: ScwbsSettings, manifestState: ManifestState): { agents: Agent[]; primaryAgent: Agent; language: LocaleId } {
  const manifestAgents = manifestState.manifest?.schemaVersion === "1"
    ? [manifestState.manifest.agent]
    : manifestState.manifest?.schemaVersion === "2"
      ? [...manifestState.manifest.agents, manifestState.manifest.primaryAgent]
      : [];
  const configured = [ ...(settings.agents ?? []), settings.agent, settings.primaryAgent, ...manifestAgents ].filter(isAgent);
  const agents = uniqueAgents(configured.length > 0 ? configured : ["codex"]);
  const primaryAgent = [settings.primaryAgent, settings.agent, ...manifestAgents, agents[0]].find(isAgent) ?? agents[0];
  return { agents, primaryAgent: agents.includes(primaryAgent) ? primaryAgent : agents[0], language: resolveLocale(settings.lang).id };
}

function writeSettings(root: string, agents: Agent[], primaryAgent: Agent): void {
  const current = project(root);
  if (!current) throw new Error("Cannot update agent settings: invalid WBS");
  const nextSettings: ScwbsSettings = {
    ...current.settings,
    agent: primaryAgent,
    primaryAgent,
    agents: uniqueAgents(agents)
  };
  const nextWbs: WbsDocument = {
    ...current.wbs,
    extensions: {
      ...(current.wbs.extensions ?? {}),
      scwbs: nextSettings
    }
  };
  writeFileSync(resolveFrom(root, defaultWbsPath), `${JSON.stringify(nextWbs, null, 2)}\n`, "utf8");
}

function output(decisions: AgentDecision[], json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify({ version: "scwbs.agent-operation.v1", decisions }, null, 2));
    return;
  }
  for (const decision of decisions) {
    const target = [decision.agent, decision.path].filter(Boolean).join(" ");
    console.log(`${decision.action} ${target}`.trim());
  }
}

function sync(
  root: string,
  manifest: AgentManifestV2,
  agent: Agent,
  language: LocaleId,
  update: boolean,
  dryRun: boolean
): { manifest: AgentManifestV2; decisions: AgentDecision[] } {
  const next = { ...manifest, agents: [...manifest.agents], files: manifest.files.map((file) => ({ ...file })) };
  const decisions: AgentDecision[] = [];
  const files = agentFiles(agent, language);
  for (const file of files) {
    const fullPath = assertSafeAgentPath(root, file.path);
    const previous = next.files.find((entry) => entry.path === file.path && entry.owner === agent);
    const current = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : undefined;
    if (current === undefined) {
      decisions.push({ action: "create", agent, path: file.path });
      if (!dryRun) {
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, file.content, "utf8");
      }
      if (!previous) {
        next.files.push({ path: file.path, owner: agent, sha256: sha256(file.content) });
      }
      continue;
    }
    if (!previous) {
      decisions.push({ action: "preserved", agent, path: file.path });
      continue;
    }
    const matchesRecorded = sha256(current) === previous.sha256;
    const matchesGenerated = sha256(file.content) === previous.sha256;
    if (!update) {
      decisions.push({ action: matchesRecorded ? "unchanged" : "divergent", agent, path: file.path });
      continue;
    }
    if (!matchesRecorded) {
      decisions.push({ action: "divergent", agent, path: file.path });
      continue;
    }
    if (matchesGenerated) {
      decisions.push({ action: "unchanged", agent, path: file.path });
      continue;
    }
    decisions.push({ action: "update", agent, path: file.path });
    if (!dryRun) {
      writeFileSync(fullPath, file.content, "utf8");
      previous.sha256 = sha256(file.content);
    }
  }
  return { manifest: next, decisions };
}

function prepare(root: string, requestedAgent: Agent): { state: ManifestState; agents: Agent[]; primaryAgent: Agent; language: LocaleId; manifest: AgentManifestV2 } | undefined {
  const current = project(root);
  if (!current) return undefined;
  const state = readManifest(root);
  if (state.version === "invalid") return undefined;
  const config = agentsFor(current.settings, state);
  const agents = uniqueAgents([...config.agents, requestedAgent]);
  const primaryAgent = config.primaryAgent;
  return { state, agents, primaryAgent, language: config.language, manifest: asV2(state, agents, primaryAgent) };
}

function migration(state: ManifestState): AgentDecision[] {
  return state.version === "1"
    ? [{ action: "migrate", path: agentManifestPath }]
    : [];
}

export function runInit(root: string, options: InitOptions = {}): number {
  const profile = normalizeProfile(options.profile);
  if (!profile) {
    console.error("Profile must be lean, standard, or strict");
    return 2;
  }
  const agent = normalizeAgent(options.agent);
  if (!agent) {
    console.error(agentError);
    return 2;
  }
  const lang = normalizeLocaleId(options.lang);
  if (!lang) {
    console.error("Language must be a supported locale id");
    return 2;
  }

  for (const dir of profileRequiredDirs(profile)) mkdirSync(resolveFrom(root, dir), { recursive: true });
  const existing = project(root);
  const existingState = readManifest(root);
  if (existingState.version === "invalid") {
    console.error(manifestError);
    return 2;
  }
  const existingConfig = existing ? agentsFor(existing.settings, existingState) : { agents: [agent], primaryAgent: agent, language: lang };
  const agents = uniqueAgents([...existingConfig.agents, agent]);
  const primaryAgent = existing ? existingConfig.primaryAgent : agent;
  const wbs: WbsDocument = existing?.wbs ?? {
    schemaVersion: "0.1.0",
    id: "scwbs-project",
    name: "SC-WBS Project",
    rootId: "node-project",
    nodes: [{ id: "node-project", parentId: null, code: "1", name: "Project", type: "deliverable", status: "planned", progressPercent: 0, extensions: { scwbs: { status: "Not Started" } } }],
    relations: [],
    resources: [{ id: "resource-human", name: "Human", type: "role" }, { id: "resource-ai", name: "AI Agent", type: "role" }],
    artifacts: [],
    metadata: { createdBy: "scwbs", language: localeMetadata(lang) },
    extensions: { scwbs: { profile, agent: primaryAgent, primaryAgent, agents, lang } }
  };
  if (!existing) {
    writeIfMissing(root, defaultWbsPath, `${JSON.stringify(wbs, null, 2)}\n`);
    writeIfMissing(root, defaultRegistryPath, stringifySimpleYaml({ projectId: "scwbs-project", contracts: [] }));
  }
  const manifest = asV2(existingState, agents, primaryAgent);
  const synced = sync(root, manifest, agent, existing ? existingConfig.language : lang, false, false);
  writeSettings(root, agents, primaryAgent);
  writeManifest(root, synced.manifest);
  for (const decision of synced.decisions) console.log(`${decision.action} ${decision.path ?? ""}`.trim());
  if (!existing) console.log(`created ${defaultWbsPath}`);
  return 0;
}

export function runAgentUpdate(root: string, options: AgentUpdateOptions = {}): number {
  const dryRun = options.dryRun ?? false;
  const requested = options.agent ? normalizeAgent(options.agent) : undefined;
  if (options.agent && !requested) {
    console.error(agentError);
    return 2;
  }
  const current = project(root);
  if (!current) {
    console.error("Cannot update agents: invalid WBS");
    return 2;
  }
  const state = readManifest(root);
  if (state.version === "invalid") {
    console.error(manifestError);
    return 2;
  }
  const config = agentsFor(current.settings, state);
  const selected = requested ? [requested] : config.agents;
  const agents = uniqueAgents([...config.agents, ...selected]);
  const manifest = asV2(state, agents, config.primaryAgent);
  let next = manifest;
  const decisions = migration(state);
  for (const agent of selected) {
    const synced = sync(root, next, agent, config.language, true, dryRun);
    next = synced.manifest;
    decisions.push(...synced.decisions);
  }
  if (!dryRun) {
    writeSettings(root, next.agents, config.primaryAgent);
    writeManifest(root, next);
  }
  output(decisions, options.json);
  return 0;
}

export function runAgentAdd(root: string, value: string, options: AgentOperationOptions = {}): number {
  const agent = normalizeAgent(value);
  if (!agent) {
    console.error(agentError);
    return 2;
  }
  const prepared = prepare(root, agent);
  if (!prepared) {
    console.error("Cannot add agent: invalid WBS/manifest");
    return 2;
  }
  const synced = sync(root, prepared.manifest, agent, prepared.language, false, false);
  const decisions = [...migration(prepared.state), ...synced.decisions, { action: "move" as const, agent }];
  writeSettings(root, synced.manifest.agents, prepared.primaryAgent);
  writeManifest(root, synced.manifest);
  output(decisions, options.json);
  return 0;
}

export function runAgentSetPrimary(root: string, value: string, options: AgentOperationOptions = {}): number {
  const agent = normalizeAgent(value);
  if (!agent) {
    console.error(agentError);
    return 2;
  }
  const current = project(root);
  const state = readManifest(root);
  const existingAgents = current && state.version !== "invalid" ? agentsFor(current.settings, state).agents : [];
  const prepared = prepare(root, agent);
  if (!prepared || !existingAgents.includes(agent)) {
    console.error(`Unmanaged agent: ${agent}; add it first`);
    return 2;
  }
  const next = { ...prepared.manifest, primaryAgent: agent };
  const decisions: AgentDecision[] = [{ action: "move", agent }];
  writeSettings(root, next.agents, agent);
  writeManifest(root, next);
  output(decisions, options.json);
  return 0;
}

export function runAgentRemove(root: string, value: string, options: AgentOperationOptions = {}): number {
  const agent = normalizeAgent(value);
  if (!agent) {
    console.error(agentError);
    return 2;
  }
  const current = project(root);
  const state = readManifest(root);
  if (!current || state.version === "invalid") {
    console.error("Cannot remove agent: invalid WBS/manifest");
    return 2;
  }
  const config = agentsFor(current.settings, state);
  const manifest = asV2(state, config.agents, config.primaryAgent);
  if (!manifest.agents.includes(agent)) {
    console.error(`Unmanaged agent: ${agent}`);
    return 2;
  }
  if (manifest.agents.length === 1) {
    console.error("Cannot remove only agent");
    return 2;
  }
  const nextAgents = manifest.agents.filter((candidate) => candidate !== agent);
  const nextPrimary = manifest.primaryAgent === agent ? nextAgents[0] : manifest.primaryAgent;
  const decisions = migration(state);
  const retained: AgentManifestFile[] = [];
  for (const file of manifest.files) {
    if (file.owner !== agent) {
      retained.push(file);
      continue;
    }
    const fullPath = assertSafeAgentPath(root, file.path);
    const current = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : undefined;
    if (current !== undefined && sha256(current) !== file.sha256) {
      decisions.push({ action: "preserved", agent, path: file.path });
    } else {
      decisions.push({ action: "removed", agent, path: file.path });
      if (current !== undefined) unlinkSync(fullPath);
    }
  }
  const next: AgentManifestV2 = { ...manifest, agents: nextAgents, primaryAgent: nextPrimary, files: retained };
  writeSettings(root, nextAgents, nextPrimary);
  writeManifest(root, next);
  output(decisions, options.json);
  return 0;
}

export function runAgentList(options: AgentOperationOptions = {}): number {
  const adapters = listAgentAdapters().map((adapter) => ({
    id: adapter.id,
    displayName: adapter.displayName,
    version: adapter.version,
    status: adapter.status,
    capabilities: adapter.capabilities,
    files: adapter.files.map((file) => file.path)
  }));
  if (options.json) {
    console.log(JSON.stringify({ version: "scwbs.agent-list.v1", adapters }, null, 2));
  } else {
    for (const adapter of adapters) console.log(`${adapter.id}\t${adapter.status}\t${adapter.displayName}`);
  }
  return 0;
}

export function runAgentInspect(value: string, options: AgentOperationOptions = {}): number {
  const adapter = getAgentAdapter(value.toLowerCase());
  if (!adapter) {
    console.error(agentError);
    return 2;
  }
  const result = {
    id: adapter.id,
    displayName: adapter.displayName,
    version: adapter.version,
    status: adapter.status,
    capabilities: adapter.capabilities,
    files: adapter.files
  };
  if (options.json) console.log(JSON.stringify({ version: "scwbs.agent-inspect.v1", adapter: result }, null, 2));
  else console.log(`${adapter.id} ${adapter.status} ${adapter.displayName}`);
  return 0;
}

export function runAgentDoctor(root: string, options: AgentDoctorOptions = {}): number {
  if (!options.all) {
    console.error("agent doctor requires --all");
    return 2;
  }
  const diagnostics = diagnoseAgentAdapters(root);
  if (options.json) {
    console.log(JSON.stringify({ version: "scwbs.agent-doctor.v1", diagnostics }, null, 2));
  } else {
    for (const diagnostic of diagnostics) console.log(`${diagnostic.id}\t${diagnostic.status}\t${diagnostic.issues.join("; ")}`.trim());
  }
  return diagnostics.some((diagnostic) => diagnostic.status === "error") ? 1 : 0;
}
