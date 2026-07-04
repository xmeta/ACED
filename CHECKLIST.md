# SC-WBS Core Revision Checklist

このファイルは、SC-WBS Core 改訂作業の進捗確認用入口である。
詳細チェックリストは次を参照する。

```text
docs/sc-wbs-core-revision/10-progress-checklist.md
```

改訂文書群の索引は次を参照する。

```text
docs/sc-wbs-core-revision/00-index.md
```

## 最短確認

```text
まず確認するもの:
1. M0 互換レイヤー
2. M1 Core Task Lifecycle
3. M2 Finish / Evidence / Diff Guard
4. M3 Human Gate / Approval Scope
5. M4 WBS Optional
6. M5 Full Enhancement
```

## 文書の読み分け

```text
現行作業の実行ルール:
- AGENTS.md
- 対象 Task Contract

現行Coreの基準説明:
- docs/sc-wbs-core/

次期Core改訂案:
- docs/sc-wbs-core-revision/
```

`docs/sc-wbs-core/` と `docs/sc-wbs-core-revision/` が食い違う場合は、現行作業では `AGENTS.md` と Task Contract を優先する。
改訂案の内容は、このチェックリストの対象項目をTask Contract化して実装・検証したあとに現行Coreへ反映する。

## 進捗記入ルール

Markdown のチェックボックスを使う。

```md
- [ ] 未着手
- [ ] 実装中: メモを書く
- [x] 完了
```

迷った場合は完了にしない。
完了条件、テスト、ドキュメント更新、後方互換確認が揃ったときだけ `[x]` にする。
