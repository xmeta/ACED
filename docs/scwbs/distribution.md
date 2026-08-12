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

GitHub Release には、npm registry を使わずに current stable を検証して導入する
依存なしの `scwbs-bootstrap.mjs` も添付します。bootstrap 自体は latest release
を解決できますが、consumer の dependency には検証済みの exact version tarball URL
だけを書き込みます。

```bash
curl --fail --silent --show-error --location \
  https://github.com/xmeta/ACED/releases/latest/download/scwbs-bootstrap.mjs \
  --output /tmp/scwbs-bootstrap.mjs
node /tmp/scwbs-bootstrap.mjs install --save-dev
```

変更前の確認には `--dry-run --json` を使えます。`--tag v<version>`、`--manifest <path>`、
`--artifact <path>` を指定すると、対象 Release または offline artifact を固定して検証できます。
verification failure、unknown option、network failure は package.json を変更しません。

Release artifact の `dist/wjs-runtime/` には WJS の validator、apply tool、
schema が build 時に同梱されます。WJS の ownership は submodule 側に残り、
ACED はその実行資産を配布用に変換して保持します。

## 互換性

- Node.js: `>=22.13.0` (required for the built-in `node:sqlite` module used by the local index)
- npm: `>=10`（repository build と contributor setup）
- standalone consumer はインストール済み scwbs package の Node engine を検査する
- contributor は `git submodule update --init --recursive wjs` 後に repository の workspace を install する

packed artifact の境界は CI の `distribution` job と
`scripts/distribution-smoke.mjs` で検証します。検証対象は `--version`、
`init`、`doctor`、`check`、WJS validation/apply、必要 asset、submodule 不在です。

## Version lifecycle

インストール済み CLI は release manifest を read-only に解決し、package version、
CLI version、release tag、commit、tarball digest を同じ subject として確認します。

```bash
npx scwbs version
npx scwbs version check --json
npx scwbs upgrade --dry-run --json
```

GitHub に接続できない環境では、取得済みの `release-manifest.json` と tarball を
指定して検証できます。`upgrade` は `--dry-run` が必須で、consumer の dependency
pin を自動変更しません。npm registry 公開や unattended upgrade の有効化は人間の
配布判断を必要とします。

## Release policy

`.github/workflows/release.yml` は、人間が作成した `v*.*.*` tag push または main からの
手動 dispatch を受け、release subject を先に確定し、対象 commit から `npm pack` した
tarball、`release-manifest.json`、`scwbs-bootstrap.mjs` を GitHub Release に添付します。
tag は workflow 内で作成せず、npm registry への
publish、repository visibility の変更、credential の追加は行いません。

workflow は次の順序を fail-closed で検証します。

1. 入力 tag が `v${package.json.version}` と一致すること
2. 既存 tag はその tag が指す commit を checkout し、新規 tag は現在の main
   commit を release subject とすること
3. 同じ subject SHA を head に持つ `.github/workflows/scwbs.yml` の
   `core`、`integration`、`wjs`、`distribution`、`validate` がすべて成功済みであること
4. versioned `CHANGELOG.md` section が存在すること
5. tarball filename、package version、release tag が一致し、manifest の SHA-256
   が生成 tarball と一致すること

既存 tag の subject mismatch、version mismatch、validation 不在、または
`Unreleased` section しかない CHANGELOG の場合は、tag や Release を作成せずに
失敗します。新規 tag は全検証と manifest 生成が終わった後、
`gh release create --target <subject-commit>` で初めて作成されます。

Release asset の検証例:

```bash
gh release download v0.1.0 --repo xmeta/ACED --pattern 'scwbs-*.tgz' --pattern release-manifest.json
sha256sum scwbs-0.1.0.tgz
node -e 'const m=require("./release-manifest.json"); console.log(m.commit, m.tag, m.packageVersion, m.sha256)'
```

表示された SHA-256、tag、package version、commit が manifest の値と一致することを
確認してから artifact を配布します。
