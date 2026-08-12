# 06. Human Gateと停止条件

Human Gate は、人間の責任判断が必要な変更をAIが勝手に進めないための仕組みである。

## Gate種別

Human Gate は3種類に分ける。

| gateType | 意味 | 例 |
|---|---|---|
| `preImplementation` | 実装前に必要な承認 | DB設計変更、権限設計変更、破壊的API変更 |
| `completion` | Doneに進める承認 | PRレビュー後の完了承認 |
| `release` | リリース判断 | 本番反映、顧客影響のある公開 |

これらを混ぜない。

## Stop Conditions

AIは次の条件に該当したら、実装を止める。

```text
- DBスキーマ変更が必要
- migration追加が必要
- 認証方式の変更が必要
- 権限設計の変更が必要
- APIの破壊的変更が必要
- 業務ルールが不足している
- 個人情報の扱いが変わる
- セキュリティ設定が変わる
- 外部サービス連携が必要
- 課金・決済に関係する
- リリース判断が必要
- スコープ、納期、予算に影響する
- allowedPaths 外の変更が必要
- humanGateRequiredPaths に触る必要がある
- 仕様変更レベルの判断に迷う
```

## AIの停止動作

AIは危険変更を発見したら、長文説明を書いて作業継続しない。
次を実行する。

```bash
scwbs block "DBスキーマ変更が必要"
```

`scwbs block` は、必要に応じて次を生成する。

```text
contracts/blocks/<task-id>.yaml
contracts/spec-changes/<id>.yaml
contracts/approvals/<task-id>.yaml の requested record
WBS blocked changeset
```

## Level 0 / 1 / 2 の整理

仕様変更レベルは次のように扱う。

| Level | 意味 | AIの扱い |
|---|---|---|
| Level 0 | 既存Spec内で一意に決まる補完 | 実装可。Evidenceに記録 |
| Level 1 | Specの意図に沿う小さな補足 | 実装ブランチ上で提案可。ただしcompleted前にReview/承認 |
| Level 2 | Specから一意に導けない変更 | 実装前に停止。Human Gate必須 |

迷う場合は Level 2 として扱う。

## API変更の扱い

| 変更 | 扱い |
|---|---|
| 内部実装のみの変更 | Level 0可 |
| 後方互換なAPI追加 | Level 1。Spec Change ProposalとReviewが必要 |
| 破壊的API変更 | Level 2。preImplementation Gate必須 |

## Approvalの作成権限

AIは `requested` record を作ってよい。
AIは `approved` record を作ってはいけない。

```bash
scwbs request-approval WBS-001 --reason "DB schema change required"
```

人間だけが次を実行できる。

```bash
scwbs approve WBS-001 --pr 42 --reason "レビュー済み"
```
