# 05. Diff, Evidence, And Approval Rules

この文書は、SC-WBS Core における差分・証跡・承認の一貫性ルールを定義する。

## 問題意識

Evidence や Approval をPR番号だけに紐づけると、承認後の追加コミットを検出できない。
また、Evidenceの `headCommit` を現在HEADと比較すると、Evidenceファイル自体をコミットしただけでstaleになる。

そのため、Core では次を分ける。

```text
subjectHeadCommit: Evidenceが証明する対象の実装HEAD
evidenceCommit: Evidenceファイル自体を含むコミット
diffHash: baseCommitからsubjectHeadCommitまでの正規化差分hash
```

## diffHash

`diffHash` は、承認対象の差分を固定するための値である。

推奨計算対象:

```text
- baseCommit
- subjectHeadCommit
- changedFiles path list
- normalized git diff content
```

正規化では、環境依存の情報を除外する。

除外候補:

- absolute path
- line ending differences, unless relevant
- generated timestamp
- Evidence file itself

## Evidence検証ルール

`scwbs finish` は次を満たす Evidence を生成する。

```text
- git.baseCommit が存在する
- git.subjectHeadCommit が存在する
- git.subjectHeadCommit は現在branchの到達可能commitである
- git.diffHash が現在のbranch diffから再計算できる
- changedFiles が実際のdiffと一致する
- requiredChecks が実行されている
```

`scwbs health` は、単純に「EvidenceのheadCommitが現在HEADと一致するか」を見てはいけない。
代わりに、次を見る。

```text
- subjectHeadCommit が現在branchの祖先または現在HEADであるか
- diffHash がPR差分と一致するか
- Evidence生成後に対象ファイル差分が変わっていないか
```

## Approval検証ルール

Approval は、承認時点の差分に対する人間判断である。

Approval 最小構成:

```yaml
pullRequest: "#42"
headCommit: abc1234
diffHash: sha256:...
```

`scwbs approve` は、承認時点で `headCommit` と `diffHash` を保存する。

`scwbs check-diff` または `scwbs finish --pr` は、次の場合に承認を無効扱いにする。

```text
- PRの現在HEADが approval.headCommit と異なる
- 現在diffHashが approval.diffHash と異なる
- Approval作成後に humanGateRequiredPaths の差分が変わった
```

## Completion apply の制約

`completion apply` は、人間承認を生成してはいけない。

許可されること:

```text
- 既存の approved Approval を検証する
- Approval の headCommit/diffHash と現在PR差分の一致を確認する
- WBS状態変更のdry-runを表示する
- 明示的な --apply で状態変更を適用する
```

禁止されること:

```text
- missing approved records を自動生成する
- 人間の承認なしで completed にする
- 古いApprovalを現在差分に流用する
```

## Human Gate対象差分のCI判定

Standard以上では、次をErrorにする。

```text
- humanGateRequiredPaths に変更がある
- 対応するApprovalがない
- Approvalはあるが headCommit/diffHash が一致しない
```

LeanではWarningにしてもよいが、completed化はしてはいけない。

## WBS changeset再現性

WBSを使う場合、`contracts/changesets/*.json` が存在するだけでは不十分である。

検証ルール:

```text
baseのproject.wbs.json
  + changesetsを順に適用
  = HEADのproject.wbs.json
```

一致しない場合、`check-diff` はErrorにする。
