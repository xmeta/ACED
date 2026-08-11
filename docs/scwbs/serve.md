# Local read-only dashboard

`scwbs serve` is a local projection of existing SC-WBS evaluators for reviewers who do not use the CLI directly.

```bash
npm run scwbs -- serve --port 0
```

The server binds only to `127.0.0.1`. Port `0` asks the operating system to choose a free port; the selected URL is printed after the listener is ready. No daemon installation, external CDN, telemetry, or network service is required.

## Read-only API

Only these GET routes are available:

- `/api/v1/health` — bounded server status and read-only capability.
- `/api/v1/dashboard` — `scwbs.dashboard.v1`, projecting `ui --json` plus bounded open-risk summaries.
- `/api/v1/trace?task=<id>` — the existing `scwbs.trace.v1` graph for one validated Task ID.

Other paths, mutation methods, invalid Task IDs, traversal attempts, and oversized requests fail closed. The server does not provide approval, review, block, finish, merge, policy, file-browser, or source-content endpoints.

The static page uses a restrictive Content Security Policy and writes fetched data with `textContent`. Responses include `nosniff`, `no-store`, and a bounded response size. Remote bind, authentication, dependency changes, and write APIs are intentionally excluded and require a separately approved Task.
