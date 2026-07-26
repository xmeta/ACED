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

現行 ACED CLI では Core alias と詳細コマンドの両方を使える。実作業では必ず npm script 経由で実行する。

AI が使ってよい最小フロー:

```bash
npm run scwbs -- next
npm run scwbs -- start <goal>
npm run scwbs -- packet --task <task-id>
npm run scwbs -- finish --task <task-id>
npm run scwbs -- block "Human Gate required" --task <task-id>
```

追加文脈が必要な場合だけ、詳細 packet を補助的に使う。

```bash
npm run scwbs -- ai packet --task <task-id> --relation-depth 1
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

WBS正本 (`contracts/wbs/project.wbs.json`) は直接編集してはならない。変更は必ず `contracts/changesets/*.json` 経由で行い、`npm run scwbs -- wbs apply contracts/changesets/<file> --force --output contracts/wbs/project.wbs.json` で適用する。`scwbs check` / `scwbs check-diff` は対応する changeset がないWBS直接編集を `wbs.changeset.required` で fail させる。

Human Approval は人間専用である。AI は `request-approval` までに留め、`approve` / `approval approve` を実行して `approved` record を作ってはいけない。例外は、Task開始前からauthority baselineに固定された `approvalPolicy.mode: delegated` が要求scope（`human-gate` または `post-finish`）を許可し、有効期限内かつ32 bytes以上の `SCWBS_APPROVAL_DELEGATION_TOKEN` が契約のhashと一致する場合に、`--actor delegated-ai --scope <scope>` でdelegated Approvalを作成するときだけである。AIは `--actor human` を使用してはならず、policyやscopeをTask開始後に追加・拡張してはならない。

CI が通るまでマージしてはいけない。通常のmain向けmergeは
`npm run scwbs -- merge --pr <number>` を使う。このcommandはopen・non-draft・
base main・mergeableなPRとaggregate `validate` のSUCCESSを検査し、検証した
head SHAを `--match-head-commit` へ渡す。pending / failure / cancelled /
missing / unknownはfail closedで拒否する。`gh pr merge` の直接実行、`--admin`、
`--auto` は通常経路として使ってはいけない。

現在のprivate repository planではGitHub branch protection / rulesetsを利用
できないため、このcommandはdirect push、force push、管理者やAPIによる迂回を
GitHub側で禁止しない。repository visibility・GitHub plan・外部費用・権限の
変更はHuman Decisionであり、AIが実行してはいけない。

## 作業開始時

1. 対象 Task Contract を読む。
2. `branchName`、`allowedPaths`、`forbiddenPaths`、`humanGateRequiredPaths`、`requiredChecks`、`doneCriteria` を確認する。
3. 現在 branch が Task Contract の `branchName` と一致しているか確認する。
4. まず Task Contract を優先コンテキストとして扱う。
5. 追加文脈が必要な場合は、まず `npm run scwbs -- packet --task <task-id>` を使い、それでも不足する場合だけ `npm run scwbs -- ai packet --task <task-id> --relation-depth 1` を使う。
6. 不足情報がある場合でも、推測で危険変更を進めてはいけない。

## 新規 Task Contract を start する場合

1. `npm run scwbs -- start <goal>`
2. 生成された draft 契約を最小の `allowedPaths` に引き締め、SPEC-LITE の `acceptanceCriteria` を具体化して `status: approved`・`approvedBy` を記入する
3. WBS 新規ノードは既定で作らず、既存ノード（例: `node-governance-maintenance`）を `wbsNodeId` に再利用する。`start` が生成した changeset は apply せず削除し、`managedContractPaths` からも外す。新規ノードが真に必要な場合のみ changeset を apply し、既存の code と重複しない一意の階層番号を設定する（`start` は code 固定 `"draft"` を生成し `wbs.code.duplicate` になる既知問題、Issue #267）
4. `npm run scwbs -- registry rebuild --force` で SPEC-LITE を registry に索引する
5. `npm run scwbs -- task lock --task <task-id>` で contractLock v2 を付与する。**registry rebuild より先に lock してはならない**（task lock は registry 経由で SPEC を解決するため、先に lock すると specRevision が欠落し finish 時に `contractLock.stale` でブロックされる）
6. managed ファイルのみ（`contracts/tasks/<id>.yaml`、`contracts/specs/SPEC-LITE-<id>.yaml`、`contracts/registry.yaml`、必要なら `contracts/tasks/index.yaml`）の契約作成コミットを作る。WBS 正本・changeset・実装ファイルを混ぜない（混ぜると `check-diff` の task-authority 検査で fail する）
7. 作成コミット後は `allowedPaths` / `managedContractPaths` 等の authority フィールドを変更しない（`diff.taskAuthority.change` で fail する）。変更が必要な場合は block して人間に確認する

## 実装中の停止条件

次のいずれかに該当する場合、実装を続けず `npm run scwbs -- block "<reason>" --task <task-id>` を使う。

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

作業後は手書きの完了報告だけで終えず、`finish` で Evidence 収集・差分検査・registry チェックを一括実行する。

```bash
npm run scwbs -- finish --task <task-id>
```

`finish` は以下の処理を自動で行う。
- requiredChecks 実行
- Evidence 更新
- check-diff（allowedPaths/forbiddenPaths/humanGatePaths 検査）
- registry 整合性チェック
  - Human Gate 検出と次アクション表示

- `evidence collect` / `request-approval` / `approval approve`（status 変更）は registry を失陥させる。push 前に `npm run scwbs -- registry rebuild --force`（または `--check` で確認）しないと CI の Registry check が fail する（Issue #266）
- PR 作成後は `npm run scwbs -- evidence collect --task <task-id> --force --pull-request <num>` で Evidence に PR metadata を記録する（自動検出は未実装、Issue #268）
- 推奨順序: コード変更 commit → `evidence collect --force` → PR 作成 → `evidence collect --force --pull-request <num>` → `registry rebuild --force` → commit・push → `request-approval` で停止 → 人間が approve → `registry rebuild --force` → `finish` → push → CI 確認 → マージ
- テストを変更した Task では `finish` が testQuality metadata（`--test-assertions-added` / `--tests-disabled` / `--coverage-decreased` / `--test-quality-note`）を要求する。提示される fixCommand に従って再実行する

`finish` 後に追加コミットや差分変更をした場合は、再度 `finish` を実行する。AIは、有効な `post-finish` scopeのdelegated policyとtokenが揃う場合だけ、最終Evidence scopeに対して `--actor delegated-ai --scope post-finish` でApprovalを作成できる。それ以外では勝手にApprovalをapprovedにしてはいけない。

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
