import { buildTinyPacket } from "../commands/ai-packet.js";
import { runAiBlock } from "../commands/ai-queue.js";
import { buildTaskPreflightOutput } from "../commands/task-new.js";
import { runFinish } from "../commands/finish.js";
import { collectCheckIssues } from "../commands/check.js";
import { buildNextJsonOutput } from "../commands/next.js";
import { buildReviewQueueSummary } from "../commands/review-queue.js";
import { buildStatusJsonOutput } from "../commands/status.js";
import { buildTraceJson } from "../commands/trace.js";
import { readEvidence } from "./contracts.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18" as const;
export const MCP_SERVER_VERSION = "scwbs.mcp.v1" as const;
const MAX_MESSAGE_BYTES = 100_000;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type JsonObject = Record<string, unknown>;
type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type McpResource = {
  uri: string;
  name: string;
  description: string;
  mimeType: "application/json" | "text/plain";
};

type McpTool = {
  name: string;
  description: string;
  inputSchema: JsonObject;
};

const resources: McpResource[] = [
  { uri: "scwbs://project/status", name: "project-status", description: "Read-only SC-WBS status", mimeType: "application/json" },
  { uri: "scwbs://project/next", name: "project-next", description: "Read-only next action", mimeType: "application/json" },
  { uri: "scwbs://review-queue", name: "review-queue", description: "Read-only review queue", mimeType: "application/json" }
];

const tools: McpTool[] = [
  {
    name: "scwbs.task.preflight",
    description: "Evaluate a prospective Task Contract without creating authority",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 240 },
        paths: { type: "array", items: { type: "string", minLength: 1, maxLength: 240 }, minItems: 1, maxItems: 100 },
        profile: { type: "string", enum: ["lean", "standard", "strict", "Lean", "Standard", "Strict"] }
      },
      required: ["title", "paths"],
      additionalProperties: false
    }
  },
  {
    name: "scwbs.check",
    description: "Run the existing read-only SC-WBS contract evaluator",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "scwbs.finish",
    description: "Run the existing Task finish evaluator; Human Gates remain blocking",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" } },
      required: ["taskId"],
      additionalProperties: false
    }
  },
  {
    name: "scwbs.block",
    description: "Record an AI block through the existing evaluator; this cannot resolve a block",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
        reason: { type: "string", minLength: 1, maxLength: 2_000 }
      },
      required: ["taskId", "reason"],
      additionalProperties: false
    }
  }
];

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

function successResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function requestId(request: JsonRpcRequest): JsonRpcId {
  return typeof request.id === "string" || typeof request.id === "number" || request.id === null ? request.id : null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => publicValue(item, depth + 1));
  if (!isObject(value)) return value;
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (/secret|token|password|credential|private.?key|authorization/i.test(key)) continue;
    output[key] = publicValue(item, depth + 1);
  }
  return output;
}

function jsonText(value: unknown): string {
  const text = JSON.stringify(publicValue(value)) ?? "null";
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) throw new Error("MCP response exceeds bounded output limit");
  return text;
}

function textContent(uri: string, value: unknown, mimeType: McpResource["mimeType"]): JsonObject {
  const text = typeof value === "string" ? value : jsonText(value);
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) throw new Error("MCP resource exceeds bounded output limit");
  return { contents: [{ uri, mimeType, text }] };
}

function requireObject(value: unknown): JsonObject {
  if (!isObject(value)) throw new Error("params must be a JSON object");
  return value;
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${field} must be a non-empty bounded string`);
  }
  return value.trim();
}

function requireTaskId(value: unknown): string {
  const taskId = requireString(value, "taskId", 128);
  if (!TASK_ID_PATTERN.test(taskId) || taskId.includes("..")) throw new Error("taskId contains an invalid path segment");
  return taskId;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100 || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 240)) {
    throw new Error(`${field} must be a bounded non-empty string array`);
  }
  return value.map((item) => (item as string).trim());
}

function parseTaskResource(uri: string): { taskId: string; kind: "packet" | "trace" | "evidence" } | undefined {
  const match = /^scwbs:\/\/tasks\/([^/]+)\/(packet|trace|evidence)$/.exec(uri);
  if (!match) return undefined;
  const taskId = requireTaskId(decodeURIComponent(match[1]));
  return { taskId, kind: match[2] as "packet" | "trace" | "evidence" };
}

function captureCommand<T>(fn: () => T): { value: T; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: fn(), stdout, stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

function capturedResult(tool: string, exitCode: number, captured: { stdout: string; stderr: string }): JsonObject {
  const capturedText = captured.stdout.trim();
  let output: unknown = capturedText;
  if (capturedText.length > 0) {
    try { output = JSON.parse(capturedText); } catch { output = capturedText.slice(0, MAX_MESSAGE_BYTES); }
  }
  return {
    version: "scwbs.mcp-tool-result.v1",
    tool,
    status: exitCode === 0 ? "pass" : "blocked",
    exitCode,
    output: publicValue(output),
    diagnostics: captured.stderr.trim().slice(0, 20_000)
  };
}

function resourceList(): JsonObject {
  return {
    resources,
    resourceTemplates: [
      { uriTemplate: "scwbs://tasks/{taskId}/packet", name: "task-packet", description: "Read-only bounded Task packet", mimeType: "text/plain" },
      { uriTemplate: "scwbs://tasks/{taskId}/trace", name: "task-trace", description: "Read-only Task trace graph", mimeType: "application/json" },
      { uriTemplate: "scwbs://tasks/{taskId}/evidence", name: "task-evidence", description: "Read-only sanitized Task Evidence", mimeType: "application/json" }
    ]
  };
}

function readResource(root: string, uri: string): JsonObject {
  if (uri === "scwbs://project/status") return textContent(uri, buildStatusJsonOutput(root), "application/json");
  if (uri === "scwbs://project/next") return textContent(uri, buildNextJsonOutput(root), "application/json");
  if (uri === "scwbs://review-queue") return textContent(uri, buildReviewQueueSummary(root, 100), "application/json");
  const taskResource = parseTaskResource(uri);
  if (!taskResource) throw new Error("Unknown or invalid MCP resource URI");
  if (taskResource.kind === "packet") return textContent(uri, buildTinyPacket(root, taskResource.taskId), "text/plain");
  if (taskResource.kind === "trace") return textContent(uri, buildTraceJson(root, taskResource.taskId), "application/json");
  const { evidence, issues } = readEvidence(root, taskResource.taskId);
  if (!evidence) throw new Error(issues.map((issue) => issue.message).join("\n") || "Evidence not found");
  return textContent(uri, evidence, "application/json");
}

function callTool(root: string, name: string, rawArguments: unknown): JsonObject {
  const args = requireObject(rawArguments ?? {});
  if (name === "scwbs.task.preflight") {
    const title = requireString(args.title, "title", 240);
    const paths = requireStringArray(args.paths, "paths");
    const profile = args.profile === undefined ? undefined : requireString(args.profile, "profile", 32);
    return { version: "scwbs.mcp-tool-result.v1", tool: name, status: "pass", result: buildTaskPreflightOutput(root, { title, paths, profile }) };
  }
  if (name === "scwbs.check") {
    const issues = collectCheckIssues(root);
    return { version: "scwbs.mcp-tool-result.v1", tool: name, status: issues.some((issue) => issue.severity === "error") ? "fail" : "pass", result: { version: "scwbs.check.v1", status: issues.some((issue) => issue.severity === "error") ? "fail" : "pass", issues: publicValue(issues) } };
  }
  if (name === "scwbs.finish") {
    const taskId = requireTaskId(args.taskId);
    const captured = captureCommand(() => runFinish(root, { taskId, force: true, json: true }));
    return capturedResult(name, captured.value, captured);
  }
  if (name === "scwbs.block") {
    const taskId = requireTaskId(args.taskId);
    const reason = requireString(args.reason, "reason", 2_000);
    const captured = captureCommand(() => runAiBlock(root, taskId, reason));
    return capturedResult(name, captured.value, captured);
  }
  throw new Error("Unknown MCP tool");
}

function initializeResult(): JsonObject {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { resources: { listChanged: false, subscribe: false }, tools: { listChanged: false } },
    serverInfo: { name: "scwbs", version: MCP_SERVER_VERSION },
    instructions: "stdio-only SC-WBS integration; Human-only operations and authority changes remain outside MCP"
  };
}

export function handleMcpRequest(root: string, request: JsonRpcRequest): JsonRpcResponse | undefined {
  const id = requestId(request);
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return errorResponse(id, -32600, "Invalid JSON-RPC request");
  try {
    switch (request.method) {
      case "initialize": return successResponse(id, initializeResult());
      case "notifications/initialized":
      case "notifications/cancelled": return undefined;
      case "ping": return successResponse(id, {});
      case "resources/list": return successResponse(id, resourceList());
      case "resources/read": {
        const params = requireObject(request.params);
        return successResponse(id, readResource(root, requireString(params.uri, "uri", 512)));
      }
      case "tools/list": return successResponse(id, { tools });
      case "tools/call": {
        const params = requireObject(request.params);
        const name = requireString(params.name, "name", 128);
        const result = callTool(root, name, params.arguments);
        return successResponse(id, { content: [{ type: "text", text: jsonText(result), mimeType: "application/json" }], structuredContent: result, isError: result.status === "blocked" || result.status === "fail" });
      }
      default: return errorResponse(id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    return errorResponse(id, -32000, error instanceof Error ? error.message : String(error));
  }
}

async function serveStdio(root: string): Promise<void> {
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += Buffer.from(chunk).toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let response: JsonRpcResponse | undefined;
      try {
        response = handleMcpRequest(root, JSON.parse(line) as JsonRpcRequest);
      } catch (error) {
        response = errorResponse(null, -32700, error instanceof Error ? error.message : String(error));
      }
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
  if (buffer.trim()) {
    const response = errorResponse(null, -32700, "Incomplete MCP JSON-RPC message");
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

export function runMcpStdio(root: string): number {
  const fixedRoot = root;
  void serveStdio(fixedRoot).catch((error) => {
    process.stderr.write(`scwbs MCP server failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
  return 0;
}
