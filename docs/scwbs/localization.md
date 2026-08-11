# Localization bundles

ACED uses versioned `scwbs.locale.v1` bundles for generated agent guidance and selected CLI UX. Locale data is separate from agent adapters and templates. Stable JSON schema field names, machine error codes, approval semantics, and authority policy are never translated.

The built-in bundles are `ja`, `en`, and an additional `fr` fixture. `ja-jp` and `en-us` normalize deterministically to `ja` and `en`. An unknown valid locale falls back to `en`; malformed locale ids are rejected before initialization writes files.

Every bundle must contain the same bounded message keys as the reference bundle and use the same `{placeholder}` names. Missing keys, unknown keys, invalid placeholders, duplicate ids, and missing fallback targets fail closed. Bundle validation is covered by unit and integration tests.

`init --lang <locale>` renders localized guidance for a new project and explicitly switches an existing project. `update --lang <locale>` is the explicit lifecycle switch for all managed agents; both paths update only files whose recorded managed hash still matches and preserve user-owned divergent files. Adapter metadata keys are checked against the bundle key registry before generation.

Adding a locale does not require editing a TypeScript union. A bundle must be reviewed and validated as data, and locale changes must not modify authority semantics.
