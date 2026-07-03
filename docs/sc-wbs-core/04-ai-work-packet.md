# 04. AI Work Packet And Context Control

AI Work Packet は、AIに実装を依頼するときの最小コンテキストである。

## 原則

```text
AIに長い仕様書一式を渡さない。
AIには、その作業に必要な小さい作業カードを渡す。
Context が足りないときだけ段階的に増やす。
```

## Packet Level

### Tiny Packet

既定は Tiny Packet とする。

```yaml
taskId: WBS-001
title: staff search API implementation
goal: staff search APIを実装する

allowedPaths:
  - src/features/staff-search/**
  - tests/features/staff-search/**

forbiddenPaths:
  - src/auth/**
  - src/database/**
  - migrations/**
  - package.json

humanGateRequiredPaths:
  - src/security/**
  - src/permissions/**
  - openapi/**

stopIf:
  - DB schema change needed
  - auth/permission change needed
  - API breaking change needed
  - business rule unclear
  - allowedPaths insufficient

checks:
  - npm test
  - npm run typecheck

whenDone:
  - scwbs finish
whenBlocked:
  - scwbs block "<reason>"
```

Tiny Packet には、AIが作業を始めるための最低限だけを含める。Task Contract 単体で足りる作業では、Task Contract 自体を Tiny Packet の代用として扱ってよい。

### Normal Packet

AIが追加コンテキストを必要とした場合だけ使う。

```yaml
acceptanceCriteria:
  - 権限のないユーザーは検索できない
  - 名前・資格・稼働状況で検索できる
  - 空結果は正常レスポンスとして返す

specSlice:
  feature: staff-search
  inputs:
    - name
    - qualification
    - availability
  outputs:
    - staffId
    - displayName
    - qualifications
  errors:
    - 401 unauthorized
    - 403 forbidden

relatedFiles:
  - docs/specs/staff-search.md#api
```

### Deep Packet

設計判断、影響範囲調査、レビューなどに限って使う。

```bash
scwbs packet --task WBS-001 --deep
```

Deep Packet には、関連WBS、ADR、周辺仕様、依存タスクなどを含めてよい。
ただし、実装AIの通常作業では使わない。

## Packetに必ず全文で含めるもの

次は要約してはいけない。

- `goal`
- `allowedPaths`
- `forbiddenPaths`
- `humanGateRequiredPaths`
- `stopIf`
- `checks`
- `whenDone`
- `whenBlocked`
- Acceptance Criteria。ただし長い場合は該当タスク分だけの Spec Slice にする。

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
scwbs packet --task WBS-001 --include acceptanceCriteria
```

## 実装AIに渡す標準プロンプト

```text
AGENTS.md と以下の Tiny Packet に従って作業してください。
Packetに含まれない作業は行わないでください。
allowedPaths外の変更が必要な場合は実装を止め、scwbs block "<reason>" を実行してください。
完了時は scwbs finish を実行してください。
```
