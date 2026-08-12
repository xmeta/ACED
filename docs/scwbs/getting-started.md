# scwbs入門

このpageはrepository contributor向けのadvanced troubleshooting guideである。first-use consumer pathでは、installed CLIとfinish-first workflowを使う[Consumer Quickstart](quickstart.md)から始める。Contributor setupは[`CONTRIBUTING.md`](../../CONTRIBUTING.md)に別途記載する。

## メンタルモデル

SC-WBS workには3つのlayerがある。

1. **Task Contract**: 何を変更してよいか。
2. **Evidence**: 何が変更され、どのcheckを実行したか。
3. **Diff guard**: branchがcontractと一致しているか。

AIはcontract内をimplementできるが、work開始後にcontractのscopeを自分で決めてはならない。

## 高度なrepository設定

以下のcommandはACED checkoutを前提とし、contributor、debugging、maintenance向けに残している。release tarballを使うconsumerには必要ない。

Node.js `>=22.13.0`とnpm `>=10`を使う。このrepositoryは`packageManager`でnpm `10.9.0`をpinするため、dependenciesのinstall前にCorepackをenableする。

dependenciesを一度installする。

```bash
corepack enable
corepack npm install
```

repository healthを確認する。

```bash
npm run scwbs -- check
```

GitHub連携を使う前に、必要な read-only capability だけを確認できます。
これは認証や権限を自動変更せず、GitHub が使えない環境でもローカル作業を
妨げません。

```bash
npm run scwbs -- doctor --github
npm run scwbs -- doctor --github --json
```

`gh` CLI、認証、`origin`、repository/PR/Actions の読み取り可否を確認し、
不足している項目には限定された診断メッセージを返します。merge の事前確認や
Metrics が GitHub 情報を取得できない場合も、このコマンドを案内します。

attentionが必要な項目を確認する。

```bash
npm run scwbs -- next
```

不明な場合は、Git statusだけから推測せず`next`を優先する。

## 小さなTaskを作成する

docs-only changeの場合:

```bash
npm run scwbs -- task new "Improve user docs" --paths "README.md,docs/scwbs/getting-started.md" --stop "source change required"
```

code-and-test changeの場合:

```bash
npm run scwbs -- task new "Fix parser edge case" --paths "src/core/parser.ts,tests/unit/parser.test.ts" --stop "schema or dependency change required"
```

`--paths` を省略すると `allowedPaths: []` のdraftになり、実装を認可しません。`--wbs-node` を省略したTaskはWBS-lessとして保存され、WBS completion queueには入りません。Stop Conditionsを意図的に空にする場合は `--no-stop-conditions` を明示してください。

commandはTask Contractを表示する。次のfieldを確認する。

- `id`: 後続の`scwbs` commandへ渡す値。
- `branchName`: このexact branch nameを使う。
- `allowedPaths`: 変更してよいfile。
- `forbiddenPaths`: 変更してはならないfile。
- `humanGateRequiredPaths`: 変更前にhuman approvalが必要なfile。
- `requiredChecks`: completion前に期待されるcheck。

Task branchへ切り替える。

```bash
git switch -c <branchName>
```

Taskを開始する。

```bash
npm run scwbs -- task start <task-id>
```

branch statusが`mismatch`なら、fileをeditする前にbranchを修正する。

## AIにworkを渡す

AIにはこのminimum contextを渡す。

```text
AGENTS.md
contracts/tasks/<task-id>.yaml
```

AIにmore contextが必要ならpacketを生成する。

```bash
npm run scwbs -- packet --task <task-id> --tiny
```

deeper contextの場合:

```bash
npm run scwbs -- ai packet --task <task-id> --relation-depth 1
```

methodologyまたはCLI自体を変更する場合を除き、AIに全docsを読むよう求めない。

## Scope内で作業する

edit前にplanned fileを`allowedPaths`と比較する。

changeに`allowedPaths`外のfileが必要なら、先にeditしてはならない。new taskを作成するか、明示的なSC-WBS taskを通してTask Contractをupdateする。

changeが`humanGateRequiredPaths`に触れるならstopしてhuman approvalをrequestする。self-approveしてはならない。

changeにDB schema change、migration、authentication redesign、permission change、breaking API change、external service decision、release decision、unclear business ruleが必要なら、推測せずblockする。

```bash
npm run scwbs -- ai block --task <task-id> --reason "Human Gate required"
```

可能な場合はよりspecificなreasonを使う。

## Taskをfinishする

Task Contractに列挙されたcheckを実行する。多くのtaskは次を使う。

```bash
npm test
npm run typecheck
npm run build
```

SC-WBS checkを実行する。

```bash
npm run scwbs -- check
npm run scwbs -- registry rebuild --check
```

Evidenceにfinal branch diffを記述させる場合は、先にimplementation changeをcommitする。

```bash
git add <changed-files>
git commit -m "<short description>"
```

Evidenceをcollectする。

```bash
npm run scwbs -- evidence collect --task <task-id>
```

docs-only workではtest assertionが変更されていないことを記録する。

```bash
npm run scwbs -- evidence collect --task <task-id> \
  --test-assertions-added false \
  --tests-disabled false \
  --coverage-decreased false \
  --test-quality-note "Docs-only change; no test assertions changed."
```

Evidence追加後にregistryがstaleになった場合:

```bash
npm run scwbs -- registry rebuild --force
npm run scwbs -- registry rebuild --check
```

Evidenceとregistry updateをcommitする。

```bash
git add contracts/evidence/<task-id>.yaml contracts/registry.yaml
git commit -m "chore: add evidence for <task>"
```

最後に:

```bash
npm run scwbs -- check-diff --task <task-id>
```

Evidence collection後にimplementation changeを追加commitした場合は、Evidenceを再生成する。

## ReviewとPR

PRを開く前に確認する。

```bash
git status --short --branch
npm run scwbs -- check-diff --task <task-id>
```

PRが存在し、workflowがPR metadataを必要とする場合はPR number付きでEvidenceをrefreshする。

```bash
npm run scwbs -- evidence collect --task <task-id> --pull-request "#123" --force
```

human reviewerが明示的にapproveしない限りApprovalをapprovedにしない。

## よくあるmistake

| Mistake | 代わりにすること |
|---|---|
| Task Contractを読む前にeditする | 先に`contracts/tasks/<task-id>.yaml`を読む |
| `allowedPaths`外のfileを変更する | stopしてcontractをcreate/updateする |
| `docs/sc-wbs-core-revision/`をcurrent ruleとして扱う | draft designとして扱う |
| 複数の`npm run scwbs` commandをparallel実行する | SC-WBS commandをserial実行する |
| final implementation commit前にEvidenceをcollectする | 先にcommitし、その後Evidenceをcollectする |
| Human Gateをself-approveする | 代わりにhuman reviewをrequestする |
