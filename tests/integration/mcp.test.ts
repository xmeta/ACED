import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe("stdio MCP server", () => {
  test("keeps stdout protocol-only and returns structured capabilities", () => {
    const cli = path.join(process.cwd(), "dist/cli.js");
    if (!existsSync(cli)) throw new Error("dist/cli.js is required; run the build before integration tests");
    const input = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/list" })
    ].join("\n") + "\n";
    const output = execFileSync(process.execPath, [cli, "mcp", "--stdio"], { input, encoding: "utf8", cwd: process.cwd() });
    const messages = output.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "scwbs" } } });
    expect(messages[1]).toMatchObject({ jsonrpc: "2.0", id: 2, result: { tools: expect.any(Array) } });
    expect(messages[2]).toMatchObject({ jsonrpc: "2.0", id: 3, result: { resources: expect.any(Array), resourceTemplates: expect.any(Array) } });
    expect(output).not.toContain("scwbs waiting for active command");
  });

  test("does not expose Human-only or shell-shaped tool inputs", () => {
    const cli = path.join(process.cwd(), "dist/cli.js");
    const input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`;
    const output = execFileSync(process.execPath, [cli, "mcp", "--stdio"], { input, encoding: "utf8", cwd: process.cwd() });
    const response = JSON.parse(output) as { result: { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> } };
    const names = response.result.tools.map((tool) => tool.name);
    expect(names.some((name) => /approval|review|merge|prune/i.test(name))).toBe(false);
    expect(response.result.tools.flatMap((tool) => Object.keys(tool.inputSchema.properties ?? {}))).not.toContain("command");
  });
});
