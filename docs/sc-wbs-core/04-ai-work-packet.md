# 04. AI Work Packetとコンテキスト制御

AI Work Packet は、AIに実装を依頼するときの最小コンテキストである。

## 原則

```text
AIに長い仕様書一式を渡さない。
AIには、その作業に必要な小さい作業カードを渡す。
Context が足りないときだけ段階的に増やす。
```

## Packet Level

3段階のPacket Levelを用意する。

### Tiny Packet (`--tiny`)

既定は Tiny Packet とする。タスクID、Objective、Paths、Checks、Next のみを含む。

```text
# Tiny Packet
Task: WBS-001-004
Node: API Implementation
Objective:
- staff search APIを実装する
Allowed:
- src/features/staff-search/**
Forbidden:
- src/database/**
Human Gate:
- src/security/**
Checks:
- npm test
- npm run typecheck
Next:
- npm run scwbs -- finish --task WBS-001-004
- npm run scwbs -- block "reason" --task WBS-001-004
```

Tiny Packet には、AIが作業を始めるための最低限だけを含める。
以下の情報は含めない：
- 長い方法論説明
- 詳細な背景文書
- 過去のレビュー全文
- 不要なWBS全体
- 関連性の低いdocs

### Standard Packet (`--standard`)

AIが追加コンテキストを必要とした場合だけ使う。

```bash
scwbs packet --task WBS-001 --standard
```

Standard Packet には、Tiny Packet の内容に加えて以下を含める：
- WBS Node の詳細（Code、Type、Status、Feature）
- Subtree Phase
- 依存関係（Depends On）
- Context Filter（relation depth 0）
- Related Relations
- Output Artifacts
- Stop Conditions（日本語の7条件）

### Full Packet (`--full`)

設計判断、影響範囲調査、レビューなどに限って使う。

```bash
scwbs packet --task WBS-001 --full
```

Full Packet には、Standard Packet の内容に加えて relation depth 1 の関連WBSノードを含める。
ただし、実装AIの通常作業では使わない。

## Packetに必ず全文で含めるもの

次は要約してはいけない。

- `objective`
- `allowedPaths`
- `forbiddenPaths`
- `humanGateRequiredPaths`
- `requiredChecks`
- `acceptance criteria`
- `explicit instructions`（Next: finish / block）

## Packetで要約してよいもの

- 背景説明
- 親タスク/兄弟タスク
- 長い設計資料
- 参考ADR
- 過去の議論

## 不足コンテキストがある場合

AIは、すぐに全文読み込みを要求してはいけない。まず不足している情報を短く特定する。Spec全文より Spec Slice を優先する。

例:

```text
不足情報:
- staff search API の検索条件の正式なAcceptance Criteria
- 権限エラー時のHTTP status

推奨:
scwbs packet --task WBS-001 --standard
```

## read-only Context Manifest（`--context-json`）

実装前のコード探索を小さく始める場合は、source本文を含まないderived manifestを生成する。

```bash
npm run scwbs -- packet --task WBS-001 --context-json
```

manifest v1はTask Contractと現在HEADから毎回再生成し、次をJSONで返す。

- Task Contract、exact allowed file、direct static relative import、reverse importerのpath/hash/bytes/line range/reason
- `editable`（allowedPaths内かつforbidden/Human Gate外の場合だけtrue）
- check coverageのrequired/missing/unclassified
- selected files/bytes、omitted件数、widening/completeness
- source本文を含めず、編集権限やrequired check省略を許可しないという制約

広いglobは全展開しない。dynamic import、re-export、path alias、unresolved import、cycle、budget超過、未分類pathはwidening理由として残す。manifestはナビゲーション情報であり、Task Contract、Approval、Evidence、required checksの代替ではない。

versioned JSON schemaは [`docs/scwbs/schemas/code-context-manifest.schema.json`](../../docs/scwbs/schemas/code-context-manifest.schema.json) で定義する。schemaVersionは `1.0.0` で、追加・変更はchangeset経由のschema version bumpで行う。

選定規則は以下の通りである。

1. `mustRead` にTask Contractを常に含める。
2. `allowedPaths` のexact path（globを含まない）で、HEADに存在し、forbiddenでもHuman Gateでもないものを `candidates` のseedとする。
3. seedからdirect static relative importを再帰的に追跡し、解決できたものを `candidates` に加える。理由は `direct-static-import:<seed>:<line>` とする。
4. repository内の全source fileからseedへのreverse importを追跡し、解決できたものを `candidates` に加える。理由は `reverse-importer:<seed>:<line>` とする。
5. `candidates` の追加は `budget.maxFiles` と `budget.maxBytes` で打ち切り、打ち切られたものを `excluded` に `budget-exceeded` 理由で残す。
6. broad glob、存在しないexact path、forbidden/Human Gate path、dynamic import、re-export、path alias、未解決import、import cycle、check coverage未分類・未対応は `widening` 診断として残す。
7. `completeness.status` は `widening` が空なら `complete`、それ以外は `widening-required` とする。
8. `constraints.sourceContentIncluded`、`grantsEditAuthority`、`permitsRequiredCheckOmission` は manifest v1 では常に `false` とする。

## 実装境界とWBS関連付け

Task-oriented contextの実装は、次の境界を維持する。

- TaskがWBS完了へ参加するか、参照nodeが存在するか、どのnodeへ解決されたかは `taskWbsAssociation` の結果（`wbs-less` / `missing-node` / `node`）を正本とする。`missing-node`をWBS-lessとして縮小してはならない。
- CLIのcommand registrationはdiscovery、governance、task、WBSのdomain moduleへ分離する。公開command名、option、help、exit code、JSON schemaはこの内部境界の変更理由だけでは変えない。
- Context manifestはread-only navigationのままとする。実読込telemetry、persistent index、hard budget enforcementは、効果とauthorityを独立に判断する後続事項であり、manifest v1へ暗黙追加しない。

## 実装AIに渡す標準プロンプト

```text
AGENTS.md と以下の Tiny Packet に従って作業してください。
Packetに含まれない作業は行わないでください。
allowedPaths外の変更が必要な場合は実装を止め、scwbs block "<reason>" を実行してください。
完了時は scwbs finish を実行してください。
```
