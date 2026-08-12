# Localization bundles

ACEDはgenerated agent guidanceとselected CLI UXにversioned `scwbs.locale.v1` bundleを使う。locale dataはagent adapterとtemplateから分離する。stable JSON schema field name、machine error code、approval semantic、authority policyは翻訳しない。

built-in bundleは`ja`、`en`、追加の`fr` fixtureである。`ja-jp`と`en-us`はdeterministically `ja`と`en`へnormalizeする。unknown valid localeは`en`へfallbackし、malformed locale idはinitializationがfileを書き込む前にrejectする。

各bundleはreference bundleと同じbounded message keyを持ち、同じ`{placeholder}` nameを使う。missing key、unknown key、invalid placeholder、duplicate id、missing fallback targetはfail-closedになる。bundle validationはunit/integration testでcoverageする。

`init --lang <locale>`はnew project向けlocalized guidanceをrenderし、既存projectを明示的にswitchする。`update --lang <locale>`はmanaged agent全体のexplicit lifecycle switchである。両pathはrecorded managed hashが一致するfileだけをupdateし、user-owned divergent fileを保持する。adapter metadata keyはgeneration前にbundle key registryと照合する。

locale追加にTypeScript unionの編集は必要ない。bundleをdataとしてreview・validateし、locale changeでauthority semanticを変更してはならない。
