# scwbs CLI Reference

This file is the detailed command index for the `scwbs` CLI bundled with ACED (package name `scwbs`). Keep `README.md` short and link here when command examples grow.

Run through the npm script:

```bash
npm run scwbs -- --help
```

> **表記規約（Conventions）**
>
> - 説明文は日本語、コマンド名・オプション名・フィールド名・コード例は英語のまま記載する。
> - Task IDの例は本ドキュメント全体で `SCWBS-*` 形式に統一する（理由は「Task IDとブランチ命名」を参照）。従来この文書には `WBS-001-004` のような例が混在していたが、これは実装が生成する正規のID形式ではない。
> - コマンドが**変更するもの**（tracked files / git common dir / network）は「Mutation / Read-only 一覧」で分類する。
> - 終了コードは「終了コード」の節にある実装済みの値だけを記載する。文書化されていない終了コードは存在しないものとして扱う。

## Trace And UI

## GitHub Issue intake

```bash
npm run scwbs -- intake github-issue 123 --json
npm run scwbs -- discovery from-github-issue 123 --dry-run --json
```

`intake github-issue` performs a read-only, structured GitHub Issue lookup and returns `scwbs.github-issue-intake.v1`. The normalized snapshot contains bounded untrusted issue fields and provenance (`repository`, number, source URL, digest, and `observedAt`). `--expected-digest` reports changed content as `stale`.

`discovery from-github-issue` requires `--dry-run` and returns a Discovery-only candidate. It never creates or approves a Task Contract, writes to GitHub, interprets Issue prose as policy, or persists credentials/tokens. Missing `gh`, unavailable GitHub, malformed payloads, and unauthorized access fail closed without changing local workflow authority.

```bash
npm run scwbs -- trace --task SCWBS-001
npm run scwbs -- ui
npm run scwbs -- serve
npm run scwbs -- mcp --stdio
```

`ui` is a text dashboard.

`serve` starts an offline, localhost-only, read-only dashboard using Node's standard HTTP server. It binds to `127.0.0.1` and accepts `--port 0` to select a free local port:

```bash
npm run scwbs -- serve --port 0
```

The dashboard exposes only GET projections under `/api/v1/`: `health`, `dashboard`, and `trace?task=<id>`. It reuses the existing `ui --json` and `trace --json` evaluators, includes bounded Risk summaries, and never exposes approval/review/mutation operations or arbitrary repository files. The HTML and JSON responses are bounded, offline, CSP-protected, and do not render secrets or delegation tokens. Remote bind, authentication, dependencies, and write APIs remain outside this Task and require a separate Human Gate.

`mcp --stdio` is the supported local integration surface. It fixes the repository root at startup and rejects alternate cwd, traversal, unknown resources, invalid Task IDs, and unbounded messages. It does not expose a remote server or accept shell command strings.

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

When task changes include tests, record manual test quality metadata with `--test-assertions-added`, `--tests-disabled`, `--coverage-decreased`, and `--test-quality-note`. Evidence collection separately records versioned `testQualityObservation` data from the branch diff. It counts added/modified/deleted test files and newly added `skip`/`only`/`todo` markers; when the previous Evidence coverage receipt is verified at the current base commit, it also records the line coverage delta. Missing or mismatched baseline provenance is `not-evaluated` and never becomes a false `0` or `false`. Forced Evidence refreshes preserve existing manual `testQuality` metadata when no replacement values are supplied.
