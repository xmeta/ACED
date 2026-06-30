# scwbs メタ健全性監査レポート

作成日: 2026-06-30

この文書は、2026-06-30 時点の `ACED` リポジトリについて、レビュー可能性、SC-WBS証跡、改行コード、サブモジュール状態、検証コマンドの観点で確認した結果を記録する。

## 確認コマンド

- `git status --short --branch`
- `git diff --stat`
- `git diff --check`
- `git ls-files --eol`
- `git -C wjs status --short --branch`
- `git -C wjs diff --stat`
- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run scwbs -- check`
- `npm run scwbs -- health`
- `npm run scwbs -- registry rebuild --check`
- `npm run scwbs -- check-diff --task <task-id>`

## 検出した問題

### レビュー不能な改行差分

調査時点の親リポジトリには、内容変更ではなく CRLF 化に由来する広範囲の差分があった。`git diff --check` は大量の trailing whitespace を報告し、実装変更と改行コード変更が混ざってレビューが難しい状態だった。

### `wjs` サブモジュールのdirty状態

`wjs` サブモジュール内にも広範囲の未コミット差分があった。Task Contractでは `wjs/**` が forbidden として扱われるが、親リポジトリの通常の差分確認だけではサブモジュール内部の状態を見落としやすい。

### Evidence鮮度とPR metadata不足

既存Evidenceには古い `git.headCommit` やPR metadata不足が残っていた。SCWBS-027でEvidence provenanceの検出は強化済みだが、古いEvidenceをどこまで更新するかは各タスクのスコープに分けて扱う必要がある。

## 影響

- 改行コード差分が実装レビューを妨げる。
- サブモジュール内のユーザー変更を、親リポジトリのpath gateだけでは見落とす。
- Evidenceが古いHEADを指すと、レビュー時に検証結果の鮮度を誤解しやすい。
- CIがないと、ローカルで通したSC-WBS検証をPR上で再確認できない。

## 短期対応

- `.gitattributes` と `.editorconfig` で主要テキストファイルをLF固定にする。
- `scwbs health` でtracked text fileのCRLFとdirty submoduleを警告する。
- `wjs` 内のdirty状態はユーザー変更の可能性があるため、このタスクではrevertしない。
- CI workflowで基本検証を実行する。

## 恒久対応

- PR作成後にEvidenceへPR metadataを記録する運用を徹底する。
- 古いEvidenceは各タスクの所有範囲で再採取する。
- サブモジュールの更新は専用タスクに分け、親リポジトリのSC-WBS evidenceと混ぜない。

## 追加知見: PR #15のコンフリクト解消

PR #15では、`origin/main` 側が先に `SCWBS-028` を使い、このPR側も同じ `contracts/tasks/SCWBS-028.yaml` と `contracts/evidence/SCWBS-028.yaml` を追加していたため add/add conflict が発生した。解消には、このPR側の作業を `SCWBS-029` にリネームし、Task Contract、Approval、Changeset、Evidence、Registryを再生成する必要があった。

この作業は実装価値を増やさない純粋な調整コストだった。再発防止として、`scwbs health` は現在ブランチが `origin/main` より遅れている場合と、双方が同じSC-WBS契約パスを異なる内容で追加している場合に警告する。Evidence採取やPR待ちの前にこの警告を解消することで、無駄なCI待ちとEvidence再採取を減らす。
