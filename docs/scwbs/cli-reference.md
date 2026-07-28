# scwbs CLI Reference

This file is the detailed command index for the `scwbs` CLI bundled with ACED (package name `scwbs`). Keep `README.md` short and link here when command examples grow.

Run through the npm script:

```bash
npm run scwbs -- --help
```

> **表記規約（Conventions）**
> - 説明文は日本語、コマンド名・オプション名・フィールド名・コード例は英語のまま記載する。
> - Task IDの例は本ドキュメント全体で `SCWBS-*` 形式に統一する（理由は「Task IDとブランチ命名」を参照）。従来この文書には `WBS-001-004` のような例が混在していたが、これは実装が生成する正規のID形式ではない。
> - コマンドが**変更するもの**（tracked files / git common dir / network）は「Mutation / Read-only 一覧」で分類する。
> - 終了コードは「終了コード」の節にある実装済みの値だけを記載する。文書化されていない終了コードは存在しないものとして扱う。

## Task IDとブランチ命名

`task new` が生成するTask IDは `SCWBS-DRAFT-<timestamp>`（例: `SCWBS-DRAFT-M3QJ2K`）であり、対応するbranchは `task/<task-id>-<slug>` である。現行の `task new` CLIは `--id` を公開していない。既存WBS nodeから任意のTask IDでdraftを生成する別コマンドは `task generate --node <node-id> --task <task-id>` である。次の集計はbranch名が `task/SCWBS-...` パターンに一致することを前提にしている。

```text
task/SCWBS-DRAFT-M3QJ2K-fix-parser
```

- `metrics governance --json` の `historicalCi.taskPullRequests` は、`pull_request` eventのうち `task/SCWBS-*` branchだけをtask ID別に集計する。
- `SCWBS-*` 以外のプレフィックスを使うTask（例: `task generate --task WBS-001-004` で生成したTask）のPRは、この集計から**サイレントに除外される**。エラーにも `unavailable` にもならない。

このため、`SCWBS-*` をTask IDの標準形式として使うことを推奨する。既存プロジェクトで別命名規則（例: `WBS-<node>-<seq>`）を使いたい場合は、`taskIdFromBranch` の正規表現（`src/core/github-actions.ts`）をプロジェクトのID規則に合わせて調整しない限り、`historicalCi.taskPullRequests` にそのTaskは現れない。本ドキュメントの以降の例はすべて `SCWBS-*` を使う。

## Core Checks

```bash
npm run scwbs -- init --profile lean --agent codex --lang ja
npm run scwbs -- check
npm run scwbs -- fix
npm run scwbs -- doctor
npm run scwbs -- health
npm run scwbs -- health --json
npm run scwbs -- health --verbose
npm run scwbs -- health --governance-cost
npm run scwbs -- check-diff --task SCWBS-001
npm run scwbs -- status
npm run scwbs -- status --json
npm run scwbs -- status --strict
```

`scwbs fix` only applies safe, deterministic fixes (currently: regenerating `contracts/registry.yaml`). It never edits Task Contracts, Evidence, Approvals, or WBS content, and never guesses at a fix for a failing check or a path violation.

### `fixCommand` の意味

`fixCommand` は、issueを返す全コマンドに共通する必須fieldではない。現行実装で `withDefaultFixCommand` によりerror issueへfallbackを補うのは `check-diff` であり、`check`、`health`、`doctor` などには `fixCommand` を持たないissueもある。利用側はfieldの存在を確認してから使う。

fieldがある場合も、値には2種類ある。

- **実行可能なコマンド**：単一のCLI呼び出しで安全に解消できる場合（例: `npm run scwbs -- approval request --task <id>`）。
- **助言的な説明文**：要件判断、設計変更、Human Gate、外部PRのmerge待ちなど、単一コマンドで機械的に解決できない場合。この場合の値はコマンド行ではなく、次に何を確認すべきかを示す短い説明文になる。

`fixCommand` の値をそのままshellへ渡す自動化を書いてはならない。fieldの有無を確認し、値が実行可能なコマンドか助言かを判定してから、人間または上位workflowが次の操作を決める。

### `health`

`health` の既定出力は同じissue codeをcount、代表2件、omitted件数へ集約し、warning数に比例してログが増えない。error、Human Gate、具体的な `fixCommand` を持つissueの順に優先表示する。全件表示は `--verbose`、機械処理はversioned schema `scwbs.health.v1` を返す `--json` を使う。JSONは集約前の全issueとcode別件数を保持する。shallow cloneではcommit到達性を `not-evaluated` と明示し、取得されていないcommitをunknownとして誤警告しない。`doctor` の既定textも同じsource/codeを代表2件へ集約するが、既存JSONは全issueを保持する。CRLF診断は `.gitattributes` 設定後の `git add --renormalize` を修復手順として返す。

`health` はTaskの読み取り自体はrepository-content上read-onlyだが、以下は例外である（詳細は「Mutation / Read-only 一覧」を参照）。

- active Task別のwarning summaryをgit common dirへ保存する（tracked artifactではないがlocal metadataとして書き込みが発生する）。
- `--governance-cost` を明示指定した場合、governance cost baselineのwarning判定を追加する。

`status` はWBS nodeのlifecycle件数と、Task indexで `completed` / `archived` のTaskに対するcompletion trustを別軸で表示する。completion trustはEvidenceの存在だけではなく、required checks、Evidence subject provenance、Human Approval scopeを`health`と共通の判定で評価し、`verified` / `degraded` / `unverifiable` / `not-evaluated`へ分類する。`patch-artifact` Evidenceは元subject commitがなくても、tracked payloadからtree、diffHash、changedFilesを再構築できればverifiedになり得る。`cancelled` Taskは母集団から除外する。`--json` はversioned schema `scwbs.status.v1` のbounded summaryを返し、Task ID一覧は展開しない。`--strict` はTask indexを評価できない場合、またはterminal Taskが完全な`verified`でない場合に非0を返す。shallow cloneでpatchのbaseCommitだけが取得できない場合は`not-evaluated`とし、Evidence欠落やApproval不整合など確定的な問題を隠さない。

#### `status --strict` の terminal Task 定義

> **注意（用語の重複）**：「terminal」という語は、このCLIの中で**2つの異なる意味**で使われている。混同しないこと。
> 1. **index scanningの意味**（`task archive` のdescription、`task-contract.md` の Active/archive lifecycle）：`completed` / `cancelled` / `archived` の3つがterminal（＝inactive）で、`next`、`ai next-task`、`review-queue`、`health` の既定走査から除外される対象を指す。
> 2. **completion trust / `status --strict` の意味**（このCLI Referenceの本節）：`completed` / `archived` の2つだけがterminalで、`cancelled` は含まれない。この節の「terminal Task」は常にこちらの意味である。
>
> 同じ「terminal」でも母集団に `cancelled` を含むかどうかが違うため、他ドキュメントを参照する際は文脈で判断すること。

completion trustの対象と `--strict` の失敗対象は**同一の母集団**である。曖昧さを避けるため明示する。

| Task index の `status` | terminal / completion trust対象 | `--strict` 失敗し得るか |
|---|---:|---:|
| `planned` | いいえ | いいえ |
| `active` | いいえ | いいえ |
| `blocked` | いいえ | いいえ |
| `reviewed` | いいえ | いいえ |
| `cancelled` | いいえ（母集団から除外） | いいえ |
| `completed` | はい | はい |
| `archived` | はい | **はい**（一度も `completed` を経ずに archive された Task も含む） |

`archived` は「一度完了して保管された」ことを意味しない。実装上、`task archive` で `status: archived` になったTaskは、完了経緯にかかわらずcompletion trust判定の対象になる。したがって、実装が未完了のままarchiveしたTaskがある場合、`status --strict` はそのTaskのEvidence/Approval欠落を理由に非0を返し得る。未完了のまま追跡対象から外したいだけであれば、archiveする前にそのTaskの扱い（完了扱いにするか、`cancelled` にするか）を先に決めること。

`health` はTask index上でactiveなTask Contractの `packet --context-json` manifestを診断する。ここでactiveとは `completed` / `cancelled` / `archived` 以外（`planned` / `active` / `blocked` / `reviewed`）である。次のcode context指標はWARNのみでexit codeを変更しない。指標はファイル単位またはwidening reason単位で全アクティブタスクを横断集約し、タスク数の爆発を防ぐ。

- `health.codeContext.fileTooLarge`：context内の単一file（mustRead/candidates）が 500 lines を超える、または 40,960 bytes を超える。一意な file path ごとに 1 issue、message に参照しているアクティブタスク数と代表例を含める。
- `health.codeContext.importFanOut`：context内の単一fileへのreverse importer数が 8 を超える。一意な file path ごとに 1 issue、message に最大importer数と参照タスク数を含める。
- `health.codeContext.planBudget`：context plan が `budget.omitted >= 20` の候補を省略している（budget が飽和しスコープ過大）。message に省略件数と `selectedBytes/maxBytes` を含める。
- `health.codeContext.widening`：`completeness.status` が `widening-required` 。widening reason code ごとに 1 issue、message に該当するアクティブタスク数と代表例を含める。
- `health.codeContext.skipped`：shallow clone等でgit blobが読めずmanifest生成できない場合、failせずskipを明示する。

これらの指標は既定で既存のhealth出力と同じbounded形式（代表2件、omitted件数）で集約され、`--verbose` で全件表示する。

## Governance Cost Metrics

```bash
npm run scwbs -- metrics governance
npm run scwbs -- metrics governance --json
```

`metrics governance` は永続artifactを作らないread-only計測で、現在のprofile、governance artifactのファイル数・bytes・行数、`src/**/*.ts` と `tests/**/*.ts` の分母、governance/source・governance/testの行比率を返す。

### JSON schema version

`metrics governance --json` は現在 **`schemaVersion: "1.1.0"`** を返す（`metric: "governance-cost"`）。現行shapeには次のfieldが含まれる。

- `humanGate`
- `historicalPullRequests`
- `healthLifecycle`

`1.0.0` は現行CLIが返す値ではない。consumerは `schemaVersion` を検査し、対応していないversionを推測で処理しないこと。将来versionの互換性方針は現行実装だけからは保証されない。

GitHub remoteが設定され、`gh` が認証済みなら、同じsummaryの `historicalCi` に既存GitHub Actions runの先頭100件（GitHub APIの新しい順、paginateしない）を集計する。対象repository、取得上限、run数、完了runのみのduration、workflow・event・head branch別集計、最初と最後のtimestampを返す。`taskPullRequests` は `pull_request` eventの `task/SCWBS-*` branchだけをtask ID別にまとめ（「Task IDとブランチ命名」を参照）、run、completed、success、failure、その他の完了、未完了、durationを`latestUpdatedAt`降順（同値は`taskId`昇順）の最大20件で返す。認証、通信、保持期間などにより取得できない場合は、0件・0秒と推測せず `status: unavailable` とreasonを返す。

`localRequiredChecks` はgit common dirに現存するtask別の最新canonical receiptをread-onlyで集計する。各checkの実行時間、観測・未観測check数、receipt期間、最大20件のtask trendを返す。durationを持たないlegacy receiptは有効な未観測値として扱い、0秒へ変換しない。git common dirやreceipt directoryを読めない場合も0件とせず `status: unavailable` とreasonを返す。receiptは全required checksが成功したときだけ保存され、taskごとに上書きされるため、失敗・旧attemptを含む全local履歴ではない。

`finish` はpreflight/fullのterminal outcomeごとに、git common dirのTask別 `scwbs-finish-lifecycle` receiptへ開始・終了・duration・phase・outcome・exit code・mutated file数・subject/head・検証済みmetadata ancestry数をatomicに記録する。tracked artifactやRegistryは増やさない。1 Taskは最新50 event、repositoryは最新100 Taskにbounded化される。

`metrics governance --json` の `localLifecycle` はこのreceiptをread-onlyで集計し、source status、invalid receipt数、event数、最大20 Taskのattempt、successful/blocked/failed、収束時間、metadata-only descendant数を返す。履歴切捨て、未収束、subject不明、shallow history、壊れたreceipt、git common dir読取不能は `null` または `status: unavailable` とし、0へ推測しない。Human Gate wait、publish loop、health warning deltaはそれぞれ別の `humanGate`、`historicalPullRequests`、`healthLifecycle` summaryで扱い、warning budgetは `warningBudgets` で扱う。hard limitは導入しない。

`humanGate`、`historicalPullRequests`、`healthLifecycle`（`schemaVersion 1.1.0` で追加）について: 新規Approval requestは `requestedAt` を記録しapprove後も保持するが、legacy recordの待ち時間は `null` のまま扱う。PR履歴は1回のbounded GitHub一覧取得からTask branchの作成・merge時刻と最大20 Taskのpublish loopを返し、取得不能は `unavailable`、未mergeは `null` とする。`health` はactive Task別warning summaryをgit common dirへ最大50 event/Task・最大100 Taskで保存し、履歴切捨てがなく最初と最後を比較できる場合だけwarning deltaを返す。plain metrics outputは変更しない。

`warningBudgets` は任意の `extensions.scwbs.governanceCost.warningBudgets.<Profile>` からprofile別の `governanceFiles`、`governanceLines`、`governanceToSourceLineRatio` をread-onlyで選択する。未設定は `not-configured`、completed Task 10件・観測済みHuman Gate 2件・full/metadata descendant各2件に不足する場合は `insufficient-baseline` とし、閾値を推測しない。baseline充足後の超過もwarning-onlyで、hard failureやprofile変更を行わない。`health --governance-cost` は明示指定時だけ同じstatusと最大3 warningを追加し、budget warningだけではexit codeを変更しない。

行数はUTF-8の改行数に、末尾改行がない空でないファイルの1行を加えた値である。`status: archived` または `archive` / `archived` directoryのartifactはactiveと分離する。未計測項目はJSONへ明示し、hard limitやprofile downgradeは行わない。

Profile（Lean / Standard / Strict）ごとの必須artifact・required checks・governance対象directoryの詳細は [`docs/scwbs/operations-profile-and-specs.md`](operations-profile-and-specs.md) を参照。`profile show` / `profile set lean|standard|strict` はこのCLI Referenceの「Contracts」節に例がある。

## AI Workflow

```bash
npm run scwbs -- ai packet --task SCWBS-001 --relation-depth 1
npm run scwbs -- ai run --task SCWBS-001 --agent codex
npm run scwbs -- ai block --task SCWBS-001 --reason "Human Gate required"
npm run scwbs -- ai next-task
npm run scwbs -- next
```

`ai run` is initially a dry-run orchestrator. It prints the pre-flight checks, implementation stop conditions, and post-flight checks rather than launching an external agent.

`ai next-task` is a planned-task handoff command. It only lists Task Contracts whose WBS node is `planned`, whose dependencies are complete, and whose Human Gate paths do not require approval before implementation. If it prints `No available planned tasks` but also says follow-up work remains, do not infer that the project is done; run `scwbs next` to get the next Evidence or review action for existing contracts.

`scwbs next` is the local follow-up command. It prioritizes stale task locks, missing Evidence, and review queue work before falling back to planned-task candidates.

### `packet` と `ai packet` は別コマンドである

この2つは**エイリアスではなく、独立したコマンド**である。

| Command | 親 | 用途 | 主なoption |
|---|---|---|---|
| `scwbs packet --task <id>` | top-level (Core) | Tiny/Standard/Full packetまたは `--context-json` のcode contextを構築する | `--tiny` `--standard` `--full` `--deep` `--normal` `--context-json` `--context-max-files` `--context-max-bytes` `--context-include-noncurrent-docs` `--relation-depth` |
| `scwbs ai packet --task <id>` | `ai` | AI agent向けのwork packetを、agent別format（`default`/`compact`/`codex`/`claude`/`cursor`）で構築する | `--relation-depth` `--format` |

両方とも `--task` を取り、内部で似た情報源を参照するが、出力shapeとformat optionは異なる。通常の作業開始では軽量なtop-level `packet` を優先し、agent別formatや追加関係情報が必要な場合だけ `ai packet` を使う。

### Block lifecycle

`ai block` and the Core alias `block "<reason>"` create an active Block record. Active Blocks are excluded from `ai next-task` and appear as completion prerequisites in `review-queue`.

Resolving a Block is an explicit human action. After making the required decision, a human runs:

```bash
npm run scwbs -- block resolve --task SCWBS-001 --reason "Human decision and outcome"
```

AI agents must not run `block resolve`. The command updates the existing record to `status: resolved`; it does not delete it. The record retains creation and resolution events in `history`, and the registry exposes the current status. A later `ai block` call reactivates the same record while preserving the earlier lifecycle history. Resolved Blocks no longer exclude a task from `ai next-task` and no longer block `review-queue` completion.

## Contracts

```bash
npm run scwbs -- task new "Fix parser" --paths "src/core/parser.ts,tests/unit/parser.test.ts" --stop "schema change required" --wbs-node node-parser
npm run scwbs -- task new "Draft only" --no-stop-conditions
npm run scwbs -- task generate --node node-api --task SCWBS-001
npm run scwbs -- task lock --task SCWBS-001
npm run scwbs -- task refresh --task SCWBS-001
npm run scwbs -- task refresh --task SCWBS-001 --apply
npm run scwbs -- task refresh --affected
npm run scwbs -- task refresh --all
npm run scwbs -- task refresh --all --apply
npm run scwbs -- task index rebuild --check
npm run scwbs -- task index rebuild --force
npm run scwbs -- task archive --task SCWBS-001
npm run scwbs -- evidence collect --task SCWBS-001
npm run scwbs -- evidence collect --task SCWBS-001 --pull-request "#42" --force
npm run scwbs -- evidence collect --task SCWBS-001 --test-assertions-added true --tests-disabled false --coverage-decreased false --test-quality-note "Added regression coverage" --force
npm run scwbs -- evidence collect --task SCWBS-001 --json --force
npm run scwbs -- evidence collect --task SCWBS-001 --verbose --force
npm run scwbs -- evidence collect --task SCWBS-001 --output - --force
npm run scwbs -- checks run --task SCWBS-001
npm run scwbs -- checks run --task SCWBS-001 --json
npm run scwbs -- checks run --task SCWBS-001 --rerun-checks
npm run scwbs -- evidence annotate --task SCWBS-001 --pull-request "#42" --test-assertions-added true --tests-disabled false --coverage-decreased false --test-quality-note "Added regression coverage"
npm run scwbs -- registry rebuild --check
npm run scwbs -- profile show
npm run scwbs -- profile set lean
```

`profile set` preserves the existing `extensions.scwbs` fields, writes a timestamped `setDocumentExtension` changeset under `contracts/changesets/`, and applies that changeset to the canonical WBS through WJS. It never falls back to a direct WBS write when apply fails. Profile is part of `wbsGlobalRevision`, so inspect `task refresh --affected` afterward and refresh only the intended Task Contracts.

`task new` はfail-closedである。`--paths` 未指定では `allowedPaths: []`、`--wbs-node` 未指定では `wbsNodeId: wbs-less` を生成する。`--stop` または明示的な `--no-stop-conditions` がなければartifactを書かず失敗する。広範scopeはwarningとTiny Packetの `Scope Risk` で確認できる。

`task new` は `--paths` / `--wbs-node` / `--stop` 以外にも、次のカンマ区切りoptionを取る。

| Option | 対応するTask Contract field |
|---|---|
| `--forbid <paths>` | `forbiddenPaths` |
| `--gate <paths>` | `humanGateRequiredPaths` |
| `--checks <checks>` | `requiredChecks` |

```bash
npm run scwbs -- task new "Add permission check" \
  --paths "src/features/staff-search/**,tests/features/staff-search/**" \
  --forbid "src/auth/**,src/database/schema/**" \
  --gate "src/security/**,openapi/**" \
  --checks "test,typecheck,lint" \
  --stop "auth redesign required" \
  --wbs-node node-staff-search
```

`task index rebuild --check` は `contracts/tasks/index.yaml` とTask Contract inventoryの整合性をread-onlyで検査する。`--force` は既存のlifecycle status、`dependsOn`、`archivedAt`を保持しながらcanonical path、branch、WBS node、並び順をatomicに再構築し、Registryも同期する。出力はactive、archived、total、issuesの固定長summaryで、`--json`も全Taskを展開しない。

### `task archive` とTaskの状態変更操作

`task archive --task <id>` はindexを `status: archived` にして既定の `next`、`ai next-task`、`review-queue`、`health`、WBS candidate走査から除外する。Task Contract、Evidence、Approval、Reviewは移動・削除せず、`packet --task`、`task refresh --task`、`check`、Registryから引き続き明示参照できる。

> **既知の制限**：現行実装では、archived Taskに対する `finish` および `evidence collect` の**書き込み系操作を拒否するガードは存在しない**。つまり `finish --task <archived-id>` や `evidence collect --task <archived-id>` を実行すると、実装は他の active Task と同様にEvidence/Registry/lifecycle receiptを更新してしまう。archiveは「既定のスキャン対象から外す」機能であり、「状態変更を禁止する」機能ではないことに注意すること。誤ってarchived TaskへEvidenceを収集・上書きしないよう、運用上は以下を推奨する。
>
> - archiveする前に、そのTaskが本当に状態変更不要であることを確認する。
> - CIやスクリプトからarchived Task IDを渡さないよう、`contracts/tasks/index.yaml` の対象entryで `status: archived` を確認してから操作対象を選ぶ。`status --json` は集計のみでTask ID一覧を返さない。
> - このガードの追加（`finish` / `evidence collect` の既定拒否 + `--allow-archived` などの明示オプション）は今後の実装課題として `docs/implementation-gaps.md` 等で追跡することを推奨する。

`checks run` はrequired checksの正規実行入口であり、全check成功時だけGit common directoryへ一時receiptをatomicに保存する。receiptはtask ID、HEAD、subject fingerprint、resolved command、lockfile hash、Node/platform、recursive submodule statusを記録する。直後の `evidence collect` / `finish` は現在のHEAD、差分、lockfile、submodule、commandが完全一致するpassed resultだけを再利用する。failed、壊れた、古いreceiptは再利用せず、生の `npm test` 等の自己申告もreceiptとして扱わない。`--rerun-checks` は有効なreceiptも無視して再実行する。既定出力はcheckごとの実行・再利用理由だけにbounded化し、正式なJSON shapeは [`schemas/checks-run-summary.schema.json`](schemas/checks-run-summary.schema.json) で定義する。

```bash
npm run scwbs -- ci plan --task SCWBS-001 --json
```

`ci plan --task <id> --json` は既存のfull / metadata-candidate判定を変更せず、`classification` にread-onlyなTask execution classを併記する。project profileは安全性の下限であり、このreportはrequired checks、artifact、Human Approval、CI jobを削減しない。own Task Contractをbootstrap metadataとして除外できるのは、full history上でcontract-only creation commit、初出blobからのauthority不変、version 2 lockをすべて検証できた場合だけである。shallow history、merge-base・初出commit不明、authority drift、未分類implementation pathは`high-risk`へfail-closedする。正式shapeは [`schemas/task-classification.schema.json`](schemas/task-classification.schema.json)。

`registry rebuild --force` の既定出力は、registry全体ではなく `added` / `updated` / `removed` / `path` の固定長サマリである。成功時の出力が不要なら `--quiet`、versioned summaryが必要なら `--json`、サマリに続けて全YAMLを確認する場合は `--verbose`、YAMLだけをstdoutへpipeする場合は `--output -` を使う。これら4つの出力modeは同時指定できない。JSONの正式なshapeは [`schemas/registry-rebuild-summary.schema.json`](schemas/registry-rebuild-summary.schema.json) で定義する。既定の `--check` は従来どおり、同期済みなら `PASS registry rebuild --check` とexit 0、未同期なら既存errorとexit 1を返す。

```bash
npm run scwbs -- registry rebuild --force --quiet
npm run scwbs -- registry rebuild --force --json
npm run scwbs -- registry rebuild --force --verbose
npm run scwbs -- registry rebuild --force --output -
```

Generated contract commands must refuse to overwrite existing files unless an explicit `--force` option is documented and supplied.

`task lock` writes a version 2 lock split into a scoped revision and a global revision. The scoped revision covers the referenced WBS node, its ancestors, its transitive `dependsOn` subgraph, and artifacts produced or consumed by those nodes. Unrelated sibling nodes are intentionally excluded. The global revision covers the WBS identity, root identity, schema version, and root `extensions.scwbs` policy.

`task refresh --affected` is preview-only and lists Task Contracts whose scoped WBS, global policy, or Spec lock changed. `task refresh --all` previews every Task Contract; add `--apply` only for an explicit bulk migration or refresh. Existing `wbsRevision` whole-file locks remain readable and are reported by `--affected` as legacy locks. Migrate one with `task refresh --task <id> --apply`, or migrate all explicitly with `task refresh --all --apply`.

### `--force` の意味はコマンドごとに異なる

`--force` はこの文書の複数のコマンドに登場するが、**何を上書きし、何を上書きしないか**はコマンドごとに異なる。「forceなら何でも通る」わけではない。

| Command | `--force` が行うこと | `--force` でも迂回**されない**もの |
|---|---|---|
| `evidence collect --force` | 既存Evidenceファイルの置換を許可する | required checks、provenance検証、path検証、Human Gate |
| `registry rebuild --force` | registry.yamlの再生成・書き込みを許可する | Task Contract / Evidence / Approvalの内容 |
| `task index rebuild --force` | index全体のcanonical path・branch・WBS node・並び順の再構築を許可する | 既存のlifecycle status、`dependsOn`、`archivedAt` |
| `wbs apply <change-set> --force` | `dryRun: true` のchangesetをpreviewではなく適用対象にする | changeset自体のバリデーション。Task/Approvalは参照しない |

`evidence collect --force` と `task generate --force` は、それぞれの表に記載したfail-closed境界を無効化しない。一方、`wbs apply` はTask IDを受け取らずApproval recordも検証しないため、`--force`実行前のHuman GateはTask Contractと運用手順で別途保証する必要がある。個別コマンドの`--help`または本節の説明で対象範囲を確認すること。

## Review And Approval

```bash
npm run scwbs -- review-queue
npm run scwbs -- review-queue --limit 10
npm run scwbs -- review-queue --json
npm run scwbs -- review-queue --verbose
npm run scwbs -- review route --task SCWBS-001
npm run scwbs -- review request --task SCWBS-001 --pull-request "#42"
npm run scwbs -- approval request --task SCWBS-001 --pull-request "#42" --note "Awaiting human review"
npm run scwbs -- approval approve --task SCWBS-001 --pull-request "#42" --actor human --reason "Evidence and PR reviewed"
SCWBS_APPROVAL_DELEGATION_TOKEN="<secret>" npm run scwbs -- approval approve --task SCWBS-001 --pull-request "#42" --actor delegated-ai --scope post-finish --reason "Authorized unattended execution"
npm run scwbs -- completion apply --tasks SCWBS-001 --task SCWBS-999 --reason "Reviewed and accepted"
npm run scwbs -- completion apply --tasks SCWBS-001 --task SCWBS-999 --reason "Reviewed and accepted" --apply
```

### Core alias: `request-approval` / `approve`

`approval request` と `approval approve` には、top-levelのCore alias `request-approval` と `approve` がある。artifactを作る内部関数は共通だが、option parsingは完全には同一でない。top-level aliasはどちらも `--pr` と `--pull-request` を受け付け、`approval request` / `approval approve` は `--pull-request` だけを受け付ける。複数語のnote/reasonは、どちらの形式でも引用符または `--note=...` / `--reason=...` を使う。

```bash
npm run scwbs -- request-approval --task SCWBS-001 --pull-request "#42" --note "Awaiting human review"
npm run scwbs -- approve --task SCWBS-001 --pr 42 --actor human --reason "Evidence and PR reviewed"
```

`review-queue` の既定出力は候補数に比例せず、review health集計、主要blocker集計、ready優先の上位候補、omitted件数、次のコマンドを表示する。候補の既定上限は5件で、`--limit <count>` で正の整数へ変更できる。従来の全候補・全理由・警告・blocker sectionが必要な場合は `--verbose`、機械処理には `--json` を使う。`--json` は明示した `--limit` がなければ全候補を返し、指定時は `candidates` と `omitted` に分ける。JSONの正式なshapeは [`schemas/review-queue-summary.schema.json`](schemas/review-queue-summary.schema.json) で定義する。`--json` と `--verbose` は同時指定できない。

`review route` previews requested reviewer roles from Evidence changed files. `review request` records those roles in `contracts/reviews/<task-id>.yaml` as `requestedReviewers` and synchronizes the derived `contracts/registry.yaml` in the same successful operation. Use `--json` to obtain the written artifacts and next action.

### Independent Review lifecycle (`review approve` / `review changes-requested` / `review close`)

`approval approve`（Human Gate承認）とは別に、`review` サブコマンド配下には独立レビュー判定を記録するコマンド群がある。これらは「Human Gateの承認」ではなく「レビューでの合否判定」を記録するためのもので、`evidence-human-gate-review.md` の Review Profile（Self Review / Independent AI Review / Human Review）の判定結果をCLI上に残す。

```bash
npm run scwbs -- review approve --task SCWBS-001 --actor human --findings "LGTM, matches acceptance criteria"
npm run scwbs -- review changes-requested --task SCWBS-001 --actor human --findings "Missing error handling for empty input"
npm run scwbs -- review close --task SCWBS-001 --actor human
```

- `review approve --task <id> --actor human --findings <text> --force` — レビューを承認済みとして記録する。
- `review changes-requested --task <id> --actor human --findings <text> --force` — 変更要求としてレビューを記録する。
- `review close --task <id> --actor human --force` — レビューを完了状態にする（`--findings` は取らない）。

3コマンドはいずれもactorが `human` でなければ失敗する。`--actor` を省略した場合は `SCWBS_AGENT_MODE` がfallbackになり、値が `ai` なら拒否される。ただし、これはactor文字列の検査であり本人性を独立検証する仕組みではない。ガードレール上、AI agentは `--actor human` を自己申告して実行してはならない。AIはfindingsを人間へ報告し、人間が内容を確認してreview transitionを記録する。

Approval records live under `contracts/approvals/*.yaml` and can carry human-review metadata independently from Evidence:

```yaml
id: APR-SCWBS-006
type: approval
taskId: SCWBS-006
status: requested
pullRequest: "#42"
notes:
  - Awaiting human gate review
```

`approval request` creates a `requested` record without fabricating human approval. `approval approve` is the explicit human action for turning a reviewed task into an approved record; it writes `status: approved`, `approvedBy: human`, and `approvedAt`. `--note` and `--reason` are available both as quoted multi-word arguments and inline syntax such as `--note=Awaiting human review` or `--reason=Evidence reviewed`.

### Human GateとDelegated Approvalの違い

`--actor delegated-ai` は、Task Contractの `approvalPolicy.mode: delegated` で明示的に委譲されたTaskだけに使える。`--scope human-gate|post-finish` は必須で、policyの `scopes`、UTC `expiresAt`、`tokenSha256` と32 bytes以上の環境変数 `SCWBS_APPROVAL_DELEGATION_TOKEN` を検証する。policy未指定、`human-only`、token欠落・不一致、弱いtoken、期限切れ、scope不一致はすべてfail-closedになる。tokenは出力・永続化せず、成功時は `approvalMode: delegated`、`delegationSource`、`delegatedBy`、`executedBy: ai-agent`、`delegationScope`、`delegationProof` を記録してHuman Approvalと**明確に区別する**。consumerもHMAC proofを再検証し、Human Gateでは`human-gate`、completionでは`post-finish`だけを受理する。

重要な点として、`--scope human-gate` を満たしたApproval記録は `approvalMode: delegated`（`approvedBy: human` ではない）のまま保存される。`--scope human-gate` という名前は「この委譲承認が、ワークフロー上Human Gateが要求される地点を満たす」という意味であり、「人間が今この瞬間にレビューした」ことを意味しない。監査・レビューを行う人は、次の2つのフィールドを必ず区別して確認すること。

| フィールド | `approvedBy: human` の場合 | `approvalMode: delegated` の場合 |
|---|---|---|
| 承認の実体 | 人間がその場でレビューし承認した | 事前にcreation commitで固定されたpolicyに基づき、AI agentが条件を満たして承認記録を作成した |
| `delegator`/`source`の検証 | 該当なし | *declared* provenanceであり、実在本人性やtoken注入者を独立に検証するものではない（下記「`approval delegation prepare`」参照） |
| 監査上の扱い | 直接的な人間の意思決定の記録 | 「委譲policyの条件が満たされた」ことの記録。policy自体を人間が事前承認した根拠と併せて確認する必要がある |

`human-gate` という scope 名を「人間限定」の意味だと誤読しないよう、この違いを社内ドキュメントやレビュー手順に明記することを推奨する。

### `approval delegation prepare`

新規Taskのcontract-only creation commitより前に、外部secret transportに設定済みのtokenからsecret-freeなpolicy patchとhandoffを生成する。tokenはCLI引数に渡さない。

```bash
SCWBS_APPROVAL_DELEGATION_TOKEN="<external-secret>" npm run scwbs -- approval delegation prepare \
  --task SCWBS-001 \
  --scopes human-gate,post-finish \
  --expires-at 2026-12-31T00:00:00.000Z \
  --source https://example.invalid/policy/42 \
  --reason "Unattended evidence workflow" \
  --delegated-by release-owner
```

出力の `policyPatch` は未commitのTask Contractへ人間が適用し、`task lock` 後にcontract-only creation commitへ固定する。既存・commit済みTaskのpolicy追加やscope拡張には使えない。handoffはhuman-gateとpost-finishのconsumer commandを別々に示し、token値は含まない。shell、CI secret store、任意の`.env` loaderはtransportの選択肢だが、SC-WBS CLIは`.env`を自動読込しない。

CLIは `.env` を自動読込しない。必要ならshell側で `.env` を読み込むかCI secretから環境変数を注入するが、`.env` はauthority sourceではなくsecret transportにすぎない。Task Contractの委譲policyはcreation commitでauthority baselineへ固定され、後からの追加・拡張・hash変更は拒否される。記録されるdelegator/sourceはdeclared provenanceであり、実在本人性やtoken注入者を独立に検証するものではない。

#### Windows環境でのtoken指定

上記の `SCWBS_APPROVAL_DELEGATION_TOKEN="<secret>" npm run scwbs -- ...` の書き方はPOSIX shell専用である。Windowsでは次のいずれかを使う。

PowerShell:

```powershell
$env:SCWBS_APPROVAL_DELEGATION_TOKEN = "<secret>"
npm run scwbs -- approval approve --task SCWBS-001 --pull-request "#42" --actor delegated-ai --scope post-finish --reason "Authorized unattended execution"
Remove-Item Env:SCWBS_APPROVAL_DELEGATION_TOKEN
```

cmd.exe:

```cmd
set SCWBS_APPROVAL_DELEGATION_TOKEN=<secret>
npm run scwbs -- approval approve --task SCWBS-001 --pull-request "#42" --actor delegated-ai --scope post-finish --reason "Authorized unattended execution"
set SCWBS_APPROVAL_DELEGATION_TOKEN=
```

どのシェルでも、token値はshell historyに残り得る。可能な限りCI secret store経由で環境変数を注入し、対話シェルへ直接入力しないことを推奨する。

When `finish` requires Human Approval, its text output and JSON `nextAction` use only the currently implemented `approval approve` options. In particular, they do not emit unsupported `--approved-by` or `--human-confirm` options.

After a PR exists, refresh Evidence with `--pull-request` so review and completion queues can tie the work back to the reviewed PR. When `evidence collect --force` refreshes an existing Evidence file and no replacement PR is provided, it preserves the existing `git.pullRequest` value instead of dropping it.

`evidence collect` の既定成功出力は、Evidence YAML全文ではなく `path`、check集計、変更ファイル数、PRを含む固定5行のサマリである。機械処理にはversioned summaryを返す `--json`、サマリと全YAMLの確認には `--verbose`、YAMLだけをstdoutへpipeする場合は `--output -` を使う。これら3つの出力modeは同時指定できず、`--output` の対象は `-` のみである。JSONの正式なshapeは [`schemas/evidence-collect-summary.schema.json`](schemas/evidence-collect-summary.schema.json) で定義する。`finish` は内部のEvidence収集をquietに実行するが、failed check、Human Gate、次アクションなど `finish` 自身の重要な結果は省略しない。

`evidence collect` と `finish` はEvidence YAMLに加えて
`contracts/evidence-payloads/<task-id>.patch` を生成する。payloadは
`git-diff-binary-v1` のtracked retention artifactであり、Evidence管理fileと
payload自身を除外するため、metadata-only descendantや再収集でhashが循環しない。
`finish` はpayload、Evidence、Registryを同じrollback unitでcheckpointする。

既存Evidenceの限定backfillには
`evidence retain --task <id> [--fetch-pr-head]` を使う。recorded subject、
base、diffHash、changedFilesが再現できない場合は書き込まない。
`--fetch-pr-head` はrecorded PRのhead refだけを取得し、subject ancestryを検証する。

`evidence annotate` は既存Evidenceの `git.pullRequest` と `testQuality` だけを更新し、`commit`、`subjectHeadCommit`、`diffHash`、`changedFiles`、`checks` を保持する。merge後のbranchやmetadata-only branchで元の実装Evidenceへ注記する場合は再収集ではなくこのコマンドを使う。既存のbranch-diff Evidenceが実装ファイルを記録しているのに、Task branch外の空差分から `evidence collect` しようとした場合、CLIはprovenance上書きを拒否する。

`finish` はrequired checks実行前にcontract lockとtestQuality metadataをpreflightし、check結果をまずcandidate Evidenceとしてmemory上に構築する。failed checkまたはHuman Gate以外のcheck-diff違反ではcandidateを破棄するため、既存payload、Evidence、Registryを上書きしない。検証済みcandidateはpayload、Evidence、Registryを同じrollback unitとして置換し、Human Gate待ちはこの整合checkpointを保存して `awaiting-human-approval` を返す。checkpoint途中の書き込み失敗は全fileを開始前の内容へ戻す。

完了時のnext actionはEvidenceとReviewのPR metadataを正規化して決定する。両方のPR番号が不一致なら修正command付きで停止し、PR番号がなければ新規PR作成、既存PRがあればdraft、checks pending、checks failure、checks success、未mergeのclosed、mergedの状態に応じてready化、checks監視、failure確認、merge、reopen、main同期を案内する。未mergeのclosed PRでは過去のchecks結果にかかわらずmergeやchecks watchへ進まず、`gh pr reopen <number>`を案内するため、必要に応じてEvidence / ReviewのPR metadataを確認してから再開する。`gh pr view`が未導入・未認証などで状態を取得できない場合も、新規PR作成へ戻らず、repository-local metadataの既存PR番号を使ったchecks確認へ安全にdegradeする。plain出力とJSONの `nextAction` / `resumeCommand` は同じcommandを返す。

tracked artifactを変更せずに開始条件だけを確認する場合は `npm run scwbs -- finish --task <task-id> --preflight` を使う。これはrequired checksも実行しないが、診断履歴としてgit common dirへfinish lifecycle receiptを記録する。`finish --json` は全終了経路で `phase`、`outcome`、実際に変更した `mutatedFiles`、再開用の `resumeCommand` を返す。Evidence provenance、Human Approval、既存Review scopeのwarningが残る場合はmerge-readyを表示せず、`fixCommand`を返す。PR metadataの欠落自体は新規PR作成のnext actionとなり、EvidenceとReviewのPR番号不一致はactionable errorとして停止する。repository全体のlegacy warningはこの判定へ含めない。正式なJSON shapeは [`schemas/finish-summary.schema.json`](schemas/finish-summary.schema.json) で定義する。

### `completion apply` の `--tasks` と `--task`

この2つのoptionは名前が非常に紛らわしいため、明示的に説明する。

| Option | 意味 | 例 |
|---|---|---|
| `--tasks <ids>` | 完了として承認・適用する**既存の実装Task**のID（カンマ区切りで複数可） | `--tasks SCWBS-001,SCWBS-002` |
| `--task <id>` | この completion 操作自体を所有する **completion Task**（changesetをコミットするTask）のID | `--task SCWBS-999` |

```bash
npm run scwbs -- completion apply \
  --tasks SCWBS-001,SCWBS-002 \
  --task SCWBS-999 \
  --reason "Reviewed and accepted"
```

`completion apply` completes reviewed WBS nodes without hand-written YAML. By default it is a dry-run that prints the approvals and `changeNodeStatus` operations it would write. With `--apply`, it validates existing approved records, writes `contracts/changesets/<completion-task-id>-complete-reviewed-work.json`, applies the WBS changeset, and rebuilds the registry. It refuses root-node completion by default; use `--allow-root` only after explicit human decision.

> **将来的な改善案**：`--tasks`/`--task` という命名は初見では区別しづらい。CLIの後方互換性を保つ必要がなければ、`--completed-tasks <ids>` と `--completion-task <id>` のような自己説明的な名前への変更を検討する価値がある（現行実装のoption名は変更していない）。

## Lightweight Entry Points

```bash
npm run scwbs -- start "natural language goal"
npm run scwbs -- plan --spec SPEC-001
npm run scwbs -- lite task "small change title"
npm run scwbs -- promote --task SCWBS-001
```

These commands generate drafts or candidates. They do not directly rewrite the canonical WBS.

## Trace And UI

```bash
npm run scwbs -- trace --task SCWBS-001
npm run scwbs -- ui
npm run scwbs -- serve
```

`ui` is a text dashboard.

`serve` is a **reserved, not-yet-implemented command**. It intentionally does nothing until a dependency change passes Human Gate; it is not a running feature you can rely on today. Do not add `serve` to production scripts or CI pipelines.

## WBS

```bash
npm run scwbs -- wbs validate
npm run scwbs -- wbs candidates
npm run scwbs -- wbs verify-changesets --base contracts/wbs/project.wbs.json --head contracts/wbs/project.wbs.json --changeset contracts/changesets/change-set.json
npm run scwbs -- wbs apply change-set.json
```

`wbs candidates` inspects `contracts/tasks/index.yaml` for active Task IDs that don't yet have a corresponding WBS node, and prints a dry-run `addNode` changeset (one node per such Task) for a human to review before applying with `wbs apply`. It writes nothing itself. `wbs verify-changesets` checks that replaying `--changeset <path>` (repeatable) on top of `--base <wbs.json>` reproduces `--head <wbs.json>` exactly; it is a reproducibility check for a changeset, not a general-purpose validator, and also writes nothing.

`wbs apply` 自体が検証するのはchangesetとWBSであり、Task Contract、Evidence、Approvalは入力に取らない。`check-diff` のHuman Gateも対象Taskの `humanGateRequiredPaths` にWBS pathが一致するときだけ作動する。したがって「WBS書き込み前にHuman Gateを通す」は運用policyであり、現行CLIが全WBS変更へ一律に自動適用する保証ではない。機械強制が必要なTaskでは `contracts/wbs/project.wbs.json` をTask開始前から `humanGateRequiredPaths` に固定し、Approval scopeをEvidence/diffと一致させる。

WBS operation details and validation commands are documented in `docs/scwbs/wjs-operations-validation.md`.

## Command And Required-Check Single-Flight

`npm run scwbs -- ...` はGit common directory内のcommand lockを取得してからTypeScript buildとCLIを実行する。worktreeをまたぐ並列呼び出しも同じlockを共有し、2本目はactive PID、command、開始時刻、current check、経過時間をstderrへbounded表示して待機する。read-only commandを含む全commandをbuildからCLI終了まで直列化するのが既定policyであり、共有`dist/`の書き換え中に別commandを実行しない。PIDが存在しないstale lockは次回実行が安全に回収する。

> この直列化はbuild成果物 `dist/` の一貫性を守るための意図的な設計であり、`status` や `health` のようなtracked-artifact read-only commandの実行中にも他のcommandをブロックする。長時間のrequired checkが動いている間は他のCLI呼び出し（read-onlyも含む）が待たされるため、運用上の応答性が必要な場合はbuild/command排他の保持期間をrequired-check実行から分ける改善を将来課題として検討してほしい。現行実装にはcommand lockとrequired-check lockの2ファイルがあるが、外側のcommand lockはrequired checksの完了まで保持される。

### required-check lockの再入（reentrancy）

`finish` と `evidence collect` のrequired checksは、さらにrepository-level single-flight lockを取得する（`scwbs-required-checks.lock`、`src/core/required-check-run.ts`）。`npm run test:integration` と `npm run test:integration:verbose` も同じGit common directory内のrequired-check lockを取得するため、直接runner同士、および `checks run` / `evidence collect` / `finish` 配下のintegrationとsuiteを重複実行しない。

この構造だけを見ると「親commandがlockを保持したまま子processのintegration runnerがロックを再取得しようとし、自己デッドロックする」ように見えるが、実装は**lock所有権をownerトークンとして子processへ継承**することでこれを回避している。

```text
finish / evidence collect / checks run
  └─ acquireRequiredCheckRun() で scwbs-required-checks.lock を取得
      → lockには runId（乱数）と pid を記録
  └─ 子processとして npm run test:integration を起動する場合、
     環境変数 SCWBS_REQUIRED_CHECK_RUN_ID / SCWBS_REQUIRED_CHECK_LOCK_PATH を継承させる
      └─ 子processの test:integration runner は、
         継承したrunIdが現在のlock stateのrunIdと一致し、
         親processが生存していることを確認できた場合だけ、
         新規lockを取得せずに「lockを継承した」ものとして実行する
```

つまり、lockには「調停者（coordinator）」と「実行者（runner）」の区別があるのではなく、単一のlockファイルに対して**同一runIdを引き継いだ場合のみ再取得をスキップする**という所有権検証で自己デッドロックを防いでいる。継承したrunIdがlock stateと一致しない、またはPIDが生存していない場合は、`integration lock inheritance is invalid or stale` として明示的に失敗する（サイレントに競合状態へ入ることはない）。

既定は競合時にactive PID、開始時刻、mode、worker数、経過時間をbounded stderrへ表示して拒否し、待機する場合だけ `npm run test:integration -- --wait` を明示する。stale PID lockは回収し、所有中のlockは正常終了、failure、signal interruptionで解放する。worktreeはGit common directoryを共有し、独立cloneのCI jobは共有しない。`npx vitest run tests/integration` のようなraw Vitest直接起動はこのrunnerを通らないため、排他保証の対象外である。

各checkの開始・完了、cache hitをstderrへ1行で表示し、30秒以上継続するcheckは30秒ごとにtask ID、check index/name、PID、開始時刻、経過時間をheartbeatとして出す。成功ログ量はcheck自身の出力量に比例せず、JSON modeでもstdoutは単一のversioned JSONのまま維持される。同一subjectで待機後に再実行されたcommandは既存のcheck cacheを再利用し、required checkを重複実行しない。

> **JSON stdoutの保証範囲**：この保証はCLI本体の出力についてのものである。npm lifecycle script、TypeScript build時のNode警告、依存パッケージの警告などが混入しないようにするのは呼び出し側の責務であり、`--json` 実行時はbuildログ・待機情報・warningをstderrへ送る運用（例: `npm run scwbs -- status --json 2>/dev/null | jq .` のように、機械処理側ではstderrを分離する）を推奨する。

For a changed submodule gitlink, `evidence collect` records nested changed files, old/new commits, repository, and whether the new commit is an ancestor of the configured upstream merge-target ref. Configure dependent PR, `upstreamRef`, and upstream check metadata in the Task Contract's `submoduleDependencies`. Packet and `review-queue` then show the required order: merge the dependent PR before the parent PR. `check-diff` blocks unreachable submodule heads and non-passed submodule checks; collection fails instead of treating an unavailable nested diff as empty.

When task changes include tests, record test quality metadata with `--test-assertions-added`, `--tests-disabled`, `--coverage-decreased`, and `--test-quality-note`. Forced Evidence refreshes preserve existing `testQuality` metadata when no replacement values are supplied.

## Mutation / Read-only 一覧

各コマンドが完了後に何を残すかは、AIエージェントによる自動運用でも人間の運用でも重要な情報である。「read-only」を一律に扱うと `health` のようにtracked artifactは変えないがlocal metadataを書き込むコマンドを見落とすため、次の4分類を使う。全 `npm run scwbs -- ...` 呼び出しが実行中だけ作成し正常終了時に削除するcommand single-flight lockは、この永続side effect分類には含めない。

- **repository-content read-only**：tracked files・contracts配下のYAML・registryなど、コミット対象になり得るものを一切変更しない。
- **local-metadata write**：tracked artifactは変更しないが、git common dir配下へreceiptやwarning historyなど実行後も残るmetadataを書き込む。
- **tracked-artifact mutation**：contracts配下やregistryなど、コミット対象のfileを変更する。
- **external state read/write**：GitHub API等を読み取る、またはrepository外の状態を変更する。

| Command | 分類 | 備考 |
|---|---|---|
| `check` / `docs check` / `check-diff` / `status` | repository-content read-only | `status`もlocal receiptを書かない |
| `next` / `review-queue` / `trace` / `ui` | repository-content read-only | `ui`はtext dashboardをstdoutへ表示する |
| `packet` / `ai packet` / `ai run` | repository-content read-only | `ai run`はdry-run planを表示し、外部AIを起動しない |
| `ci plan` / `profile show` | repository-content read-only | |
| `wbs validate` / `wbs candidates` / `wbs verify-changesets` | repository-content read-only | candidates/verifyもWBSを書かない |
| `registry rebuild --check` / `task index rebuild --check` | repository-content read-only | |
| `task refresh` / `completion apply`（`--apply`なし） | repository-content read-only | previewのみ |
| `health`（`--governance-cost`の有無を問わない） | local-metadata write | active Task別health warning summaryをgit common dirへ保存する |
| `metrics governance` | repository-content read-only + external state read | GitHub履歴をbounded取得するが永続artifactを作らない |
| `checks run` | local-metadata write | 全check成功時だけcheck receiptをgit common dirへ保存する |
| `finish --preflight` | local-metadata write | required checksとtracked artifact更新は行わないが、finish lifecycle receiptを記録する |
| `finish` | tracked-artifact mutation + local-metadata write | Evidence payload/Evidence/Registryの置換、`scwbs-finish-lifecycle` receiptの記録 |
| `evidence collect` | tracked-artifact mutation + local-metadata write + optional external state read | Evidence payload、Evidence YAML、check receipt。PR未指定時はGitHubから候補を読む場合がある |
| `evidence retain` | tracked-artifact mutation + optional external state read | 既存Evidenceの検証済みpatch retentionを追加。`--fetch-pr-head`時だけrecorded PR head refを取得する |
| `evidence annotate` | tracked-artifact mutation | 既存Evidenceの一部フィールドのみ更新 |
| `init` / `fix` / `doctor --fix` | tracked-artifact mutation | `doctor`は`--fix`なしなら診断のみ。`--fix`は依存修復commandも実行する |
| `discovery new` / `discovery start` / `discovery conclude` | tracked-artifact mutation | Discovery Probe recordを作成・更新する |
| `block` / `block resolve` / `ai block` | tracked-artifact mutation | Block、必要に応じSpec Change/changesetを更新する |
| `start <goal>` / `plan` / `lite task` / `promote` | tracked-artifact mutation | 既存Task IDを指定した`start`だけはpreflight表示で書かない |
| `registry rebuild --force` / `profile set` | tracked-artifact mutation | `profile set`はchangesetを書き、WJS経由でWBSを更新する |
| `task generate` / `task new` / `task lock` / `task archive` / `task refresh --apply` / `task index rebuild --force` | tracked-artifact mutation | |
| `approval request` / `approval approve` / aliases | tracked-artifact mutation | |
| `approval delegation prepare` | repository-content read-only | policy patchとhandoffをstdoutへ出すだけで、Task Contractへ自動適用しない |
| `review request` / `review route` / `review approve` / `review changes-requested` / `review close` | tracked-artifact mutation | registryも同一操作内で同期する |
| `completion apply --apply` | tracked-artifact mutation | changeset書き込み、WBS適用、registry再構築 |
| `wbs apply` | tracked-artifact mutation | `--output`で指定したWBSをWJS経由で更新する |
| `merge --preflight-only` | external state read | GitHub PR metadata/checksを読む |
| `merge` | external state read + external state write | 検証後にGitHub PRをsquash mergeしhead branchを削除する |
| `serve` | 何もしない（stub） | |

## 終了コード

CLI自身の主要経路は次の終了コードを使う。Commanderが構文解析時に返す値と、各actionが明示的に返すvalidation結果は同一ではない。また `wbs apply` のように子processのstatusを伝播するcommandでは、子process固有の値を返し得るため、0/1/2だけと仮定してはならない。

| Exit code | 意味 |
|---:|---|
| 0 | 成功。要求された処理が完了した、またはcheckが全てpassした。 |
| 1 | 失敗・ブロック。check失敗、検証エラー、Human Gate待ち、`status --strict`不整合に加え、Commanderが検出するunknown command/optionや必須argument欠落も通常この値を返す。 |
| 2 | action内でSC-WBSが明示検証する引数エラー。例: 必須 `--task` option欠落、無効なTask ID、無効な列挙値。 |

**Human Gate待ちも通常のcheck失敗も同じexit code 1になる**ことに注意すること。CI等でHuman Gate待ちだけを別扱いしたい場合は、exit codeではなく `--json` の `outcome`（例: `awaiting-human-approval`）フィールドで判定すること。

## Build Output

After building:

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
