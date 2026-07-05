# 11. CLI Compatibility Map

この文書は、現行 ACED CLI と Core 改訂案の短縮コマンドの対応を整理する。

## 方針

- 既存の `npm run scwbs -- ...` 呼び出しは後方互換として維持する。
- Core 短縮コマンドは、既存コマンドを置き換えるのではなく alias として追加する。
- 既存コマンドを deprecated にする判断は保留する。少なくとも Core 移行期間中は併存させる。
- `scwbs` 直実行は `package.json` の `bin.scwbs` から `dist/cli.js` に解決する。開発時は従来通り `npm run scwbs -- ...` を使う。

## 既存 CLI 棚卸し

| 既存コマンド | 主な入力 | 主な出力/生成ファイル |
|---|---|---|
| `init` | `--profile`, `--agent`, `--lang` | `contracts/wbs/project.wbs.json`, `contracts/registry.yaml` |
| `check` | なし | Contract / Evidence / Registry の検証結果 |
| `check-diff` | `--task`, `--base` | allowedPaths / forbiddenPaths / Evidence gate の検証結果 |
| `ai packet` | `--task`, `--relation-depth`, `--format` | AI Work Packet |
| `ai block` | `--task`, `--reason` | block 用 WBS changeset JSON |
| `ai next-task` | なし | AI向け次タスク候補 |
| `approval request` | `--task`, `--pull-request`, `--note`, `--force` | `contracts/approvals/<task-id>.yaml` |
| `approval approve` | `--task`, `--pull-request`, `--reason`, `--force` | approved approval record |
| `evidence collect` | `--task`, `--base`, `--pull-request`, test quality flags, `--force` | `contracts/evidence/<task-id>.yaml` |
| `next` | なし | 次アクション候補 |
| `review request` | `--task`, `--pull-request`, `--force` | `contracts/reviews/<task-id>.yaml` |
| `review-queue` | なし | review / completion queue |
| `start` | goal text | draft spec, WBS changeset draft, draft Task Contract |
| `task generate` | `--node`, `--task`, `--force` | WBS node 由来の draft Task Contract |
| `task lock` / `task refresh` | `--task`, `--apply` | Task Contract lock metadata |
| `wbs validate` / `wbs apply` | changeset path, `--output`, `--force` | WBS validation / applied WBS JSON |

## Core 短縮コマンド対応表

| Core コマンド | 現行対応 | 状態 |
|---|---|---|
| `task new "title"` | 新規 alias。title と path/check options から draft Task Contract を生成する。 | 実装済み |
| `start <task-id>` | 既存Task Contract IDではbranch、lock、path制約、checks、stopIfをpre-flight表示する。自然言語goalでは従来どおりdraft artifactsを生成する。 | 実装済み |
| `packet --task <id> --tiny` | 新規 alias。50行以内の Tiny Packet を出力する。 | 実装済み |
| `finish --task <id>` | 新規 alias。`evidence collect --force` の後に `check-diff` を実行する。 | 実装済み |
| `block "reason" --task <id>` | `ai block --task <id> --reason <reason>` の alias。 | 実装済み |
| `request-approval --task <id>` | `approval request` の alias。 | 実装済み |
| `approve --task <id>` | `approval approve` の alias。 | 実装済み |
| `next` | 既存 `next` を継続利用する。 | 実装済み |

## 後方互換

現行の長いコマンドは削除しない。
Core 短縮コマンドは、人間とAIの操作面を薄くするための入口であり、既存自動化や過去の Evidence / Approval / Task Contract を壊さない。

既存の Task Contract、Evidence、Approval は現行の読込層で引き続き読み込む。
互換性の確認は `npm test`、`npm run typecheck`、`npm run build`、`npm run scwbs -- check` で行う。
