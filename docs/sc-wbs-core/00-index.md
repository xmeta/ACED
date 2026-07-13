# 00. SC-WBS Core Index

Status: current Core reference.

このディレクトリは、SC-WBS を軽量な AI 作業ガードレールとして運用するための Core 文書群である。

## 文書の位置づけ

この文書群は、現行 ACED CLI に導入済みの考え方と、Core の目標形をまとめた基準文書である。
ただし、`docs/sc-wbs-core-revision/` がある場合、そこにある内容は次期改訂案として扱う。

優先順位は次の通りである。

```text
1. 現行作業の実行ルール: AGENTS.md と対象 Task Contract
2. 文書入口と正本関係: README.md と docs/README.md
3. 現行Coreの基準説明: docs/sc-wbs-core/
4. 詳細・legacy参照: docs/scwbs/
5. 次期Core改訂案: docs/sc-wbs-core-revision/
```

`docs/sc-wbs-core-revision/` は、この文書群を即時に置き換えるものではない。
改訂案の内容は、Task Contract、実装、Evidence、check-diff が揃った時点で現行Coreへ反映する。

## 現行実装との関係

この文書群は Core/Lite 方針の現行基準説明と target spec を含む。現行 ACED CLI では `task new`、`packet --tiny`、`finish`、`block`、`request-approval`、`approve` などの Core alias が実装されている。実作業では必ず `npm run scwbs -- <command>` の形で実行する。

このリポジトリで実作業を行うAIは、まず `AGENTS.md` と対象 Task Contract を読む。追加文脈が必要な場合だけ `npm run scwbs -- ai packet` を使い、完了判定は `npm run scwbs -- finish` に委ねる。

## この文書群の目的

既存の SC-WBS は、WBS-JSON、Task Contract、Evidence、Human Gate、Review、Approval、Registry、Health などを扱う。これは大規模運用には有効だが、AIに読ませる文脈が大きくなりやすい。

Core は「方法論を全部読む仕組み」ではなく、「AIに渡す文脈を削り、差分で逸脱を止めるガードレールCLI」として定義する。

SC-WBS Core では、次の目的に絞る。

1. AIに渡す作業コンテキストを小さくする。
2. AIが変更してよい範囲を明確にする。
3. 範囲外変更を `check-diff` で機械的に止める。
4. 完了判定を自己申告ではなく Evidence で行う。
5. 危険変更は Human Gate に戻す。

## 文書一覧

| ファイル | 役割 |
|---|---|
| `01-core-principles.md` | Core の原則、非目的、Full版との関係 |
| `02-command-first-workflow.md` | 人間/AIが使う短いコマンド中心の運用 |
| `03-minimal-artifacts.md` | 内部生成物としての Task/Evidence/Approval/Block |
| `04-ai-work-packet.md` | Tiny/Normal/Deep Packet とコンテキスト制御 |
| `05-diff-evidence-approval.md` | diffHash、subjectHeadCommit、承認スコープ（headCommit/diffHash）のルール |
| `06-human-gate.md` | Stop Conditions と Gate 種別 |
| `07-cli-core-spec.md` | Core CLI のコマンド仕様 |
| `08-migration-plan.md` | 既存SC-WBSからCoreへ反映する手順 |
| `09-implementation-backlog.md` | 実装タスク候補と優先順位 |
| `10-decisions.md` | これまでの議論から採用した設計判断 |

## Core 改訂作業の入口

SC-WBS Core 改訂の進捗確認は、リポジトリルートの `CHECKLIST.md` を入口にする。
詳細な改訂文書群は `docs/sc-wbs-core-revision/` に置き、進捗の詳細チェックリストは `docs/sc-wbs-core-revision/10-progress-checklist.md` を正とする。
旧Core文書と改訂文書が異なる場合は、改訂文書を「未反映の設計案」として扱い、現行作業では `AGENTS.md` の実装済みコマンドを優先する。

## AIに読ませる範囲

AIにこの文書群全体を読ませない。通常の実装AIには、以下だけを渡す。

```text
AGENTS.md
Task Contract
scwbs packet --tiny の出力
必要な対象ファイル
```

現行 ACED では `packet --tiny` を最小カードとして使える。追加情報が必要になった場合だけ `ai packet` を補助的に使う。

ツールを実装するAIには、必要に応じて `07-cli-core-spec.md` と `03-minimal-artifacts.md` を渡す。

## Core と Full の関係

```text
SC-WBS Core = Task Contract + Packet + Diff Guard + Evidence + Human Gate
SC-WBS Full = Core + WBS-JSON + Registry + Review Queue + Traceability + Risk Register + Audit Log
```

Core は Full を否定しない。Core は最初に導入する最小カーネルであり、必要になった段階で Full の要素を追加する。

## 導入段階

```text
Phase 1: Task Contract + Evidence + check-diff + Human Gate
Phase 2: tasks/index.yaml などの軽い索引
Phase 3: WBS-JSON + Registry + Review Queue などの Full 機能
```
