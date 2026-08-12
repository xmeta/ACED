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

## TraceとUI

## GitHub Issueの取り込み

```bash
npm run scwbs -- intake github-issue 123 --json
npm run scwbs -- discovery from-github-issue 123 --dry-run --json
```

`intake github-issue`はread-onlyかつstructuredなGitHub Issue lookupを行い、`scwbs.github-issue-intake.v1`を返す。normalized snapshotはbounded untrusted issue fieldとprovenance（`repository`、number、source URL、digest、`observedAt`）を含む。`--expected-digest`はchanged contentを`stale`として報告する。

`discovery from-github-issue`は`--dry-run`を要求し、Discovery-only candidateを返す。Task Contractをcreateまたはapproveせず、GitHubへwriteせず、Issue proseをpolicyとして解釈せず、credential/tokenをpersistしない。missing `gh`、unavailable GitHub、malformed payload、unauthorized accessはlocal workflow authorityを変更せずfail-closedする。

```bash
npm run scwbs -- trace --task SCWBS-001
npm run scwbs -- ui
npm run scwbs -- serve
npm run scwbs -- mcp --stdio
```

`ui`はtext dashboardである。

`serve`はNode standard HTTP serverを使うoffline、localhost-only、read-only dashboardを起動する。`127.0.0.1`へbindし、free local portを選ぶため`--port 0`を受け付ける。

```bash
npm run scwbs -- serve --port 0
```

dashboardは`/api/v1/`配下のGET projection、`health`、`dashboard`、`trace?task=<id>`だけを公開する。existing `ui --json`と`trace --json` evaluatorを再利用し、bounded Risk summaryを含めるが、approval/review/mutation operationやarbitrary repository fileは公開しない。HTML/JSON responseはbounded、offline、CSP-protectedで、secretやdelegation tokenをrenderしない。remote bind、authentication、dependency、write APIはこのTask外であり、separate Human Gateが必要である。

`mcp --stdio`はsupported local integration surfaceである。startup時にrepository rootを固定し、alternate cwd、traversal、unknown resource、invalid Task ID、unbounded messageをrejectする。remote serverを公開せず、shell command stringを受け付けない。

## WBS

```bash
npm run scwbs -- wbs validate
npm run scwbs -- wbs candidates
npm run scwbs -- wbs verify-changesets --base contracts/wbs/project.wbs.json --head contracts/wbs/project.wbs.json --changeset contracts/changesets/change-set.json
npm run scwbs -- wbs apply change-set.json
```

`wbs candidates`は`contracts/tasks/index.yaml`をinspectし、対応するWBS nodeがまだないactive Task IDについて、humanが`wbs apply`前にreviewするdry-run `addNode` changeset（Taskごとに1 node）を表示する。自分では何もwriteしない。`wbs verify-changesets`は`--base <wbs.json>`の上で`--changeset <path>`（repeatable）をreplayした結果が`--head <wbs.json>`と完全一致するかをcheckする。これはchangesetのreproducibility checkでありgeneral-purpose validatorではなく、writeもしない。

`wbs apply` 自体が検証するのはchangesetとWBSであり、Task Contract、Evidence、Approvalは入力に取らない。`check-diff` のHuman Gateも対象Taskの `humanGateRequiredPaths` にWBS pathが一致するときだけ作動する。したがって「WBS書き込み前にHuman Gateを通す」は運用policyであり、現行CLIが全WBS変更へ一律に自動適用する保証ではない。機械強制が必要なTaskでは `contracts/wbs/project.wbs.json` をTask開始前から `humanGateRequiredPaths` に固定し、Approval scopeをEvidence/diffと一致させる。

WBS operation detailとvalidation commandは`docs/scwbs/wjs-operations-validation.md`に記載する。

## Commandとrequired-check single-flight

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

changed submodule gitlinkでは、`evidence collect`がnested changed file、old/new commit、repository、new commitがconfigured upstream merge-target refのancestorかどうかを記録する。dependent PR、`upstreamRef`、upstream check metadataはTask Contractの`submoduleDependencies`へ設定する。Packetと`review-queue`はrequired order（parent PR前にdependent PRをmerge）を表示する。`check-diff`はunreachable submodule headとnon-passed submodule checkをblockし、unavailable nested diffをemptyとして扱わずcollectionをfailする。

task changeにtestが含まれる場合は、`--test-assertions-added`、`--tests-disabled`、`--coverage-decreased`、`--test-quality-note`でmanual test quality metadataを記録する。Evidence collectionはbranch diffからversioned `testQualityObservation` dataも別に記録する。added/modified/deleted test fileとnewly added `skip`/`only`/`todo` markerを数え、previous Evidence coverage receiptがcurrent base commitでverifyされる場合はline coverage deltaも記録する。missingまたはmismatched baseline provenanceは`not-evaluated`であり、誤って`0`や`false`にはしない。Forced Evidence refreshはreplacement valueがない場合、existing manual `testQuality` metadataをpreserveする。
