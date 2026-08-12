# 03. Detailed Design

この文書は、SC-WBS Core改訂の詳細設計である。

## Git Adapter

Git操作は直接CLI各所に散らさない。

責務:

```text
- 現在branch取得
- base ref解決
- head commit取得
- changed files取得
- diff内容取得
- diffHash生成に必要な正規化diff取得
- branch名検証
```

主要メソッド:

```ts
getCurrentBranch(): Promise<string>
getHeadCommit(): Promise<string>
getBaseCommit(baseRef: string): Promise<string>
getChangedFiles(baseRef: string, headRef: string): Promise<ChangedFile[]>
getNormalizedDiff(baseRef: string, headRef: string): Promise<string>
```

## Process Runner

requiredChecksを実行する。

責務:

```text
- command実行
- timeout
- stdout/stderr収集
- exit code記録
- CI/local source判定
```

Check Catalogに基づいて実行する。

```yaml
checks:
  test:
    command: npm test
    timeoutSeconds: 300
  typecheck:
    command: npm run typecheck
    timeoutSeconds: 300
```

## 出力設計

### Human output

人間向けには短く表示する。

```text
ERROR SCWBS_PATH_FORBIDDEN
Task: WBS-001
File: migrations/001_add_table.sql
Reason: forbiddenPaths matched migrations/**
Fix:
  scwbs block "DB migration is required"
```

### JSON output

CIやAI統合向けに `--json` を用意する。

```json
{
  "ok": false,
  "errors": [
    {
      "code": "SCWBS_PATH_FORBIDDEN",
      "taskId": "WBS-001",
      "file": "migrations/001_add_table.sql",
      "fixCommand": "scwbs block \"DB migration is required\""
    }
  ]
}
```

### AI Packet output

AI Packetは、読みやすい短いテキストを第一形式とする。

```text
Task: WBS-001 - Staff search API
Goal: Implement staff search API.

Allowed:
- src/features/staff-search/**
- tests/features/staff-search/**

Do not touch:
- src/auth/**
- migrations/**

Stop if:
- DB schema change needed
- auth/permission change needed
- API breaking change needed

When done:
- scwbs finish

When blocked:
- scwbs block "<reason>"
```
