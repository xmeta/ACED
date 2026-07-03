# 00. SC-WBS Core Index

このディレクトリは、SC-WBS を軽量な AI 作業ガードレールとして運用するための正本候補である。

## 現行実装との関係

この文書群は Core/Lite 方針の正本候補と target spec を含む。`scwbs task new`、`scwbs packet --tiny`、`scwbs finish`、`scwbs block` のような短縮コマンドは Core の目標形であり、現行 ACED CLI ではまだ同名で実装されていないものがある。

このリポジトリで実作業を行うAIは、まず `AGENTS.md` と対象 Task Contract を読み、現行コマンドとして `npm run scwbs -- ai packet`、`npm run scwbs -- evidence collect`、`npm run scwbs -- check-diff` を使う。

## この文書群の目的

既存の SC-WBS は、WBS-JSON、Task Contract、Evidence、Human Gate、Review、Approval、Registry、Health などを扱う。これは大規模運用には有効だが、AIに読ませる文脈が大きくなりやすい。

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
| `05-diff-evidence-approval.md` | diffHash、subjectHeadCommit、承認scopeのルール |
| `06-human-gate.md` | Stop Conditions と Gate 種別 |
| `07-cli-core-spec.md` | Core CLI のコマンド仕様 |
| `08-migration-plan.md` | 既存SC-WBSからCoreへ反映する手順 |
| `09-implementation-backlog.md` | 実装タスク候補と優先順位 |
| `10-decisions.md` | これまでの議論から採用した設計判断 |

## AIに読ませる範囲

AIにこの文書群全体を読ませない。通常の実装AIには、以下だけを渡す。

```text
AGENTS.md
scwbs packet --tiny の出力
必要な対象ファイル
```

ツールを実装するAIには、必要に応じて `07-cli-core-spec.md` と `03-minimal-artifacts.md` を渡す。

## Core と Full の関係

```text
SC-WBS Core = Task Contract + Packet + Diff Guard + Evidence + Human Gate
SC-WBS Full = Core + WBS-JSON + Registry + Review Queue + Traceability + Risk Register + Audit Log
```

Core は Full を否定しない。Core は最初に導入する最小カーネルであり、必要になった段階で Full の要素を追加する。
