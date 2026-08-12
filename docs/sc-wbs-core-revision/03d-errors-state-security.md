# 03. Detailed Design

この文書は、SC-WBS Core改訂の詳細設計である。


## Error Code設計

代表的なエラーコード:

| Code | 意味 | 代表fixCommand |
|---|---|---|
| `SCWBS_TASK_NOT_FOUND` | Task Contractがない | `scwbs task new` |
| `SCWBS_BRANCH_MISMATCH` | branchがTask Contractと違う | `scwbs start <task-id>` |
| `SCWBS_PATH_OUTSIDE_ALLOWED` | allowedPaths外変更 | 変更を戻す、または `scwbs block` |
| `SCWBS_PATH_FORBIDDEN` | forbiddenPaths変更 | `scwbs block "..."` |
| `SCWBS_HUMAN_GATE_REQUIRED` | Human Gate対象差分 | `scwbs request-approval <task-id>` |
| `SCWBS_EVIDENCE_MISSING` | Evidenceなし | `scwbs finish` |
| `SCWBS_APPROVAL_SCOPE_STALE` | 承認後に差分変更 | `scwbs approve <task-id> --pr <n>` |
| `SCWBS_CHECK_FAILED` | required check失敗 | テスト修正後 `scwbs finish` |

## 状態遷移

Coreでは状態を単純にする。

```text
planned -> inProgress -> ready -> completed
                 ↓
              blocked
```

AIができること:

```text
planned -> inProgress
inProgress -> ready
any -> blocked
```

人間が必要なこと:

```text
ready -> completed
blocked -> planned
approval requested -> approved
```

## セキュリティ境界

AIが実行してよいコマンド:

```text
scwbs start
scwbs packet
scwbs finish
scwbs check-diff
scwbs block
scwbs request-approval
scwbs next
```

AIが実行してはいけないコマンド:

```text
scwbs approve
scwbs complete
scwbs release
```

実装上は、CIやローカルで完全にAI実行を区別できない場合がある。
そのため、少なくとも出力文書とAGENTS.mdで禁止し、`approve` には `--actor human` や署名・環境変数などの追加ガードを検討する。
