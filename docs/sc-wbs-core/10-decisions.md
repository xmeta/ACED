# 10. Design Decisions

この文書は、これまでの査読・議論から採用した設計判断を記録する。

## DEC-001: SC-WBSはCoreから始める

Full機能を最初から全部実装しない。

採用:

```text
SC-WBS Core = Task Contract + Packet + Diff Guard + Evidence + Human Gate
```

理由:

- AIに渡す文脈を減らすため
- 個人開発/小規模開発で運用コストを下げるため
- 価値の大きいガードレールから実装するため

## DEC-002: YAML/JSONは正本だがUIではない

採用:

```text
人間/AIは短い scwbs コマンドを使う。
YAML/JSONはコマンドが生成する。
```

理由:

- スキーマ理解コストを下げる
- AIの誤編集を減らす
- 人間の運用負担を減らす

## DEC-003: Tiny Packetを既定にする

採用:

```bash
scwbs packet --tiny
```

理由:

- 長い仕様をAIに読ませるとコストが増える
- 大きすぎる文脈は性能低下につながる
- 実装AIは作業範囲と停止条件を最優先に理解すべき

## DEC-004: EvidenceはsubjectHeadCommitとdiffHashを持つ

採用:

```yaml
git:
  subjectHeadCommit: abc1234
  evidenceCommit: null
  diffHash: sha256:...
```

理由:

- Evidenceファイル自身のコミットでHEADが変わる
- 単純なHEAD一致チェックではEvidenceがstaleになりやすい
- 承認対象差分を固定する必要がある

## DEC-005: ApprovalはPR番号だけに紐づけない

採用:

```yaml
pullRequest: "#42"
headCommit: abc1234
diffHash: sha256:...
```

理由:

- PR承認後に追加コミットされる可能性がある
- 古い承認を新しい差分に流用してはいけない

## DEC-006: completion applyはApprovalを生成しない

採用:

```text
completion apply は既存Approvalを検証するだけ。
```

理由:

- 完了処理が人間承認を捏造してはいけない
- approval approve と completion apply の責務を分離するため

## DEC-007: Human Gateを3種に分ける

採用:

```text
preImplementation
completion
release
```

理由:

- 実装前に止める判断と、Doneにする承認を混同しないため

## DEC-008: WBS-JSONはCoreでは任意にする

採用:

```text
小規模では Task Contract と tasks/index.yaml から始める。
必要になったらWBS-JSONへ昇格する。
```

理由:

- 最初からWBS管理を強制すると重い
- Coreの価値はまずAI作業ガードレールにある

## DEC-009: Task Contractを最初の実行カードとして扱う

採用:

```text
Tiny Packet が未実装でも、Task Contract を最初の実行カードとして使う。
追加文脈が必要な場合だけ Packet を足す。
```

理由:

- 現行実装でもすぐ運用に落とせる
- AIに最初から relation depth 付きPacket全文を渡す必要がない
- Tiny-first の考え方を現行CLIへ段階導入しやすい

## DEC-010: check-diffを最重要機能にする

採用:

```text
AIにルールを完全理解させるより、差分検査で止める。
```

理由:

- AIはミスをする
- 機械的に検出できる違反はツールで止めるべき

## DEC-011: AIはapproved recordを作らない

採用:

```text
AIは requested/block を作れる。
AIは approved を作れない。
```

理由:

- 最終判断は人間が行う
- Human Gateの責任境界を明確にする
