import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isValidTaskId } from "./paths.js";

export const DASHBOARD_VERSION = "scwbs.dashboard.v1" as const;
export const SERVE_VERSION = "scwbs.serve.v1" as const;
export const MAX_DASHBOARD_RESPONSE_BYTES = 512 * 1024;
const MAX_REQUEST_URL_LENGTH = 2048;
const MAX_TASK_QUERY_LENGTH = 128;

export type DashboardProjection = {
  buildDashboard: () => unknown;
  buildTrace: (taskId: string) => unknown;
};

export type DashboardServerOptions = {
  port?: number;
};

export function parseServePort(value: number | string | undefined): number {
  if (value === undefined || value === "") return 0;
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("serve.port.invalid: port must be an integer from 0 to 65535");
  }
  return port;
}

function securityHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store"
  };
}

function send(response: ServerResponse, statusCode: number, body: string, contentType: string): void {
  const size = Buffer.byteLength(body, "utf8");
  if (size > MAX_DASHBOARD_RESPONSE_BYTES) {
    response.writeHead(500, securityHeaders("application/json; charset=utf-8"));
    response.end(JSON.stringify({ version: "scwbs.dashboard-error.v1", status: "fail", code: "dashboard.response.bounded" }));
    return;
  }
  response.writeHead(statusCode, { ...securityHeaders(contentType), "Content-Length": String(size) });
  response.end(body);
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  send(response, statusCode, `${JSON.stringify(value)}\n`, "application/json; charset=utf-8");
}

function sendError(response: ServerResponse, statusCode: number, code: string): void {
  sendJson(response, statusCode, { version: "scwbs.dashboard-error.v1", status: "fail", code });
}

function rawPath(request: IncomingMessage): string {
  return (request.url ?? "").split("?", 1)[0] ?? "";
}

function hasTraversal(pathname: string): boolean {
  if (/(?:^|\/)(?:\.\.|%2e%2e)(?:\/|$)/i.test(pathname)) return true;
  try {
    return decodeURIComponent(pathname).split("/").some((segment) => segment === "..");
  } catch {
    return true;
  }
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'">
  <title>SC-WBS Dashboard</title>
  <style>body{font:16px system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;background:#f7f7f5;color:#202124}pre{white-space:pre-wrap;background:#fff;border:1px solid #ddd;padding:1rem;overflow:auto}code{font-family:ui-monospace,monospace}</style>
</head>
<body>
  <h1>SC-WBS Dashboard</h1>
  <p>Local read-only projection. No approval, review, mutation, or file browser is available.</p>
  <pre id="dashboard">Loading dashboard…</pre>
  <script>
    fetch('/api/v1/dashboard', {credentials:'same-origin'})
      .then(function(response){ if(!response.ok) throw new Error('dashboard unavailable'); return response.json(); })
      .then(function(value){ document.getElementById('dashboard').textContent = JSON.stringify(value, null, 2); })
      .catch(function(){ document.getElementById('dashboard').textContent = 'Dashboard unavailable'; });
  </script>
</body>
</html>
`;
}

function route(request: IncomingMessage, response: ServerResponse, projection: DashboardProjection): void {
  const requestUrl = request.url ?? "";
  if (requestUrl.length === 0 || requestUrl.length > MAX_REQUEST_URL_LENGTH) {
    sendError(response, 414, "serve.request.too-large");
    return;
  }
  if (request.method !== "GET") {
    sendError(response, 405, "serve.method.read-only");
    return;
  }
  const pathname = rawPath(request);
  if (hasTraversal(pathname)) {
    sendError(response, 400, "serve.path.traversal");
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(requestUrl, "http://127.0.0.1");
  } catch {
    sendError(response, 400, "serve.request.invalid");
    return;
  }
  if (parsed.pathname === "/") {
    send(response, 200, dashboardHtml(), "text/html; charset=utf-8");
    return;
  }
  if (parsed.pathname === "/api/v1/health") {
    sendJson(response, 200, { version: SERVE_VERSION, status: "pass", readOnly: true, bind: "127.0.0.1" });
    return;
  }
  if (parsed.pathname === "/api/v1/dashboard") {
    try {
      sendJson(response, 200, { version: DASHBOARD_VERSION, readOnly: true, dashboard: projection.buildDashboard() });
    } catch {
      sendError(response, 500, "dashboard.projection.failed");
    }
    return;
  }
  if (parsed.pathname === "/api/v1/trace") {
    const taskId = parsed.searchParams.get("task") ?? "";
    if (taskId.length === 0 || taskId.length > MAX_TASK_QUERY_LENGTH || !isValidTaskId(taskId)) {
      sendError(response, 400, "serve.task.invalid");
      return;
    }
    try {
      sendJson(response, 200, projection.buildTrace(taskId));
    } catch {
      sendError(response, 404, "serve.trace.unavailable");
    }
    return;
  }
  sendError(response, 404, "serve.route.not-found");
}

export function createDashboardServer(projection: DashboardProjection, options: DashboardServerOptions = {}): Server {
  const port = parseServePort(options.port);
  const server = createServer((request, response) => route(request, response, projection));
  server.on("error", () => {
    // The CLI owns user-facing error reporting; the server never exposes error details.
  });
  server.listen(port, "127.0.0.1");
  return server;
}

export function dashboardHtmlForTest(): string {
  return dashboardHtml();
}
