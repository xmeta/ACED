import { describe, expect, test } from "vitest";
import { request } from "node:http";
import type { Server } from "node:http";
import { buildTraceJson } from "../../src/commands/trace.js";
import { buildUiJsonOutput } from "../../src/commands/ui.js";
import { createDashboardServer } from "../../src/core/serve.js";
import { makeTempRepo, writeScwbsProject } from "../helpers.js";

function fetch(server: Server, path: string, method = "GET"): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server is not listening");
  return new Promise((resolve, reject) => {
    const response = request({ hostname: "127.0.0.1", port: address.port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    response.on("error", reject);
    response.end();
  });
}

describe("read-only dashboard HTTP projection", () => {
  test("serves bounded dashboard and trace projections on localhost only", async () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const server = createDashboardServer({
      buildDashboard: () => ({ ui: buildUiJsonOutput(root), openRisks: [] }),
      buildTrace: (taskId) => buildTraceJson(root, taskId)
    }, { port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    try {
      const page = await fetch(server, "/");
      expect(page.status).toBe(200);
      expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(page.body).toContain("SC-WBS Dashboard");

      const dashboard = await fetch(server, "/api/v1/dashboard");
      expect(dashboard.status).toBe(200);
      expect(JSON.parse(dashboard.body)).toMatchObject({ version: "scwbs.dashboard.v1", readOnly: true });

      const trace = await fetch(server, "/api/v1/trace?task=WBS-001-004");
      expect(trace.status).toBe(200);
      expect(JSON.parse(trace.body)).toMatchObject({ version: "scwbs.trace.v1", taskId: "WBS-001-004" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("rejects mutation methods, traversal, unknown routes, and invalid tasks", async () => {
    const server = createDashboardServer({ buildDashboard: () => ({}), buildTrace: () => ({}) }, { port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    try {
      expect((await fetch(server, "/api/v1/dashboard", "POST")).status).toBe(405);
      expect((await fetch(server, "/%2e%2e/package.json")).status).toBe(400);
      expect((await fetch(server, "/unknown")).status).toBe(404);
      expect((await fetch(server, "/api/v1/trace?task=../../etc/passwd")).status).toBe(400);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
