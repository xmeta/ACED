# scwbs 配布と互換性

## 利用者向け artifact

`scwbs` は GitHub Release に self-contained npm tarball を添付します。
利用者は ACED repository を clone したり `wjs` submodule を取得したりせず、
Release asset を一時 consumer project に install できます。

```bash
npm init -y
npm install ./scwbs-<version>.tgz
npx scwbs init
npx scwbs doctor
npx scwbs check
```

Release artifact の `dist/wjs-runtime/` には WJS の validator、apply tool、
schema が build 時に同梱されます。WJS の ownership は submodule 側に残り、
ACED はその実行資産を配布用に変換して保持します。

## 互換性

- Node.js: `>=22.12.0`
- npm: `>=10`（repository build と contributor setup）
- standalone consumer はインストール済み scwbs package の Node engine を検査する
- contributor は `git submodule update --init --recursive wjs` 後に repository の workspace を install する

packed artifact の境界は CI の `distribution` job と
`scripts/distribution-smoke.mjs` で検証します。検証対象は `--version`、
`init`、`doctor`、`check`、WJS validation/apply、必要 asset、submodule 不在です。

## Release policy

Release は main から手動 dispatch する `.github/workflows/release.yml` が
`npm pack` した tarball を GitHub Release に添付します。npm registry への
publish、repository visibility の変更、credential の追加は行いません。
