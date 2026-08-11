# Localization bundles

ACED uses versioned `scwbs.locale.v1` bundles for generated agent guidance and selected CLI UX. Locale data is separate from agent adapters and templates. Stable JSON schema field names, machine error codes, approval semantics, and authority policy are never translated.

The built-in bundles are `ja`, `en`, and an additional `fr` fixture. `ja-jp` and `en-us` normalize deterministically to `ja` and `en`. An unknown valid locale falls back to `en`; malformed locale ids are rejected before initialization writes files.

Every bundle must contain the same bounded message keys as the reference bundle and use the same `{placeholder}` names. Missing keys, unknown keys, invalid placeholders, duplicate ids, and missing fallback targets fail closed. Bundle validation is covered by unit and integration tests.

`init --lang <locale>` renders localized guidance. Existing managed hashes and divergent-file protection remain authoritative: `agent update` preserves user-owned files and never overwrites a divergent translation.

Adding a locale does not require editing a TypeScript union. A bundle must be reviewed and validated as data, and locale changes must not modify authority semantics.
