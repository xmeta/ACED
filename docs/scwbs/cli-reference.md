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
npm run scwbs -- check-diff --task WBS-001-004
npm run scwbs -- status
```

`scwbs fix` only applies safe, deterministic fixes (currently: regenerating `contracts/registry.yaml`). It never edits Task Contracts, Evidence, Approvals, or WBS content, and never guesses at a fix for a failing check or a path violation; those always come with a `fixCommand` hint from `check` / `check-diff` / `finish` instead.

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
npm run scwbs -- evidence annotate --task WBS-001-004 --pull-request "#42" --test-assertions-added true --tests-disabled false --coverage-decreased false --test-quality-note "Added regression coverage"
npm run scwbs -- registry rebuild --check
npm run scwbs -- profile show
npm run scwbs -- profile set lean
```

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
npm run scwbs -- completion apply --tasks WBS-001-004 --task WBS-001-999 --reason "Reviewed and accepted"
npm run scwbs -- completion apply --tasks WBS-001-004 --task WBS-001-999 --reason "Reviewed and accepted" --apply
```

`review-queue` の既定出力は候補数に比例せず、review health集計、主要blocker集計、ready優先の上位候補、omitted件数、次のコマンドを表示する。候補の既定上限は5件で、`--limit <count>` で正の整数へ変更できる。従来の全候補・全理由・警告・blocker sectionが必要な場合は `--verbose`、機械処理には `--json` を使う。`--json` は明示した `--limit` がなければ全候補を返し、指定時は `candidates` と `omitted` に分ける。JSONの正式なshapeは [`schemas/review-queue-summary.schema.json`](schemas/review-queue-summary.schema.json) で定義する。`--json` と `--verbose` は同時指定できない。

`review route` previews requested reviewer roles from Evidence changed files. `review request` records those roles in `contracts/reviews/<task-id>.yaml` as `requestedReviewers`.

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

When `finish` requires Human Approval, its text output and JSON `nextAction` use only the currently implemented `approval approve` options. In particular, they do not emit unsupported `--approved-by` or `--human-confirm` options.

After a PR exists, refresh Evidence with `--pull-request` so review and completion queues can tie the work back to the reviewed PR. When `evidence collect --force` refreshes an existing Evidence file and no replacement PR is provided, it preserves the existing `git.pullRequest` value instead of dropping it.

`evidence collect` の既定成功出力は、Evidence YAML全文ではなく `path`、check集計、変更ファイル数、PRを含む固定5行のサマリである。機械処理にはversioned summaryを返す `--json`、サマリと全YAMLの確認には `--verbose`、YAMLだけをstdoutへpipeする場合は `--output -` を使う。これら3つの出力modeは同時指定できず、`--output` の対象は `-` のみである。JSONの正式なshapeは [`schemas/evidence-collect-summary.schema.json`](schemas/evidence-collect-summary.schema.json) で定義する。`finish` は内部のEvidence収集をquietに実行するが、failed check、Human Gate、次アクションなど `finish` 自身の重要な結果は省略しない。

`evidence annotate` は既存Evidenceの `git.pullRequest` と `testQuality` だけを更新し、`commit`、`subjectHeadCommit`、`diffHash`、`changedFiles`、`checks` を保持する。merge後のbranchやmetadata-only branchで元の実装Evidenceへ注記する場合は再収集ではなくこのコマンドを使う。既存のbranch-diff Evidenceが実装ファイルを記録しているのに、Task branch外の空差分から `evidence collect` しようとした場合、CLIはprovenance上書きを拒否する。

`finish` はrequired checks実行前にcontract lockとtestQuality metadataをpreflightし、Evidence・diff・registry検証後に対象Taskだけのhealth readinessを確認する。contractLock、tests変更時のtestQuality、PR metadata、Evidence provenance、Human Approval、既存Review scopeのwarningが残る場合はmerge-readyを表示せず、`fixCommand`を返す。repository全体のlegacy warningはこの判定へ含めない。`finish --json` の正式なshapeは [`schemas/finish-summary.schema.json`](schemas/finish-summary.schema.json) で定義する。

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
