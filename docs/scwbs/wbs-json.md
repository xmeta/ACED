# SC-WBS WBS-JSON Operations

Source: docs/sc-wbs-development.md split reference.

## 5. WBS-JSON運用

WBS-JSONでは、`nodes[]` がWBS階層の正本である。

SC-WBSでは主に以下を使う。

| WBS-JSON要素 | SC-WBSでの意味 |
|---|---|
| `nodes[]` | 作業、成果物、マイルストーン |
| `nodes[].status` | WBS上の状態 |
| `nodes[].outputs` | その作業が生成する成果物 |
| `relations[].dependsOn` | 依存関係 |
| `relations[].blocks` | ブロッカー関係 |
| `relations[].implementsRequirement` | 要求との関連 |
| `artifacts[]` | Spec、ADR、Evidence、ソースなどの成果物参照 |
| `resources[]` | Human、AI Agent、チーム、担当ロール |
| `extensions.scwbs` | SC-WBS固有の補足情報 |

WBSを変更するとき、AIは原則としてWBS全体を再生成してはならない。

AIがWBS変更を提案する場合は、`wjs` のsemantic operationsを使い、`dryRun: true` のchange setとして提出する。

例:

```json
{
  "schemaVersion": "0.1.0",
  "targetWbsId": "scwbs-project",
  "changeSetId": "changeset-add-api-task",
  "author": "ai-agent",
  "reason": "Add API implementation task",
  "dryRun": true,
  "operations": [
    {
      "operation": "addNode",
      "node": {
        "id": "node-api-implementation",
        "parentId": "node-project",
        "code": "1.1",
        "name": "API Implementation",
        "type": "workPackage",
        "status": "planned"
      },
      "position": {
        "mode": "last"
      }
    }
  ]
}
```

変更内容を確認するには以下を実行する。

```bash
npm run scwbs -- wbs apply change-set.json
```

change set自体は、WBSへ適用する前に `wjs` のoperations schemaで検証する。
詳細な運用手順は `docs/scwbs/wjs-operations-validation.md` を参照する。

```bash
npm --prefix wjs run validate -- --operations ../contracts/changesets/change-set.json
```

WBS本体も、`wjs` のvalidate toolを正規の検証手段として扱う。

```bash
npm --prefix wjs run validate -- ../contracts/wbs/project.wbs.json
npm run scwbs -- wbs validate
```

`scwbs wbs validate` と `scwbs check` は、内部で `wjs/tools/validate.ts --wbs` を使ってWBS-JSON schemaとsemantic validationを確認する。
`scwbs check-diff` は、`contracts/wbs/project.wbs.json` が変更されているのに `contracts/changesets/*.json` がない場合はErrorとし、change setがある場合は `wjs/tools/validate.ts --operations` で検証する。

`dryRun: true` のchange setは、結果を確認するためのプレビューとして扱う。

実際に書き込む場合は、Taskの運用policyでHuman Gateが必要かを先に判断し、適用が許可されたchangesetだけに明示的な `--force --output contracts/wbs/project.wbs.json` を使う。現行 `wbs apply` はTask IDやApproval recordを入力に取らないため、Human Gateを一律に自動検証するcommandではない。機械強制が必要なTaskでは、Task開始前から `contracts/wbs/project.wbs.json` を `humanGateRequiredPaths` に含める。

---
