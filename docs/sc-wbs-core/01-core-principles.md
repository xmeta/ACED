# 01. SC-WBS Core Principles

## 目的

SC-WBS Core は、AI協調開発における **作業範囲の暴走** と **コンテキスト肥大** を抑えるための軽量ツールである。

## 中核原則

```text
1. AIは契約されていない作業をしない。
2. YAML/JSONは正本だが、人間/AIの通常UIではない。
3. 人間/AIは短い scwbs コマンドで契約・証跡・承認を生成する。
4. AIに渡す文脈は Tiny Packet を既定にする。
5. 範囲外変更は AIの善意ではなく check-diff で止める。
6. Done は自己申告ではなく Evidence で判断する。
7. 危険変更は Human Gate に戻す。
8. ツールは正しい仕様を自動決定しない。最終判断は人間が行う。
```

## 非目的

SC-WBS Core は、次を最初から解決しようとしない。

- すべてのWBS管理
- 完全なプロジェクトマネジメント
- 監査ログの完全性
- 複雑なReviewer routing
- Risk Registerの詳細管理
- 大規模組織の承認フロー全体
- 仕様の正しさの自動判断

これらは Full Profile または Strict Profile の範囲とする。

## 設計方針

### 小さいガードレールを優先する

AIに長い方法論を読ませるほど、コストは増え、誤読も増える。Core では、AIに読ませるのは作業カードだけにする。

### 手書きスキーマを避ける

YAML/JSONをGit管理の正本として残すことは有効である。ただし、人間やAIに直書きさせると、スキーマ理解コストと破損リスクが増える。

そのため、Core では次を原則とする。

```text
人間/AIの入力: scwbs コマンド
保存される正本: YAML/JSON
```

### ツールで機械判定できるものを優先する

AIに「守ってください」と頼るのではなく、次はツールで検出する。

- allowedPaths 外の変更
- forbiddenPaths への変更
- 危険メタファイル変更
- branch不一致
- Evidence欠落
- requiredChecks未実行
- Approval scope不一致

## 導入単位

Core は小規模プロジェクトでは WBS-JSON を必須にしない。

```text
Phase 1: Task Contract + Evidence + check-diff
Phase 2: tasks/index.yaml による簡易依存管理
Phase 3: WBS-JSON による構造管理
Phase 4: Full/Strict Profile
```
