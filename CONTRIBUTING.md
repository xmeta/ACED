# scwbsへの貢献

このリポジトリは、GitHub IssueとSC-WBSのTask Contractを使って変更を追跡します。小さな修正でも、まず既存Issueと重複しないか確認し、変更の目的・影響範囲・検証結果をIssueまたはPull Requestに記載してください。

## Issueを登録する

次の情報を短くまとめてください。

- 何が起きたか、または何を改善したいか
- 再現手順、期待する結果、実際の結果（不具合の場合）
- 影響する利用者・コマンド・ファイル
- 既存Issueや関連PRへのリンク
- 提案する解決策がある場合は、非目標と停止条件

Issueを登録する前に、タイトルや本文のキーワードでopen Issueとopen PRを検索してください。ラベルは既存の分類（`bug`、`enhancement`、`documentation`、`priority:*`など）を参考にし、最終的な分類はメンテナーが行います。

## 変更の種類とTask Contract

- typoの修正や、既存の意味を変えない小さな文書修正は、Issueで対象と意図を示したうえで通常のPull Requestとして提案できます。
- CLI、TypeScript、テスト、依存関係、ワークフロー、Task Contract、Evidence、Registry、WBSに関わる変更は、Task Contractを作成してから着手してください。最小例は次のとおりです。

  ```bash
  npm run scwbs -- task new "変更の目的" --paths "README.md,docs/scwbs/example.md" --stop "source or schema change required"
  ```

- `allowedPaths`の外側や`forbiddenPaths`にあるファイルを、作業中の判断だけで変更しないでください。WBS正本（`contracts/wbs/project.wbs.json`）は直接編集せず、承認されたchangeset経由で扱います。
- AIエージェントに作業を依頼する場合は、Task ContractをGround Truthとして渡してください。AIはHuman Approvalを代行できません。

## 利用者向け packed artifact の確認

配布境界を確認する場合は、リポジトリを consumer の実行時依存にせず、
次のように tarball を作成して空の一時プロジェクトへ install します。

```bash
corepack npm run build
npm pack
mkdir /tmp/scwbs-consumer
cd /tmp/scwbs-consumer
npm init -y
npm install --save-dev /path/to/scwbs-0.1.0.tgz
npx scwbs --version
```

packed artifact には WJS validator、apply runtime、schema が含まれます。
GitHub Release の self-contained tarball を作る場合は、リポジトリ root で
`npm pack` を実行し、`node scripts/distribution-smoke.mjs` と同じ smoke
条件を満たすことを確認します。npmjs.com への公開はこのリポジトリの
配布方針に含めません。通常の contributor checkout では従来通り下記の
submodule setup を使用します。

## ローカルセットアップ（contributor）

Node.js `>=22.12.0` と npm `>=10` を使用します。通常のclone後は、依存関係をインストールする前にWJS submoduleを初期化してください。

```bash
git submodule update --init --recursive wjs
corepack enable
corepack npm install
```

セットアップ診断には次を使います。

```bash
npm run scwbs -- doctor
npm run scwbs -- check
```

## Pull Request前の確認

変更内容に応じて、次のコマンドを上から順に実行してください。SC-WBS/npmのコマンドは同時実行せず、前の結果を確認してから次へ進みます。

```bash
npm test
npm run test:integration
npm run typecheck
npm run build
npm run scwbs -- check
npm run scwbs -- registry rebuild --check
```

文書だけを変更した場合も、該当する文書検証を実行してください。

```bash
npm run scwbs -- docs check
```

Pull Request本文には、関連Issue、変更理由、主な変更ファイル、実行した確認コマンドと結果を記載してください。無関係な変更、生成物、秘密情報を混ぜないでください。

## Reviewとmerge

Human Gate対象の変更は、人間が現在の差分とEvidenceを確認してから進めます。AIや自動化が人間の承認を作成してはいけません。`--actor human`、`approval approve`、GitHubのApprove操作をAIに実行させないでください。

CIのaggregate `validate` が現在のPR headで成功し、PRがreadyになった後の通常のmergeは、メンテナーが次のSC-WBS経路で行います。

```bash
npm run scwbs -- merge --pr <number>
```

このコマンドはPRのbaseが`main`であること、merge可能であること、現在のheadに対する`validate`成功を確認します。CI未完了・失敗・対象不明の状態ではmergeしません。

## 参照先

- [Contributor/advanced Getting Started](docs/scwbs/getting-started.md)
- [利用者向けConsumer Quickstart](docs/scwbs/quickstart.md)
- [AIエージェント向けガイド](docs/scwbs/ai-agent-guide.md)
- [リポジトリ固有の実行ルール](AGENTS.md)
- [CLIのリファレンス](docs/scwbs/cli-reference.md)
