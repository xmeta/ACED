# scwbs CLI Reference

This file is the detailed command index. Keep `README.md` short and link here when command examples grow.

Run through the npm script:

```bash
npm run scwbs -- --help
```

## Core Checks

```bash
npm run scwbs -- init --profile lean --agent codex --lang ja
npm run scwbs -- check
npm run scwbs -- fix
npm run scwbs -- doctor
npm run scwbs -- health
npm run scwbs -- health --json
npm run scwbs -- health --verbose
npm run scwbs -- check-diff --task WBS-001-004
npm run scwbs -- status
```

`scwbs fix` only applies safe, deterministic fixes (currently: regenerating `contracts/registry.yaml`). It never edits Task Contracts, Evidence, Approvals, or WBS content, and never guesses at a fix for a failing check or a path violation; those always come with a `fixCommand` hint from `check` / `check-diff` / `finish` instead.

`health` の既定出力は同じissue codeをcount、代表2件、omitted件数へ集約し、warning数に比例してログが増えない。error、Human Gate、具体的な `fixCommand` を持つissueの順に優先表示する。全件表示は `--verbose`、機械処理はversioned schema `scwbs.health.v1` を返す `--json` を使う。JSONは集約前の全issueとcode別件数を保持する。shallow cloneではcommit到達性を `not-evaluated` と明示し、取得されていないcommitをunknownとして誤警告しない。`doctor` の既定textも同じsource/codeを代表2件へ集約するが、既存JSONは全issueを保持する。CRLF診断は `.gitattributes` 設定後の `git add --renormalize` を修復手順として返す。

## Governance Cost Metrics

```bash
npm run scwbs -- metrics governance
npm run scwbs -- metrics governance --json
```

`metrics governance` は永続artifactを作らないread-only計測で、現在のprofile、governance artifactのファイル数・bytes・行数、`src/**/*.ts` と `tests/**/*.ts` の分母、governance/source・governance/testの行比率を返す。JSONは `schemaVersion: "1.0.0"` と `metric: "governance-cost"` を持ち、Lean / Standard / Strictの対象directory別集計も含む。

GitHub remoteが設定され、`gh` が認証済みなら、同じsummaryの `historicalCi` に既存GitHub Actions runの先頭100件（GitHub APIの新しい順）を集計する。対象repository、取得上限、run数、完了runのみのduration、workflow・event・head branch別集計、最初と最後のtimestampを返す。`taskPullRequests` は `pull_request` eventの `task/SCWBS-*` branchだけをtask ID別にまとめ、run、completed、success、failure、その他の完了、未完了、durationを最新更新順の最大20件で返す。認証、通信、保持期間などにより取得できない場合は、0件・0秒と推測せず `status: unavailable` とreasonを返す。

`localRequiredChecks` はgit common dirに現存するtask別の最新canonical receiptをread-onlyで集計する。各checkの実行時間、観測・未観測check数、receipt期間、最大20件のtask trendを返す。durationを持たないlegacy receiptは有効な未観測値として扱い、0秒へ変換しない。git common dirやreceipt directoryを読めない場合も0件とせず `status: unavailable` とreasonを返す。receiptは全required checksが成功したときだけ保存され、taskごとに上書きされるため、失敗・旧attemptを含む全local履歴ではない。finish試行、metadata descendant、Human Gate wait、publish loop、health warning delta、warning budgetは未計測であり、hard limitは導入しない。

行数はUTF-8の改行数に、末尾改行がない空でないファイルの1行を加えた値である。`status: archived` または `archive` / `archived` directoryのartifactはactiveと分離する。未計測項目はJSONへ明示し、hard limitやprofile downgradeは行わない。

## AI Workflow

```bash
npm run scwbs -- ai packet --task WBS-001-004 --relation-depth 1
npm run scwbs -- ai run --task WBS-001-004 --agent codex
npm run scwbs -- ai block --task WBS-001-004 --reason "Human Gate required"
npm run scwbs -- ai next-task
npm run scwbs -- next
```

`ai run` is initially a dry-run orchestrator. It prints the pre-flight checks, implementation stop conditions, and post-flight checks rather than launching an external agent.

`ai next-task` is a planned-task handoff command. It only lists Task Contracts whose WBS node is `planned`, whose dependencies are complete, and whose Human Gate paths do not require approval before implementation. If it prints `No available planned tasks` but also says follow-up work remains, do not infer that the project is done; run `scwbs next` to get the next Evidence or review action for existing contracts.

`scwbs next` is the local follow-up command. It prioritizes stale task locks, missing Evidence, and review queue work before falling back to planned-task candidates.

### Block lifecycle

`ai block` and the Core alias `block "<reason>"` create an active Block record. Active Blocks are excluded from `ai next-task` and appear as completion prerequisites in `review-queue`.

Resolving a Block is an explicit human action. After making the required decision, a human runs:

```bash
npm run scwbs -- block resolve --task WBS-001-004 --reason "Human decision and outcome"
```

AI agents must not run `block resolve`. The command updates the existing record to `status: resolved`; it does not delete it. The record retains creation and resolution events in `history`, and the registry exposes the current status. A later `ai block` call reactivates the same record while preserving the earlier lifecycle history. Resolved Blocks no longer exclude a task from `ai next-task` and no longer block `review-queue` completion.

## Contracts

```bash
npm run scwbs -- task new "Fix parser" --paths "src/core/parser.ts,tests/unit/parser.test.ts" --stop "schema change required" --wbs-node node-parser
npm run scwbs -- task new "Draft only" --no-stop-conditions
npm run scwbs -- task generate --node node-api --task WBS-001-004
npm run scwbs -- task lock --task WBS-001-004
npm run scwbs -- task refresh --task WBS-001-004
npm run scwbs -- task refresh --task WBS-001-004 --apply
npm run scwbs -- task refresh --affected
npm run scwbs -- task refresh --all
npm run scwbs -- task refresh --all --apply
npm run scwbs -- evidence collect --task WBS-001-004
npm run scwbs -- evidence collect --task WBS-001-004 --pull-request "#42" --force
npm run scwbs -- evidence collect --task WBS-001-004 --test-assertions-added true --tests-disabled false --coverage-decreased false --test-quality-note "Added regression coverage" --force
npm run scwbs -- evidence collect --task WBS-001-004 --json --force
npm run scwbs -- evidence collect --task WBS-001-004 --verbose --force
npm run scwbs -- evidence collect --task WBS-001-004 --output - --force
npm run scwbs -- checks run --task WBS-001-004
npm run scwbs -- checks run --task WBS-001-004 --json
npm run scwbs -- checks run --task WBS-001-004 --rerun-checks
npm run scwbs -- evidence annotate --task WBS-001-004 --pull-request "#42" --test-assertions-added true --tests-disabled false --coverage-decreased false --test-quality-note "Added regression coverage"
npm run scwbs -- registry rebuild --check
npm run scwbs -- profile show
npm run scwbs -- profile set lean
```

`task new` はfail-closedである。`--paths` 未指定では `allowedPaths: []`、`--wbs-node` 未指定では `wbsNodeId: wbs-less` を生成する。`--stop` または明示的な `--no-stop-conditions` がなければartifactを書かず失敗する。広範scopeはwarningとTiny Packetの `Scope Risk` で確認できる。

`checks run` はrequired checksの正規実行入口であり、全check成功時だけGit common directoryへ一時receiptをatomicに保存する。receiptはtask ID、HEAD、subject fingerprint、resolved command、lockfile hash、Node/platform、recursive submodule statusを記録する。直後の `evidence collect` / `finish` は現在のHEAD、差分、lockfile、submodule、commandが完全一致するpassed resultだけを再利用する。failed、壊れた、古いreceiptは再利用せず、生の `npm test` 等の自己申告もreceiptとして扱わない。`--rerun-checks` は有効なreceiptも無視して再実行する。既定出力はcheckごとの実行・再利用理由だけにbounded化し、正式なJSON shapeは [`schemas/checks-run-summary.schema.json`](schemas/checks-run-summary.schema.json) で定義する。

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

## Review And Approval

```bash
npm run scwbs -- review-queue
npm run scwbs -- review-queue --limit 10
npm run scwbs -- review-queue --json
npm run scwbs -- review-queue --verbose
npm run scwbs -- review route --task WBS-001-004
npm run scwbs -- review request --task WBS-001-004 --pull-request "#42"
npm run scwbs -- approval request --task WBS-001-004 --pull-request "#42" --note "Awaiting human review"
npm run scwbs -- approval approve --task WBS-001-004 --pull-request "#42" --actor human --reason "Evidence and PR reviewed"
SCWBS_APPROVAL_DELEGATION_TOKEN="<secret>" npm run scwbs -- approval approve --task WBS-001-004 --pull-request "#42" --actor delegated-ai --scope post-finish --reason "Authorized unattended execution"
npm run scwbs -- completion apply --tasks WBS-001-004 --task WBS-001-999 --reason "Reviewed and accepted"
npm run scwbs -- completion apply --tasks WBS-001-004 --task WBS-001-999 --reason "Reviewed and accepted" --apply
```

`review-queue` の既定出力は候補数に比例せず、review health集計、主要blocker集計、ready優先の上位候補、omitted件数、次のコマンドを表示する。候補の既定上限は5件で、`--limit <count>` で正の整数へ変更できる。従来の全候補・全理由・警告・blocker sectionが必要な場合は `--verbose`、機械処理には `--json` を使う。`--json` は明示した `--limit` がなければ全候補を返し、指定時は `candidates` と `omitted` に分ける。JSONの正式なshapeは [`schemas/review-queue-summary.schema.json`](schemas/review-queue-summary.schema.json) で定義する。`--json` と `--verbose` は同時指定できない。

`review route` previews requested reviewer roles from Evidence changed files. `review request` records those roles in `contracts/reviews/<task-id>.yaml` as `requestedReviewers` and synchronizes the derived `contracts/registry.yaml` in the same successful operation. Use `--json` to obtain the written artifacts and next action.

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

`--actor delegated-ai` は、Task Contractの `approvalPolicy.mode: delegated` で明示的に委譲されたTaskだけに使える。`--scope human-gate|post-finish` は必須で、policyの `scopes`、UTC `expiresAt`、`tokenSha256` と32 bytes以上の環境変数 `SCWBS_APPROVAL_DELEGATION_TOKEN` を検証する。policy未指定、`human-only`、token欠落・不一致、弱いtoken、期限切れ、scope不一致はすべてfail-closedになる。tokenは出力・永続化せず、成功時は `approvalMode: delegated`、`delegationSource`、`delegatedBy`、`executedBy: ai-agent`、`delegationScope`、`delegationProof` を記録してHuman Approvalと区別する。consumerもHMAC proofを再検証し、Human Gateでは`human-gate`、completionでは`post-finish`だけを受理する。

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

When `finish` requires Human Approval, its text output and JSON `nextAction` use only the currently implemented `approval approve` options. In particular, they do not emit unsupported `--approved-by` or `--human-confirm` options.

After a PR exists, refresh Evidence with `--pull-request` so review and completion queues can tie the work back to the reviewed PR. When `evidence collect --force` refreshes an existing Evidence file and no replacement PR is provided, it preserves the existing `git.pullRequest` value instead of dropping it.

`evidence collect` の既定成功出力は、Evidence YAML全文ではなく `path`、check集計、変更ファイル数、PRを含む固定5行のサマリである。機械処理にはversioned summaryを返す `--json`、サマリと全YAMLの確認には `--verbose`、YAMLだけをstdoutへpipeする場合は `--output -` を使う。これら3つの出力modeは同時指定できず、`--output` の対象は `-` のみである。JSONの正式なshapeは [`schemas/evidence-collect-summary.schema.json`](schemas/evidence-collect-summary.schema.json) で定義する。`finish` は内部のEvidence収集をquietに実行するが、failed check、Human Gate、次アクションなど `finish` 自身の重要な結果は省略しない。

`evidence annotate` は既存Evidenceの `git.pullRequest` と `testQuality` だけを更新し、`commit`、`subjectHeadCommit`、`diffHash`、`changedFiles`、`checks` を保持する。merge後のbranchやmetadata-only branchで元の実装Evidenceへ注記する場合は再収集ではなくこのコマンドを使う。既存のbranch-diff Evidenceが実装ファイルを記録しているのに、Task branch外の空差分から `evidence collect` しようとした場合、CLIはprovenance上書きを拒否する。

`finish` はrequired checks実行前にcontract lockとtestQuality metadataをpreflightし、check結果をまずcandidate Evidenceとしてmemory上に構築する。failed checkまたはHuman Gate以外のcheck-diff違反ではcandidateを破棄するため、既存EvidenceとRegistryを上書きしない。検証済みcandidateはEvidenceとRegistryを同じrollback unitとして置換し、Human Gate待ちはこの整合checkpointを保存して `awaiting-human-approval` を返す。checkpoint途中の書き込み失敗は両fileを開始前の内容へ戻す。

完了時のnext actionはEvidenceとReviewのPR metadataを正規化して決定する。両方のPR番号が不一致なら修正command付きで停止し、PR番号がなければ新規PR作成、既存PRがあればdraft、checks pending、checks failure、checks success、未mergeのclosed、mergedの状態に応じてready化、checks監視、failure確認、merge、reopen、main同期を案内する。未mergeのclosed PRでは過去のchecks結果にかかわらずmergeやchecks watchへ進まず、`gh pr reopen <number>`を案内するため、必要に応じてEvidence / ReviewのPR metadataを確認してから再開する。`gh pr view`が未導入・未認証などで状態を取得できない場合も、新規PR作成へ戻らず、repository-local metadataの既存PR番号を使ったchecks確認へ安全にdegradeする。plain出力とJSONの `nextAction` / `resumeCommand` は同じcommandを返す。

永続fileを変更せずに開始条件だけを確認する場合は `npm run scwbs -- finish --task <task-id> --preflight` を使う。これはrequired checksも実行しない。`finish --json` は全終了経路で `phase`、`outcome`、実際に変更した `mutatedFiles`、再開用の `resumeCommand` を返す。Evidence provenance、Human Approval、既存Review scopeのwarningが残る場合はmerge-readyを表示せず、`fixCommand`を返す。PR metadataの欠落自体は新規PR作成のnext actionとなり、EvidenceとReviewのPR番号不一致はactionable errorとして停止する。repository全体のlegacy warningはこの判定へ含めない。正式なJSON shapeは [`schemas/finish-summary.schema.json`](schemas/finish-summary.schema.json) で定義する。

### Command and required-check single-flight

`npm run scwbs -- ...` はGit common directory内のcommand lockを取得してからTypeScript buildとCLIを実行する。worktreeをまたぐ並列呼び出しも同じlockを共有し、2本目はactive PID、command、開始時刻、current check、経過時間をstderrへbounded表示して待機する。read-only commandを含む全commandをbuildからCLI終了まで直列化するのが既定policyであり、共有`dist/`の書き換え中に別commandを実行しない。PIDが存在しないstale lockは次回実行が安全に回収する。

`finish` と `evidence collect` のrequired checksは、さらにrepository-level single-flight lockを使う。各checkの開始・完了、cache hitをstderrへ1行で表示し、30秒以上継続するcheckは30秒ごとにtask ID、check index/name、PID、開始時刻、経過時間をheartbeatとして出す。成功ログ量はcheck自身の出力量に比例せず、JSON modeでもstdoutは単一のversioned JSONのまま維持される。同一subjectで待機後に再実行されたcommandは既存のcheck cacheを再利用し、required checkを重複実行しない。

`npm run test:integration` と `npm run test:integration:verbose` も同じGit common directory内のrequired-check lockを取得するため、直接runner同士、および `checks run` / `evidence collect` / `finish` 配下のintegrationとsuiteを重複実行しない。既定は競合時にactive PID、開始時刻、mode、worker数、経過時間をbounded stderrへ表示して拒否し、待機する場合だけ `npm run test:integration -- --wait` を明示する。stale PID lockは回収し、所有中のlockは正常終了、failure、signal interruptionで解放する。worktreeはGit common directoryを共有し、独立cloneのCI jobは共有しない。`npx vitest run tests/integration` のようなraw Vitest直接起動はこのrunnerを通らないため、排他保証の対象外である。

For a changed submodule gitlink, `evidence collect` records nested changed files, old/new commits, repository, and whether the new commit is an ancestor of the configured upstream merge-target ref. Configure dependent PR, `upstreamRef`, and upstream check metadata in the Task Contract's `submoduleDependencies`. Packet and `review-queue` then show the required order: merge the dependent PR before the parent PR. `check-diff` blocks unreachable submodule heads and non-passed submodule checks; collection fails instead of treating an unavailable nested diff as empty.

When task changes include tests, record test quality metadata with `--test-assertions-added`, `--tests-disabled`, `--coverage-decreased`, and `--test-quality-note`. Forced Evidence refreshes preserve existing `testQuality` metadata when no replacement values are supplied.

`completion apply` completes reviewed WBS nodes without hand-written YAML. By default it is a dry-run that prints the approvals and `changeNodeStatus` operations it would write. With `--apply`, it validates existing approved records, writes `contracts/changesets/<completion-task-id>-complete-reviewed-work.json`, applies the WBS changeset, and rebuilds the registry. It refuses root-node completion by default; use `--allow-root` only after explicit human decision.

## Lightweight Entry Points

```bash
npm run scwbs -- start "natural language goal"
npm run scwbs -- plan --spec SPEC-001
npm run scwbs -- lite task "small change title"
npm run scwbs -- promote --task WBS-001-004
```

These commands generate drafts or candidates. They do not directly rewrite the canonical WBS.

## Trace And UI

```bash
npm run scwbs -- trace --task WBS-001-004
npm run scwbs -- ui
npm run scwbs -- serve
```

`ui` is a text dashboard. `serve` is intentionally a stub until a dependency change passes Human Gate.

## WBS

```bash
npm run scwbs -- wbs validate
npm run scwbs -- wbs apply change-set.json
```

WBS operation details and validation commands are documented in `docs/scwbs/wjs-operations-validation.md`.

## Build Output

After building:

```bash
npm run build
node dist/cli.js --help
```
