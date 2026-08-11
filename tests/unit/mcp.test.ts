import { describe, expect, test } from "vitest";
import { handleMcpRequest } from "../../src/core/mcp.js";

describe("MCP protocol surface", () => {
  test("returns deterministic initialize, resource, and tool capabilities", () => {
    const initialize = handleMcpRequest(process.cwd(), { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(initialize).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { resources: { subscribe: false }, tools: { listChanged: false } },
        serverInfo: { name: "scwbs", version: "scwbs.mcp.v1" }
      }
    });

    const resources = handleMcpRequest(process.cwd(), { jsonrpc: "2.0", id: 2, method: "resources/list" });
    const resourceTemplates = (resources?.result as { resourceTemplates: Array<{ uriTemplate: string }> }).resourceTemplates;
    expect(resourceTemplates).toEqual(expect.arrayContaining([expect.objectContaining({ uriTemplate: "scwbs://tasks/{taskId}/packet" })]));

    const tools = handleMcpRequest(process.cwd(), { jsonrpc: "2.0", id: 3, method: "tools/list" });
    const names = ((tools?.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
    expect(names).toEqual(["scwbs.task.preflight", "scwbs.check", "scwbs.finish", "scwbs.block"]);
    expect(names).not.toContain("approval.approve");
  });

  test("rejects traversal, unknown resources, and unsupported methods", () => {
    const traversal = handleMcpRequest(process.cwd(), {
      jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "scwbs://tasks/../secret/evidence" }
    });
    expect(traversal?.error?.code).toBe(-32000);

    const unknown = handleMcpRequest(process.cwd(), {
      jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "scwbs://project/secret" }
    });
    expect(unknown?.error?.code).toBe(-32000);

    const unsupported = handleMcpRequest(process.cwd(), { jsonrpc: "2.0", id: 6, method: "approval/approve" });
    expect(unsupported?.error?.code).toBe(-32601);
  });

  test("preflight uses structured input and never creates authority", () => {
    const result = handleMcpRequest(process.cwd(), {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "scwbs.task.preflight",
        arguments: { title: "MCP integration", paths: ["src/core/mcp.ts"], profile: "standard" }
      }
    });
    expect(result).toMatchObject({ result: { structuredContent: { version: "scwbs.mcp-tool-result.v1", result: { version: "scwbs.task-preflight.v1" } } } });
  });
});
