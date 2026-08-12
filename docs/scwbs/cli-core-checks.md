# scwbs CLIリファレンス

このfileはACEDにbundledされた`scwbs` CLI（package name `scwbs`）のdetailed command indexである。command exampleが増えた場合も`README.md`は短く保ち、ここへlinkする。

npm script経由で実行する。

```bash
npm run scwbs -- --help
```

> **表記規約（Conventions）**
>
> - 説明文は日本語、コマンド名・オプション名・フィールド名・コード例は英語のまま記載する。
> - Task IDの例は本ドキュメント全体で `SCWBS-*` 形式に統一する（理由は「Task IDとブランチ命名」を参照）。従来この文書には `WBS-001-004` のような例が混在していたが、これは実装が生成する正規のID形式ではない。
> - コマンドが**変更するもの**（tracked files / git common dir / network）は「Mutation / Read-only 一覧」で分類する。
> - 終了コードは「終了コード」の節にある実装済みの値だけを記載する。文書化されていない終了コードは存在しないものとして扱う。

## Coreチェック

### トップレベルのcommand group

top-level helpは各command groupと短いpurposeを列挙する。subcommandとoptionについてはgroup-specific helpを使う。

| Group | Purpose |
| --- | --- |
| `ci` | CI executionをplan・classifyする |
| `checks` | required checkを実行・inspectする |
| `metrics` | governance costとrepository metricを計測する |
| `ai` | AI packetとdry-run task planを作成する |
| `approval` | task approval requestとdelegated policy preparationを管理する |
| `completion` | SC-WBS経由でcompletion changeをapplyする |
| `evidence` | Task Evidenceをcollect・maintainする |
| `registry` | contract registryをvalidate・rebuildする |
| `profile` | SC-WBS profileを表示・変更する |
| `review` | Task reviewをrequest・routeする |
| `lite` | lightweight task proposalを作成する |
| `task` | Task Contractとlifecycleを管理する |
| `policy` | read-only repository policy impactを説明する |
| `wbs` | WBS changeをvalidate・applyする |

```bash
npm run scwbs -- init --profile lean --agent codex --lang ja
npm run scwbs -- agent add claude
npm run scwbs -- agent set-primary codex
npm run scwbs -- update --dry-run --json
npm run scwbs -- agent list --json
npm run scwbs -- agent inspect gemini --json
npm run scwbs -- agent doctor --all --json
npm run scwbs -- pack inspect ./packs/secure-node --json
npm run scwbs -- pack install ./packs/secure-node --pin --dry-run --json
npm run scwbs -- pack list --json
npm run scwbs -- pack search security --json
npm run scwbs -- pack info org.example.secure-node --json
npm run scwbs -- pack update org.example.secure-node --dry-run --json
npm run scwbs -- pack remove org.example.secure-node --dry-run --json
npm run scwbs -- mcp --stdio
npm run scwbs -- index rebuild --json
npm run scwbs -- index status --json
npm run scwbs -- index verify --json
npm run scwbs -- query tasks --status blocked --json
npm run scwbs -- query "auth" --kind spec,task --json
npm run scwbs -- check
npm run scwbs -- fix
npm run scwbs -- doctor
npm run scwbs -- doctor --github
npm run scwbs -- health
npm run scwbs -- health --json
npm run scwbs -- health --verbose
npm run scwbs -- health --governance-cost
npm run scwbs -- check-diff --task SCWBS-001
npm run scwbs -- status
npm run scwbs -- status --json
npm run scwbs -- status --strict
npm run scwbs -- next --json
npm run scwbs -- ui --json
npm run scwbs -- trace --task SCWBS-DRAFT-EXAMPLE --json
npm run scwbs -- task preflight --title "Update auth flow" --paths "src/auth/**" --profile strict --json
npm run scwbs -- policy explain src/auth/session.ts --json
```

`scwbs fix`はsafeかつdeterministicなfix（currentは`contracts/registry.yaml`のregenerate）だけをapplyする。Task Contract、Evidence、Approval、WBS contentをeditせず、failed checkやpath violationのfixを推測しない。

### 利用者の初回利用経路

canonical consumer flowは[`docs/scwbs/quickstart.md`](quickstart.md)に記載する。release tarballをinstallし、`npx scwbs init`を実行し、`npx scwbs doctor`と`npx scwbs next`を使い、narrowly scoped Taskを作成し、`npx scwbs finish --task <task-id>`でcompleteする。以下のmanual Evidence/registry/check-diff sequenceはcontributor troubleshooting向けに残る。`docs/scwbs/quickstart-commands.json`のmachine-readable command fixtureはdistribution smoke testがexerciseし、command/option driftをvalidation failureにする。

`scwbs version`はinstalled exact versionを表示する。GitHub Releaseの`scwbs-bootstrap.mjs` assetはsupported non-npm Option B entrypointを提供する。`node scwbs-bootstrap.mjs install --save-dev`はexact `devDependencies.scwbs` URLを書き込む前にrelease manifestとtarball digestをverifyし、`install --dry-run --json`はread-onlyで`scwbs.bootstrap-install.v1`を返す。`scwbs version check --json`はinstalled/current-stable release subjectをverifyし、`--manifest <path>`と`--artifact <path>`でoffline digest verificationを可能にする。`scwbs upgrade --dry-run --json`はconsumerをmutationせずexact artifact proposalを出力し、`--dry-run`なしのupgradeはrejectされる。

`doctor --github` は、明示的に指定した場合だけ GitHub readiness を read-only で診断する。`gh` CLI、認証、`origin`、repository/PR/Actions の read capability と merge readiness を `ready`、`partial`、`unavailable`、`not-evaluated` で返す。トークンや `gh` の生出力は返さず、GitHub が利用できない場合もローカル診断の結果は変えない。JSON 出力の追加フィールドは `docs/scwbs/schemas/doctor-github.schema.json` で定義する。

`init --agent`はexisting adapterをreplaceせずselected adapter（`codex`、`claude`、`cursor`、`copilot`、`gemini`、`opencode`）をaddする。versioned `scwbs.agent-adapter.v1` registryはfile path、lifecycle status、MCP capability、locale keyをcommand switchではなくdataとして保持する。Gemini CLIとOpenCodeはpreview fixtureである。Manifest v2は`primaryAgent`、`agents`、fileごとの`owner`/`sha256`を保持し、valid v1 manifestをsafeにmigrateする。`agent add`、`agent set-primary`、`agent remove`はadditive、primary-only、unchanged-file-only operationであり、divergent/user fileはpreserveする。

`init --lang <locale>`はgenerated guidanceにversioned `scwbs.locale.v1` bundleを使う。`ja-jp`と`en-us`は`ja`と`en`へnormalizeし、unknown valid locale idはdeterministically `en`へfallbackする。stable error code、JSON schema field name、authority semanticは翻訳しない。bundle keyとplaceholderのvalidationはgenerated fileを書き込む前にfail-closedする。

`agent list --json`と`agent inspect <id> --json`はbounded registry metadataを公開する。`agent doctor --all --json`はregistered adapterごとのrepository-relative pathをcheckし、`ready`、`preview`、`error`を報告する。absolute path、traversal、symlink escapeはfail-closedし、これらのcommandはagentやshell commandをexecuteしない。

`update`はmanaged agent全体、または`--agent`指定の1つをrefreshする。`update --lang <locale>`はgenerated guidance localeをexplicitにswitchし、`update --dry-run --json`はwriteせずversioned create/update/unchanged/preserved/divergent/migrate/remove decisionを返す。operationはidempotentでHuman Gate/approval stop semanticを維持し、divergent user-owned fileを上書きしない。

`task preflight`と`policy explain`はread-only policy-cost explanationである。Task creationと同じcheck coverage/governance path evaluatorを使い、required check、Evidence、Human Gate path、forbidden path、reason code付きversioned JSONを返し、Task Contractをcreateまたはapproveしない。unclassified implementation pathはfail-closedする。

`pack` は `scwbs.pack.v1` Governance Pack の検査・固定・導入を扱う。v1 は repository-local path と repository-local Git の pinned ref を受け付け、任意 shell / JavaScript / executable hook は拒否する。`install --pin` は digest、installed files、compatibility、effective policy fingerprint を `.scwbs/packs.lock.json` に固定し、`--dry-run --json` では書き込み前の差分を返す。Pack は required checks、Human Gate、forbidden paths を追加できるが、削除・縮小は fail-closed である。Divergent な user-owned file は上書きしない。`pack update --dry-run --json` は `old` / `new` の version、digest、source provenance とファイル差分を返し、同一 digest の更新は no-op になる。更新はファイルと lockfile を transactional に適用し、失敗時に中間状態を残さない。`search` / `info` は installed lock の discovery-only catalog であり、trust root や authority ではない。Pack removal は policy downgrade の可能性があるため、v1 では dry-run を提示して停止する。

`mcp --stdio` は network listener を持たない MCP-compatible JSON-RPC server である。stdout は protocol message 専用、診断は stderr に分離される。`resources/list` / `resources/read` は `status`、`next`、`packet`、`trace`、`evidence`、`review-queue` を read-only resource として公開し、`tools/list` / `tools/call` は `scwbs.task.preflight`、`scwbs.check`、`scwbs.finish`、`scwbs.block` の structured input のみを受け付ける。既存の versioned JSON builder と authority evaluator を再利用するため、Human Approval、Review transition、policy downgrade、Evidence prune、merge bypass は公開されない。能力メタデータの契約は `scwbs.mcp-capabilities.v1` と [`docs/scwbs/schemas/mcp-capabilities.schema.json`](schemas/mcp-capabilities.schema.json) で固定する。MCP が使えない agent は従来の CLI workflow をそのまま利用する。

`index rebuild` は canonical YAML/JSON artifact から `.scwbs/cache/index.sqlite` を完全再構築する。cache は Git 管理外の navigation/search 用 derived data であり、`check`、`finish`、`approval`、`merge` の authority 判定には使わない。`index status --json` / `index verify --json` は missing、ready、stale、corrupt と source hash / repository HEAD provenance を返す。`query --json` は SQL を公開せず、kind、status、bounded text、`--unverified`、`--stale` だけを受け付ける。結果には source path、source hash、schema version、HEAD、canonical locator を含め、出力は最大100件に制限する。corrupt cache は `index rebuild` で安全に再生成できる。

### Navigation JSON契約

`next --json`、`ui --json`、`trace --json` は、agent/IDEがproseをparseせずに利用できるversioned JSONをstdoutへ1件だけ出力する。diagnosticや実行ログはstderrへ分離する。

| Command        | Version          | Schema                                 |
| -------------- | ---------------- | -------------------------------------- |
| `next --json`  | `scwbs.next.v1`  | `docs/scwbs/schemas/next.schema.json`  |
| `ui --json`    | `scwbs.ui.v1`    | `docs/scwbs/schemas/ui.schema.json`    |
| `trace --json` | `scwbs.trace.v1` | `docs/scwbs/schemas/trace.schema.json` |

`next --json` の `action.owner` が `human` の場合、`aiStop: true` とともにAIは停止し、`command`を自動実行してはならない。`version`は互換性の固定点であり、既存フィールドの意味を変更する場合は同じversionを再利用せず、新しいversionとschemaを追加する。後方互換な任意フィールド追加は、consumerが未知フィールドを無視できることを前提に行う。

### `fixCommand` の意味

`fixCommand` は、issueを返す全コマンドに共通する必須fieldではない。現行実装で `withDefaultFixCommand` によりerror issueへfallbackを補うのは `check-diff` であり、`check`、`health`、`doctor` などには `fixCommand` を持たないissueもある。利用側はfieldの存在を確認してから使う。

fieldがある場合も、値には2種類ある。

- **実行可能なコマンド**：単一のCLI呼び出しで安全に解消できる場合（例: `npm run scwbs -- approval request --task <id>`）。
- **助言的な説明文**：要件判断、設計変更、Human Gate、外部PRのmerge待ちなど、単一コマンドで機械的に解決できない場合。この場合の値はコマンド行ではなく、次に何を確認すべきかを示す短い説明文になる。

`fixCommand` の値をそのままshellへ渡す自動化を書いてはならない。fieldの有無を確認し、値が実行可能なコマンドか助言かを判定してから、人間または上位workflowが次の操作を決める。

### `remediation`契約

主要なcheck/health/doctor/check-diff/finishのJSON issueには、`remediation`（versioned contract）が付く。`kind` は `command`、`guidance`、`wait` のいずれかであり、commandはshell文字列ではなくargv配列をcanonical表現とする。

- `command`: `owner`（`ai`、`human`、`user`）、`argv`、`safeToAutoRun`、任意の`cwd`/`reason`を持つ。Human Gateのcommandは必ず`owner: human`かつ`safeToAutoRun: false`である。
- `guidance`: `owner`（`human`または`user`）と表示用`message`を持つ。単一コマンドと解釈して実行してはならない。
- `wait`: 外部状態を待つ提案であり、`owner: external`と`condition`を持つ。

既存consumer向けに`fixCommand`は互換textとして維持する。既存producerがまだargvを提供しないfixCommandは安全側に`guidance`として出力され、自然言語をshellへ渡すheuristicは行わない。正式なshapeは[`remediation.schema.json`](schemas/remediation.schema.json)で定義する。

### `health`

`health` の既定出力は同じissue codeをcount、代表2件、omitted件数へ集約し、warning数に比例してログが増えない。error、Human Gate、具体的な `fixCommand` を持つissueの順に優先表示する。全件表示は `--verbose`、機械処理はversioned schema `scwbs.health.v1` を返す `--json` を使う。JSONは集約前の全issueとcode別件数を保持する。shallow cloneではcommit到達性を `not-evaluated` と明示し、取得されていないcommitをunknownとして誤警告しない。`doctor` の既定textも同じsource/codeを代表2件へ集約するが、既存JSONは全issueを保持する。CRLF診断は `.gitattributes` 設定後の `git add --renormalize` を修復手順として返す。

Active Taskについて、`health.task.timestampDrift` は Task の `allowedPaths` に一致するtracked sourceとTask Contractのgit commit timestampだけを比較するwarning-only診断である。source側が新しい場合に警告し、file mtimeや意味的なfreshnessは推測しない。履歴が不足する場合は `health.task.timestampDrift.notEvaluated` として明示し、exit codeやApprovalを変更しない。

`health` はTaskの読み取り自体はrepository-content上read-onlyだが、以下は例外である（詳細は「Mutation / Read-only 一覧」を参照）。

- active Task別のwarning summaryをgit common dirへ保存する（tracked artifactではないがlocal metadataとして書き込みが発生する）。
- `--governance-cost` を明示指定した場合、governance cost baselineのwarning判定を追加する。

`status` はWBS nodeのlifecycle件数と、Task indexで `completed` / `archived` のTaskに対するcompletion trustを別軸で表示する。completion trustはEvidenceの存在だけではなく、required checks、Evidence subject provenance、Human Approval scopeを`health`と共通の判定で評価し、`verified` / `degraded` / `unverifiable` / `not-evaluated`へ分類する。`patch-artifact` Evidenceは元subject commitがなくても、tracked payloadからtree、diffHash、changedFilesを再構築できればverifiedになり得る。`cancelled` Taskは母集団から除外する。`--json` はversioned schema `scwbs.status.v1` のbounded summaryを返し、Task ID一覧は展開しない。`--strict` はTask indexを評価できない場合、またはterminal Taskが完全な`verified`でない場合に非0を返す。shallow cloneでpatchのbaseCommitだけが取得できない場合は`not-evaluated`とし、Evidence欠落やApproval不整合など確定的な問題を隠さない。

#### `status --strict` の terminal Task 定義

> **注意（用語の重複）**：「terminal」という語は、このCLIの中で**2つの異なる意味**で使われている。混同しないこと。
>
> 1. **index scanningの意味**（`task archive` のdescription、`task-contract.md` の Active/archive lifecycle）：`completed` / `cancelled` / `archived` の3つがterminal（＝inactive）で、`next`、`ai next-task`、`review-queue`、`health` の既定走査から除外される対象を指す。
> 2. **completion trust / `status --strict` の意味**（このCLI Referenceの本節）：`completed` / `archived` の2つだけがterminalで、`cancelled` は含まれない。この節の「terminal Task」は常にこちらの意味である。
>
> 同じ「terminal」でも母集団に `cancelled` を含むかどうかが違うため、他ドキュメントを参照する際は文脈で判断すること。

completion trustの対象と `--strict` の失敗対象は**同一の母集団**である。曖昧さを避けるため明示する。

| Task index の `status` | terminal / completion trust対象 |                                            `--strict` 失敗し得るか |
| ---------------------- | ------------------------------: | -----------------------------------------------------------------: |
| `planned`              |                          いいえ |                                                             いいえ |
| `active`               |                          いいえ |                                                             いいえ |
| `blocked`              |                          いいえ |                                                             いいえ |
| `reviewed`             |                          いいえ |                                                             いいえ |
| `cancelled`            |        いいえ（母集団から除外） |                                                             いいえ |
| `completed`            |                            はい |                                                               はい |
| `archived`             |                            はい | **はい**（一度も `completed` を経ずに archive された Task も含む） |

`archived` は「一度完了して保管された」ことを意味しない。実装上、`task archive` で `status: archived` になったTaskは、完了経緯にかかわらずcompletion trust判定の対象になる。したがって、実装が未完了のままarchiveしたTaskがある場合、`status --strict` はそのTaskのEvidence/Approval欠落を理由に非0を返し得る。未完了のまま追跡対象から外したいだけであれば、archiveする前にそのTaskの扱い（完了扱いにするか、`cancelled` にするか）を先に決めること。

### `wbs merge-plan`

`wbs merge-plan --base <ref-or-file> --ours <ref-or-file> --theirs <ref-or-file>` は、WBSのread-only 3-way semantic merge planを `scwbs.wbs-merge-plan.v1` JSONで出力する。node、relation、resource、artifact、extension namespaceをidentity単位で比較し、独立変更は `clean`、同一field変更やdelete-vs-modifyなどは `conflicted` として報告する。`--write-changeset <file>` はclean planに限ってWJS-compatible changesetを書き出すが、canonical WBSへの適用やconflict解決は行わない。

`health` はTask index上でactiveなTask Contractの `packet --context-json` manifestを診断する。ここでactiveとは `completed` / `cancelled` / `archived` 以外（`planned` / `active` / `blocked` / `reviewed`）である。次のcode context指標はWARNのみでexit codeを変更しない。指標はファイル単位またはwidening reason単位で全アクティブタスクを横断集約し、タスク数の爆発を防ぐ。

- `health.codeContext.fileTooLarge`：context内の単一file（mustRead/candidates）が 500 lines を超える、または 40,960 bytes を超える。一意な file path ごとに 1 issue、message に参照しているアクティブタスク数と代表例を含める。
- `health.codeContext.importFanOut`：context内の単一fileへのreverse importer数が 8 を超える。一意な file path ごとに 1 issue、message に最大importer数と参照タスク数を含める。
- `health.codeContext.planBudget`：context plan が `budget.omitted >= 20` の候補を省略している（budget が飽和しスコープ過大）。message に省略件数と `selectedBytes/maxBytes` を含める。
- `health.codeContext.widening`：`completeness.status` が `widening-required` 。widening reason code ごとに 1 issue、message に該当するアクティブタスク数と代表例を含める。
- `health.codeContext.skipped`：shallow clone等でgit blobが読めずmanifest生成できない場合、failせずskipを明示する。

これらの指標は既定で既存のhealth出力と同じbounded形式（代表2件、omitted件数）で集約され、`--verbose` で全件表示する。

## Governance Costのメトリクス

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
- `aiExecution`

`1.0.0` は現行CLIが返す値ではない。consumerは `schemaVersion` を検査し、対応していないversionを推測で処理しないこと。将来versionの互換性方針は現行実装だけからは保証されない。

GitHub remoteが設定され、`gh` が認証済みなら、同じsummaryの `historicalCi` に既存GitHub Actions runの先頭100件（GitHub APIの新しい順、paginateしない）を集計する。対象repository、取得上限、run数、完了runのみのduration、workflow・event・head branch別集計、最初と最後のtimestampを返す。`taskPullRequests` は `task/` branchをTask Index優先・SCWBS形式fallbackでtask ID別にまとめ、run、completed、success、failure、その他の完了、未完了、duration、`resolutionSource`を`latestUpdatedAt`降順（同値は`taskId`昇順）の最大20件で返す。未解決branchは最大20件の`unmatched`にまとめ、`completeness` は候補run数、帰属率、Index可用性を返す。

`localRequiredChecks` はgit common dirに現存するtask別の最新canonical receiptをread-onlyで集計する。各checkの実行時間、観測・未観測check数、receipt期間、最大20件のtask trendを返す。durationを持たないlegacy receiptは有効な未観測値として扱い、0秒へ変換しない。git common dirやreceipt directoryを読めない場合も0件とせず `status: unavailable` とreasonを返す。receiptは全required checksが成功したときだけ保存され、taskごとに上書きされるため、失敗・旧attemptを含む全local履歴ではない。

`aiExecution` はgit common dirの`scwbs-ai-execution`にあるTask別最新receiptをread-onlyで集計する。wall time、adapter turn数、remediation round数、required-check reuse率を返し、cost metadataのないlegacy receiptは有効な未観測値として扱う。receipt directoryを読めない場合やgit repository外では`status: unavailable`とreasonを返し、未観測値を0へ推測しない。正式なJSON shapeは[`governance-cost.schema.json`](schemas/governance-cost.schema.json)で定義する。

`finish` はpreflight/fullのterminal outcomeごとに、git common dirのTask別 `scwbs-finish-lifecycle` receiptへ開始・終了・duration・phase・outcome・exit code・mutated file数・subject/head・検証済みmetadata ancestry数をatomicに記録する。tracked artifactやRegistryは増やさない。1 Taskは最新50 event、repositoryは最新100 Taskにbounded化される。

`metrics governance --json` の `localLifecycle` はこのreceiptをread-onlyで集計し、source status、invalid receipt数、event数、最大20 Taskのattempt、successful/blocked/failed、収束時間、metadata-only descendant数を返す。履歴切捨て、未収束、subject不明、shallow history、壊れたreceipt、git common dir読取不能は `null` または `status: unavailable` とし、0へ推測しない。Human Gate wait、publish loop、health warning deltaはそれぞれ別の `humanGate`、`historicalPullRequests`、`healthLifecycle` summaryで扱い、warning budgetは `warningBudgets` で扱う。hard limitは導入しない。

`humanGate`、`historicalPullRequests`、`healthLifecycle`（`schemaVersion 1.1.0` で追加）について: 新規Approval requestは `requestedAt` を記録しapprove後も保持するが、legacy recordの待ち時間は `null` のまま扱う。PR履歴は1回のbounded GitHub一覧取得からTask branchの作成・merge時刻と最大20 Taskのpublish loopを返し、取得不能は `unavailable`、未mergeは `null` とする。`health` はactive Task別warning summaryをgit common dirへ最大50 event/Task・最大100 Taskで保存し、履歴切捨てがなく最初と最後を比較できる場合だけwarning deltaを返す。plain metrics outputは変更しない。

`warningBudgets` は任意の `extensions.scwbs.governanceCost.warningBudgets.<Profile>` からprofile別の `governanceFiles`、`governanceLines`、`governanceToSourceLineRatio` をread-onlyで選択する。未設定は `not-configured`、completed Task 10件・観測済みHuman Gate 2件・full/metadata descendant各2件に不足する場合は `insufficient-baseline` とし、閾値を推測しない。baseline充足後の超過もwarning-onlyで、hard failureやprofile変更を行わない。`health --governance-cost` は明示指定時だけ同じstatusと最大3 warningを追加し、budget warningだけではexit codeを変更しない。

行数はUTF-8の改行数に、末尾改行がない空でないファイルの1行を加えた値である。`status: archived` または `archive` / `archived` directoryのartifactはactiveと分離する。未計測項目はJSONへ明示し、hard limitやprofile downgradeは行わない。

Profile（Lean / Standard / Strict）ごとの必須artifact・required checks・governance対象directoryの詳細は [`docs/scwbs/operations-profile-and-specs.md`](operations-profile-and-specs.md) を参照。`profile show` / `profile set lean|standard|strict` はこのCLI Referenceの「Contracts」節に例がある。

## 軽量なentry point

### `store list` / `store show`

Planning Store registryはversionedでread-onlyなcross-repository referenceである。registry自体はTask Contractではなく、repository Taskの`allowedPaths`、required check、Evidence、Approval、Human Gate authorityを拡張できない。

```bash
corepack npm run scwbs -- store list --registry planning-store.yaml --json
corepack npm run scwbs -- store show --registry planning-store.yaml --store <store-id> --json
```

`store list`は各store rootをabsolute pathへresolveする。`store show`はrepository trust、dirty state、pinned commit、shared Spec content hash、path escape、dependency cycleをcheckする。missingまたはdirty/untrusted repository、stale pin、path escape、cycleはfail-closedし、clone、pull、push、credential loading、remote mutationは実行しない。Task、Evidence、Approval、Human Gate、CI、workset ownershipはrepository-localのままであり、worksetはcorrelationだけを提供する。JSON output versionは`scwbs.planning-store-list.v1`と`scwbs.planning-store-show.v1`である。

### `spec-change new`

target Specを変更せず、approval recordも作らずにproposed Spec Change Proposalを作成する。

```bash
npm run scwbs -- spec-change new \
  --spec SPEC-F001-API \
  --task WBS-001-004 \
  --summary "Add the documented response field" \
  --rationale "The current Spec does not define the field" \
  --proposed-version 1.1.0 \
  --level 2 \
  --affected-paths "contracts/specs/SPEC-F001-API.yaml,src/features/api/index.ts"
```

commandはTaskとtarget Specをvalidateし、`currentVersion`をderiveし、`contracts/spec-changes/`配下に`proposed` artifactを作成し、既存proposalのoverwriteを拒否する。Level 2 proposalは`approval.required: true`と`approval.status: requested`でmarkし、approvalはhuman-only operationとして残る。

```bash
npm run scwbs -- task start <task-id>
npm run scwbs -- project bootstrap "goal"
npm run scwbs -- discovery start "decision-driving goal"
npm run scwbs -- plan --spec SPEC-001
npm run scwbs -- lite task "small change title"
npm run scwbs -- promote --task SCWBS-001
```

`task start`はexisting Taskのpre-flight entrypointである。`project bootstrap`はbounded Discovery Probeだけを作成し、delivery Task Contractを作成せず、canonical WBSも直接rewriteしない。top-levelの`start <task-id>`はpre-flight commandのlegacy aliasとして残る。
