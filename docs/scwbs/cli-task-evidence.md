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

## AIのワークフロー

```bash
npm run scwbs -- ai packet --task SCWBS-001 --relation-depth 1
npm run scwbs -- ai run --task SCWBS-001 --agent codex
npm run scwbs -- ai execute --task SCWBS-001 \
  --implementer-command '["node","./adapters/implementer.mjs"]' \
  --reviewer-command '["node","./adapters/reviewer.mjs"]' --json
npm run scwbs -- ai block --task SCWBS-001 --reason "Human Gate required"
npm run scwbs -- ai next-task
npm run scwbs -- next
```

`ai run`はinitially dry-run orchestratorである。external agentをlaunchせず、pre-flight check、implementation stop condition、post-flight checkを表示する。

`ai execute`はbounded Phase 1/2 runnerである。shell stringではなくJSON command arrayを受け付け、ちょうど1つのTask iterationを開始し、bounded Work Packetをimplementerへ送り、Taskの既存required checkを実行し、別fresh-context inputをreviewerへ送る。adapter processには`SCWBS_RUNNER_ROLE`と`SCWBS_RUNNER_CONTEXT_ID`を渡し、approval delegation tokenはenvironmentから削除する。各adapterはfinal argumentで渡されたoutput pathへversioned JSON resultを書かなければならない。optional JSON provider descriptor（`--implementer-provider`、`--reviewer-provider`、`--debugger-provider`）はadapterに必要なrole、`fresh-context`、`json-io` capabilityを宣言し、unsupported declarationはspawn前にfail-closedする。bounded `--learned-note`はsource Task ID、source HEAD SHA、scope、advisory noteだけを持つ。preflight、path/authority check、required check、adapter result、reviewer decisionのfailureはblocked `scwbs.ai-run-receipt.v1`を生成し、後続stageをskipする。

runnerはApproval、human-only Review transition、commit、pull request、mergeを作成しない。Phase 2 debugger/remediationは2 roundにboundedし、resumeはfail-closedのままである。既定ではreceiptをgit common directoryの`scwbs-ai-execution`配下のderived local stateとして書き、Taskごとに最新1件を保持し、wall time、adapter turn、remediation round、required-check reuse rateを記録する。plan、input、result、receiptのshapeは[`ai-execution.schema.json`](schemas/ai-execution.schema.json)で定義する。

`ai next-task`はplanned-task handoff commandである。WBS nodeが`planned`、dependencyがcomplete、Human Gate pathがimplementation前approvalを要求しないTask Contractだけを列挙する。eligible candidateはoptionalなTask Contract `priority`（`high`、`medium`、`low`）、次にTask IDでorderする。priorityなしtaskはpriorityありの後に残り、既存のTask ID fallbackを維持する。`No available planned tasks`と表示されてもfollow-up workが残ると表示された場合、projectがDoneだと推測せず、`scwbs next`でexisting contractの次のEvidenceまたはreview actionを確認する。

`scwbs next`はlocal follow-up commandである。planned-task candidateへfallbackする前に、stale task lock、missing Evidence、review queue workを優先する。

### `packet` と `ai packet` は別コマンドである

この2つは**エイリアスではなく、独立したコマンド**である。

| Command                       | 親               | 用途                                                                                                  | 主なoption                                                                                                                                                             |
| ----------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scwbs packet --task <id>`    | top-level (Core) | Tiny/Standard/Full packetまたは `--context-json` のcode contextを構築する                             | `--tiny` `--standard` `--full` `--deep` `--normal` `--context-json` `--context-max-files` `--context-max-bytes` `--context-include-noncurrent-docs` `--relation-depth` |
| `scwbs ai packet --task <id>` | `ai`             | AI agent向けのwork packetを、agent別format（`default`/`compact`/`codex`/`claude`/`cursor`）で構築する | `--relation-depth` `--format`                                                                                                                                          |

両方とも `--task` を取り、内部で似た情報源を参照するが、出力shapeとformat optionは異なる。通常の作業開始では軽量なtop-level `packet` を優先し、agent別formatや追加関係情報が必要な場合だけ `ai packet` を使う。

### Blockのライフサイクル

`ai block`とCore alias `block "<reason>"`はactive Block recordを作成する。Active Blockは`ai next-task`から除外され、`review-queue`ではcompletion prerequisiteとして表示される。

Blockのresolveはexplicit human actionである。required decisionを行った後、人間が次を実行する。

```bash
npm run scwbs -- block resolve --task SCWBS-001 --reason "Human decision and outcome"
```

AI agentは`block resolve`を実行してはならない。commandはexisting recordを`status: resolved`へupdateし、deleteはしない。recordはcreation/resolution eventを`history`に保持し、registryはcurrent statusを公開する。後続の`ai block` callは同じrecordをreactivateし、以前のlifecycle historyを保持する。Resolved Blockは`ai next-task`からtaskを除外せず、`review-queue` completionもblockしない。

## Contract

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
npm run scwbs -- evidence import-ci --task SCWBS-001 --readiness /tmp/pr-readiness.json --ci-receipt /tmp/ci-receipt.json
npm run scwbs -- evidence import-ci --task SCWBS-001 --readiness /tmp/pr-readiness.json --ci-receipt /tmp/ci-receipt.json --coverage-receipt /tmp/coverage-receipt.json
npm run scwbs -- evidence verify-attestation --task SCWBS-001 --artifact dist/release.tar.gz --json
npm run scwbs -- evidence verify-attestation --task SCWBS-001 --artifact /tmp/release.tar.gz --bundle /tmp/attestation.bundle.json --custom-trusted-root /tmp/trusted-root.json --json
npm run scwbs -- checks run --task SCWBS-001
npm run scwbs -- checks run --task SCWBS-001 --json
npm run scwbs -- checks run --task SCWBS-001 --rerun-checks
npm run scwbs -- evidence annotate --task SCWBS-001 --pull-request "#42" --test-assertions-added true --tests-disabled false --coverage-decreased false --test-quality-note "Added regression coverage"
npm run scwbs -- registry rebuild --check
npm run scwbs -- profile show
npm run scwbs -- profile set lean
```

`task refresh`はbounded stale-lock workflowである。previewは変更されたlock input（scoped WBS、global policy、referenced node、Spec lock）を報告し、operationをlock metadata onlyに分類する。`allowedPaths`、`forbiddenPaths`、`doneCriteria`、`requiredChecks`、`humanGateRequiredPaths`を変更せず、semantic contract changeのapprovalでもない。WBS/Spec changeに新しいauthorityが必要ならstopし、Human Approvalまたはnew Task/Spec workflowを使う。`--affected`は常にpreview-onlyであり、`--all --apply`はexplicit bulk migrationで、implicit repairとして使ってはならない。

`profile set`はexisting `extensions.scwbs` fieldをpreserveし、timestamped `setDocumentExtension` changesetを`contracts/changesets/`配下へ書き、WJS経由でcanonical WBSへapplyする。apply failure時もdirect WBS writeへfallbackしない。Profileは`wbsGlobalRevision`の一部なので、後で`task refresh --affected`をinspectし、意図したTask Contractだけをrefreshする。

`task new` はfail-closedである。`--paths` 未指定では `allowedPaths: []`、`--wbs-node` 未指定では `wbsNodeId: wbs-less` を生成する。`--stop` または明示的な `--no-stop-conditions` がなければartifactを書かず失敗する。広範scopeはwarningとTiny Packetの `Scope Risk` で確認できる。

`evidence import-ci` は、`.github/workflows/scwbs.yml` の `pull_request` 実行が生成した
versioned `scwbs.pr-readiness.v1` artifact と、同じartifact digestで束ねられた
provenance-verified CI receiptを、tracked Evidenceへ取り込む入口である。readinessの
repository、Task、PR、HEAD、workflow run、workflow path、validate status、receipt
digestを検証し、続けて既存のCI receipt検証とEvidence/Registryのatomic更新を行う。
artifactはcheckout外の一時ディレクトリへダウンロードして指定すること。PRコードを
実行するjobはread-only権限であり、`workflow_run` のtrusted reporterだけがboundedな
PR commentをupsertする。commentは状態表示のみで、Approval、Review、mergeを作成・実行
しない。fork、HEAD変更、workflow変更、receipt改変、digest不一致はfail-closedになる。

`evidence verify-attestation --task <id> --artifact <path> --json` は、artifact の SHA-256
digestと既存 Evidence の subject、repository、signer workflow、predicate、source commit/ref
を束縛して `gh attestation verify` を構造化引数で呼び出す。結果は
`scwbs.attestation-verification.v1` の `verified`、`missing`、`invalid`、
`subject-mismatch`、`untrusted`、`unavailable` に限定され、本文・鍵・token は保存しない。
Evidenceにはlocator、digest、identity summary、reason codeだけを記録する。offline検証は
`--bundle` と `--custom-trusted-root` の明示指定を要求し、trust rootを自動取得・追加しない。
workflow権限、issuer/trust rootの採用、fork/untrusted PRの署名境界、release公開はこのCLIの
対象外でありHuman Gateで停止する。

`task new` は `--paths` / `--wbs-node` / `--stop` 以外にも、次のカンマ区切りoptionを取る。

| Option              | 対応するTask Contract field                                |
| ------------------- | ---------------------------------------------------------- |
| `--forbid <paths>`  | `forbiddenPaths`                                           |
| `--gate <paths>`    | `humanGateRequiredPaths`                                   |
| `--checks <checks>` | `requiredChecks` (baseline `test,typecheck,build` +追加値) |

```bash
npm run scwbs -- task new "Add permission check" \
  --paths "src/features/staff-search/**,tests/features/staff-search/**" \
  --forbid "src/auth/**,src/database/schema/**" \
  --gate "src/security/**,openapi/**" \
  --checks "test,typecheck,lint" \
  --stop "auth redesign required" \
  --wbs-node node-staff-search
```

`task new --checks` は置換ではなく additive semantics である。指定した値は
`test,typecheck,build` に追加され、重複は除去される。したがって
`--checks lint` でも安全性のbaselineは失われない。baselineを変更する必要がある場合は、
通常のCLI optionではなく、監査可能なTask Contract/authority workflowとして明示的に扱う。
check名は小文字のnpm script形式（必要なら `:` と `-` を含む）でなければならず、
不正な値はTask Contractを書き込む前に拒否される。

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

Generated contract commandは、explicitな`--force` optionがdocumentされ指定されない限りexisting fileのoverwriteを拒否しなければならない。

`task lock`はscoped revisionとglobal revisionに分けたversion 2 lockを書く。scoped revisionはreferenced WBS node、ancestor、transitive `dependsOn` subgraph、そのnodeがproduce/consumeするartifactを対象とし、unrelated sibling nodeは意図的に除外する。global revisionはWBS identity、root identity、schema version、root `extensions.scwbs` policyを対象とする。

`task refresh --affected`はpreview-onlyで、scoped WBS、global policy、Spec lockが変更されたTask Contractを列挙する。`task refresh --all`は全Task Contractをpreviewし、`--apply`はexplicit bulk migrationまたはrefreshの場合だけ追加する。既存の`wbsRevision` whole-file lockはreadableなままlegacy lockとして`--affected`に報告される。1つは`task refresh --task <id> --apply`で、全ては`task refresh --all --apply`で明示的にmigrateする。

### `--force` の意味はコマンドごとに異なる

`--force` はこの文書の複数のコマンドに登場するが、**何を上書きし、何を上書きしないか**はコマンドごとに異なる。「forceなら何でも通る」わけではない。

| Command                          | `--force` が行うこと                                                  | `--force` でも迂回**されない**もの                       |
| -------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| `evidence collect --force`       | 既存Evidenceファイルの置換を許可する                                  | required checks、provenance検証、path検証、Human Gate    |
| `registry rebuild --force`       | registry.yamlの再生成・書き込みを許可する                             | Task Contract / Evidence / Approvalの内容                |
| `task index rebuild --force`     | index全体のcanonical path・branch・WBS node・並び順の再構築を許可する | 既存のlifecycle status、`dependsOn`、`archivedAt`        |
| `wbs apply <change-set> --force` | `dryRun: true` のchangesetをpreviewではなく適用対象にする             | changeset自体のバリデーション。Task/Approvalは参照しない |

`evidence collect --force` と `task generate --force` は、それぞれの表に記載したfail-closed境界を無効化しない。一方、`wbs apply` はTask IDを受け取らずApproval recordも検証しないため、`--force`実行前のHuman GateはTask Contractと運用手順で別途保証する必要がある。個別コマンドの`--help`または本節の説明で対象範囲を確認すること。
