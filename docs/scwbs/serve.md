# ローカルread-only dashboard

`scwbs serve`は、CLIを直接使わないreviewer向けに既存SC-WBS evaluatorをlocal projectionする。

```bash
npm run scwbs -- serve --port 0
```

serverは`127.0.0.1`だけにbindする。port `0`はOSにfree portの選択を依頼し、listener ready後にselected URLを表示する。daemon installation、external CDN、telemetry、network serviceは必要ない。

## read-only API

利用できるGET routeは次だけである。

- `/api/v1/health` — bounded server statusとread-only capability。
- `/api/v1/dashboard` — `scwbs.dashboard.v1`による`ui --json`とbounded open-risk summaryのprojection。
- `/api/v1/trace?task=<id>` — validated Task ID 1件の既存`scwbs.trace.v1` graph。

その他のpath、mutation method、invalid Task ID、traversal attempt、oversized requestはfail-closedになる。serverはapproval、review、block、finish、merge、policy、file-browser、source-content endpointを提供しない。

static pageはrestrictive Content Security Policyを使い、取得dataを`textContent`で書き込む。responseには`nosniff`、`no-store`、bounded response sizeを含める。remote bind、authentication、dependency change、write APIは意図的に除外し、別途approveされたTaskが必要である。
