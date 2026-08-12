# scwbs CLIリファレンス

このfileはACEDにbundledされた`scwbs` CLI（package name `scwbs`）のdetailed command indexである。command exampleが増えた場合も`README.md`は短く保ち、ここへlinkする。

実行時はnpm scriptを経由する。

```bash
npm run scwbs -- --help
```

> **表記規約（Conventions）**
>
> - 説明文は日本語、コマンド名・オプション名・フィールド名・コード例は英語のまま記載する。
> - Task IDの例は本ドキュメント全体で `SCWBS-*` 形式に統一する（理由は「Task IDとブランチ命名」を参照）。従来この文書には `WBS-001-004` のような例が混在していたが、これは実装が生成する正規のID形式ではない。
> - コマンドが**変更するもの**（tracked files / git common dir / network）は「Mutation / Read-only 一覧」で分類する。
> - 終了コードは「終了コード」の節にある実装済みの値だけを記載する。文書化されていない終了コードは存在しないものとして扱う。

## Mutation / Read-onlyの一覧

各コマンドが完了後に何を残すかは、AIエージェントによる自動運用でも人間の運用でも重要な情報である。「read-only」を一律に扱うと `health` のようにtracked artifactは変えないがlocal metadataを書き込むコマンドを見落とすため、次の4分類を使う。全 `npm run scwbs -- ...` 呼び出しが実行中だけ作成し正常終了時に削除するcommand single-flight lockは、この永続side effect分類には含めない。

- **repository-content read-only**：tracked files・contracts配下のYAML・registryなど、コミット対象になり得るものを一切変更しない。
- **local-metadata write**：tracked artifactは変更しないが、git common dir配下へreceiptやwarning historyなど実行後も残るmetadataを書き込む。
- **tracked-artifact mutation**：contracts配下やregistryなど、コミット対象のfileを変更する。
- **external state read/write**：GitHub API等を読み取る、またはrepository外の状態を変更する。

| Command                                                                                                             | 分類                                                                            | 備考                                                                                               |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `check` / `docs check` / `check-diff` / `status`                                                                    | repository-content read-only                                                    | `status`もlocal receiptを書かない                                                                  |
| `next` / `review-queue` / `trace` / `ui`                                                                            | repository-content read-only                                                    | `ui`はtext dashboardをstdoutへ表示する                                                             |
| `packet` / `ai packet` / `ai run`                                                                                   | repository-content read-only                                                    | `ai run`はdry-run planを表示し、外部AIを起動しない                                                 |
| `ci plan` / `profile show`                                                                                          | repository-content read-only                                                    |                                                                                                    |
| `wbs validate` / `wbs candidates` / `wbs verify-changesets`                                                         | repository-content read-only                                                    | candidates/verifyもWBSを書かない                                                                   |
| `registry rebuild --check` / `task index rebuild --check`                                                           | repository-content read-only                                                    |                                                                                                    |
| `task refresh` / `completion apply`（`--apply`なし）                                                                | repository-content read-only                                                    | previewのみ                                                                                        |
| `health`（`--governance-cost`の有無を問わない）                                                                     | local-metadata write                                                            | active Task別health warning summaryをgit common dirへ保存する                                      |
| `metrics governance`                                                                                                | repository-content read-only + external state read                              | GitHub履歴をbounded取得するが永続artifactを作らない                                                |
| `checks run`                                                                                                        | local-metadata write                                                            | 全check成功時だけcheck receiptをgit common dirへ保存する                                           |
| `finish --preflight`                                                                                                | local-metadata write                                                            | required checksとtracked artifact更新は行わないが、finish lifecycle receiptを記録する              |
| `finish`                                                                                                            | tracked-artifact mutation + local-metadata write                                | Evidence payload/Evidence/Registryの置換、`scwbs-finish-lifecycle` receiptの記録                   |
| `evidence collect`                                                                                                  | tracked-artifact mutation + local-metadata write + optional external state read | Evidence payload、Evidence YAML、check receipt。PR未指定時はGitHubから候補を読む場合がある         |
| `evidence retain`                                                                                                   | tracked-artifact mutation + optional external state read                        | 既存Evidenceの検証済みpatch retentionを追加。`--fetch-pr-head`時だけrecorded PR head refを取得する |
| `evidence annotate`                                                                                                 | tracked-artifact mutation                                                       | 既存Evidenceの一部フィールドのみ更新                                                               |
| `init` / `fix` / `doctor --fix`                                                                                     | tracked-artifact mutation                                                       | `doctor`は`--fix`なしなら診断のみ。`--fix`は依存修復commandも実行する                              |
| `discovery new` / `discovery start` / `discovery conclude`                                                          | tracked-artifact mutation                                                       | Discovery Probe recordを作成・更新する                                                             |
| `block` / `block resolve` / `ai block`                                                                              | tracked-artifact mutation                                                       | Block、必要に応じSpec Change/changesetを更新する                                                   |
| `start <goal>` / `plan` / `lite task` / `promote`                                                                   | tracked-artifact mutation                                                       | 既存Task IDを指定した`start`だけはpreflight表示で書かない                                          |
| `registry rebuild --force` / `profile set`                                                                          | tracked-artifact mutation                                                       | `profile set`はchangesetを書き、WJS経由でWBSを更新する                                             |
| `task generate` / `task new` / `task lock` / `task archive` / `task refresh --apply` / `task index rebuild --force` | tracked-artifact mutation                                                       |                                                                                                    |
| `approval request` / `approval approve` / aliases                                                                   | tracked-artifact mutation                                                       |                                                                                                    |
| `approval delegation prepare`                                                                                       | repository-content read-only                                                    | policy patchとhandoffをstdoutへ出すだけで、Task Contractへ自動適用しない                           |
| `review request` / `review route` / `review approve` / `review changes-requested` / `review close`                  | tracked-artifact mutation                                                       | registryも同一操作内で同期する                                                                     |
| `completion apply --apply`                                                                                          | tracked-artifact mutation                                                       | changeset書き込み、WBS適用、registry再構築                                                         |
| `wbs apply`                                                                                                         | tracked-artifact mutation                                                       | `--output`で指定したWBSをWJS経由で更新する                                                         |
| `merge --preflight-only`                                                                                            | external state read                                                             | GitHub PR metadata/checksを読む                                                                    |
| `merge`                                                                                                             | external state read + external state write                                      | 検証後にGitHub PRをsquash mergeしhead branchを削除する                                             |
| `serve`                                                                                                             | 何もしない（stub）                                                              |                                                                                                    |
| `mcp --stdio`                                                                                                       | read-only resource。`finish`/`block`時はtracked-artifact mutation             | stdio上のMCP JSON-RPCのみ。Human-only operationは公開しない                                    |
| `index rebuild`                                                                                                     | tracked-artifact mutation（`.scwbs/cache`のみ）                                 | canonical artifactからderived SQLite cacheを再構築する                                             |
| `index status` / `index verify` / `query`                                                                           | repository-content read-only                                                    | stale/corrupt cacheはauthorityに使わず、query結果はbounded                                         |

## 終了コード

CLI自身の主要経路は次の終了コードを使う。Commanderが構文解析時に返す値と、各actionが明示的に返すvalidation結果は同一ではない。また `wbs apply` のように子processのstatusを伝播するcommandでは、子process固有の値を返し得るため、0/1/2だけと仮定してはならない。

| Exit code | 意味                                                                                                                                                                  |
| --------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|         0 | 成功。要求された処理が完了した、またはcheckが全てpassした。                                                                                                           |
|         1 | 失敗・ブロック。check失敗、検証エラー、Human Gate待ち、`status --strict`不整合に加え、Commanderが検出するunknown command/optionや必須argument欠落も通常この値を返す。 |
|         2 | action内でSC-WBSが明示検証する引数エラー。例: 必須 `--task` option欠落、無効なTask ID、無効な列挙値。                                                                 |

**Human Gate待ちも通常のcheck失敗も同じexit code 1になる**ことに注意すること。CI等でHuman Gate待ちだけを別扱いしたい場合は、exit codeではなく `--json` の `outcome`（例: `awaiting-human-approval`）フィールドで判定すること。

## buildの出力

build後に次を実行する。

```bash
npm run build
node dist/cli.js --help
```

## 関連ドキュメント

このファイルはコマンドの使い方（利用者が入力するもの・得られる出力・終了コード）に焦点を当てたリファレンスである。より詳しい内部設計は次を参照する。

- Profile（Lean/Standard/Strict）の詳細: [`docs/scwbs/operations-profile-and-specs.md`](operations-profile-and-specs.md)
- Task ContractのスキーマとHuman Gateの設計思想: [`docs/scwbs/task-contract.md`](task-contract.md)、[`docs/sc-wbs-core/06-human-gate.md`](../sc-wbs-core/06-human-gate.md)
- Evidence/Approvalのワークフロー: [`docs/scwbs/evidence-human-gate-review.md`](evidence-human-gate-review.md)
- AI Work Packetのshape: [`docs/scwbs/ai-work-packet.md`](ai-work-packet.md)
- WBS操作とvalidation: [`docs/scwbs/wjs-operations-validation.md`](wjs-operations-validation.md)
- JSON schema一覧: `docs/scwbs/schemas/*.schema.json`
