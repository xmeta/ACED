# 04. AI Work Packet And Context Control

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
- Depends On
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

## 実装AIに渡す標準プロンプト

```text
AGENTS.md と以下の Tiny Packet に従って作業してください。
Packetに含まれない作業は行わないでください。
allowedPaths外の変更が必要な場合は実装を止め、scwbs block "<reason>" を実行してください。
完了時は scwbs finish を実行してください。
```
