# ACED文書マップ

この文書は、目的に応じた文書群の選び方を日本語で示す標準ナビゲーション入口である。

Status: current navigation entrypoint。

このファイルは、読むべきdocument setを選ぶ最初の入口である。`docs/`配下のすべてのdirectoryを同じcurrent documentとして扱ってはならない。各setのmachine-readable statusとCLI applicabilityは`document-lifecycle.json`に記録し、`npm run scwbs -- docs check`で検証する。

## Source of truthの優先順

このrepositoryで実作業を行う場合は、次の順序を使う。

1. `AGENTS.md`とactive `contracts/tasks/<task-id>.yaml`
2. `README.md` and `docs/sc-wbs-core/00-index.md`
3. active Task ContractまたはWork Packetが指定するtask-specific file

実装中にこれらが食い違う場合は、active Task Contractと`AGENTS.md`を優先する。

## 文書セット

| Path | Status | 用途 |
|---|---|---|
| `../README.md` | current | リポジトリ概要、quick start、最上位の正本ルール。 |
| `../AGENTS.md` | current | リポジトリ固有のAI運用ルール。 |
| `sc-wbs-core/` | current | 現行SC-WBS Coreの概念と目標方針。 |
| `scwbs/` | legacy reference | 詳細なSC-WBS手法とCLIリファレンス。現行文書またはTaskが指す場合に使う。 |
| `sc-wbs-core-revision/` | proposal | 将来のCore変更に向けた改訂案。現行実行ルールではない。 |

lifecycle vocabularyは`normative`、`informative`、`proposal`、`deprecated`、`superseded`である。Deprecatedとsupersededのsetはmanifestでsuccessorを指定しなければならない。Standard execution entrypointはcurrentのまま維持する。

## AIの読解経路

Implementation agentは必要最小限のcontextだけを読む。

```text
AGENTS.md
contracts/tasks/<task-id>.yaml
docs/README.md
target files named by the task
```

Task Contractのcontextが不足する場合だけ、`npm run scwbs -- ai packet --task <task-id> --relation-depth 1`を使う。

`packet --context-json`は既定でproposal、deprecated、superseded document setを除外する。taskがhistoricalまたはproposal contextを明示的に必要とする場合だけ`--context-include-noncurrent-docs`を使う。このnavigation filterはTask Contractのedit authorityを変更しない。

## Legacyとproposalの境界

`docs/scwbs/`はdetailed referenceとして有用だが、current Core workのfirst sourceではないlegacyまたはfuller SC-WBS operationを記述する場合がある。

`docs/sc-wbs-core-revision/`にはproposed changeを含む。proposalがcurrentになるのは、Task Contractで対象化され、current docs、implementation、Evidence、checkへ反映された後だけである。
