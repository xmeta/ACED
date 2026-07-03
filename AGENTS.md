# AGENTS.md - SC-WBS Core Agent Instructions

このリポジトリは `scwbs` TypeScript CLI の実装リポジトリであり、同時に `contracts/` 配下の Task Contract で自己管理されている。

AI は SC-WBS Core の作業ガードレールに従う。Core の詳細は `docs/sc-wbs-core/`、既存の詳細仕様は `docs/scwbs/` と `docs/sc-wbs-development.md` を参照する。

## 最重要ルール

```text
契約されていない作業をしてはいけない。
allowedPaths 外を変更してはいけない。
forbiddenPaths は allowedPaths より常に優先する。
危険変更が必要になったら実装を続けず block する。
Done は自己申告ではなく Evidence / check-diff / required checks で判断する。
```

## 現行 ACED で使うコマンド

Core 文書では将来の短縮形として `scwbs finish` や `scwbs packet --tiny` を定義している。現行実装で作業するときは、次の npm script 経由コマンドを使う。

```bash
npm run scwbs -- next
npm run scwbs -- start <goal>
npm run scwbs -- ai packet --task <task-id> --relation-depth 1
npm run scwbs -- evidence collect --task <task-id>
npm run scwbs -- check-diff --task <task-id>
npm run scwbs -- ai block --task <task-id> --reason "Human Gate required"
```

通常の検証:

```bash
npm test
npm run typecheck
npm run build
npm run scwbs -- check
npm run scwbs -- registry rebuild --check
```

YAML/JSONを直接編集してはならない。ただし、ユーザーが明示的に「スキーマや仕様の実装」または「Task Contract / Evidence / registry の更新」を依頼した場合は、その契約範囲内でのみ編集してよい。

## 作業開始時

1. 対象 Task Contract を読む。
2. `branchName`、`allowedPaths`、`forbiddenPaths`、`humanGateRequiredPaths`、`requiredChecks`、`doneCriteria` を確認する。
3. 現在 branch が Task Contract の `branchName` と一致しているか確認する。
4. 必要なら `npm run scwbs -- ai packet --task <task-id> --relation-depth 1` を優先コンテキストとして扱う。
5. 不足情報がある場合でも、推測で危険変更を進めてはいけない。

## 実装中の停止条件

次のいずれかに該当する場合、実装を続けず `npm run scwbs -- ai block --task <task-id> --reason "<reason>"` を使う。

- DBスキーマ変更が必要
- migration追加が必要
- 認証・権限設計の変更が必要
- APIの破壊的変更が必要
- 業務ルールが不足している
- 個人情報・セキュリティ設定に影響する
- 外部サービス連携・課金・リリース判断に影響する
- allowedPaths 外の変更が必要
- humanGateRequiredPaths に触る必要がある
- 仕様変更レベルの判断に迷う

## 完了時

作業後は手書きの完了報告だけで終えず、現行 CLI で Evidence と差分検査を通す。

```bash
npm run scwbs -- evidence collect --task <task-id>
npm run scwbs -- check-diff --task <task-id>
```

Evidence 生成後に追加コミットや差分変更をした場合は、Evidence を再生成する。勝手に Approval を approved にしてはいけない。

## レビュー時

レビューAIは、実装者の説明を Ground Truth にしてはいけない。
Ground Truth は次だけである。

- Task Contract
- Packet
- Spec Slice / Acceptance Criteria
- 実際の差分
- Evidence
- Approval scope

疑わしい場合は approve せず、`changes_requested` または `needs_human_decision` とする。
