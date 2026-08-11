export const LOCALE_BUNDLE_SCHEMA_VERSION = "scwbs.locale.v1" as const;

export type LocaleId = string;

export type LocaleBundle = {
  schemaVersion: typeof LOCALE_BUNDLE_SCHEMA_VERSION;
  id: LocaleId;
  fallback: LocaleId;
  messages: Record<string, string>;
};

const commonKeys = [
  "agent.header",
  "agent.intro",
  "agent.handoff",
  "agent.rules",
  "agent.guidance.common"
] as const;

export const LOCALE_MESSAGE_KEYS = [
  ...commonKeys,
  "agent.guidance.codex",
  "agent.guidance.claude",
  "agent.guidance.cursor",
  "agent.guidance.copilot",
  "agent.guidance.gemini",
  "agent.guidance.opencode"
] as const;

const bundles: readonly LocaleBundle[] = [
  {
    schemaVersion: LOCALE_BUNDLE_SCHEMA_VERSION,
    id: "en",
    fallback: "en",
    messages: {
      "agent.header": "# SC-WBS",
      "agent.intro": "Follow AGENTS.md and Task Contract.",
      "agent.handoff": "Use English for handoffs.",
      "agent.rules": "- Stay in allowed paths.\n- Run checks and collect Evidence.\n- Stop for Human Gate or schema, dependency, auth, release decisions.",
      "agent.guidance.common": "Use the SC-WBS workflow.",
      "agent.guidance.codex": "Use scwbs packet --task <id>.",
      "agent.guidance.claude": "Use npm run scwbs -- packet --task <id>.",
      "agent.guidance.cursor": "Use the Task Contract for every edit.",
      "agent.guidance.copilot": "Use SC-WBS CLI commands through npm.",
      "agent.guidance.gemini": "Use npm run scwbs -- packet --task <id>.",
      "agent.guidance.opencode": "Use the Task Contract for every edit."
    }
  },
  {
    schemaVersion: LOCALE_BUNDLE_SCHEMA_VERSION,
    id: "ja",
    fallback: "en",
    messages: {
      "agent.header": "# SC-WBS",
      "agent.intro": "AGENTS.md と Task Contract に従ってください。",
      "agent.handoff": "Use Japanese for handoffs when practical.",
      "agent.rules": "- 許可されたパス内に留まってください。\n- チェックを実行し、Evidence を収集してください。\n- Human Gate、スキーマ、依存関係、認証、リリースに関する判断では停止してください。",
      "agent.guidance.common": "SC-WBS のワークフローを使用してください。",
      "agent.guidance.codex": "scwbs packet --task <id> を使用してください。",
      "agent.guidance.claude": "npm run scwbs -- packet --task <id> を使用してください。",
      "agent.guidance.cursor": "すべての編集で Task Contract を使用してください。",
      "agent.guidance.copilot": "SC-WBS CLI コマンドは npm 経由で実行してください。",
      "agent.guidance.gemini": "npm run scwbs -- packet --task <id> を使用してください。",
      "agent.guidance.opencode": "すべての編集で Task Contract を使用してください。"
    }
  },
  {
    schemaVersion: LOCALE_BUNDLE_SCHEMA_VERSION,
    id: "fr",
    fallback: "en",
    messages: {
      "agent.header": "# SC-WBS",
      "agent.intro": "Suivez AGENTS.md et le Task Contract.",
      "agent.handoff": "Utilisez le français pour les transmissions lorsque c'est possible.",
      "agent.rules": "- Restez dans les chemins autorisés.\n- Exécutez les vérifications et collectez les Evidence.\n- Arrêtez-vous pour un Human Gate ou une décision de schéma, dépendance, authentification ou publication.",
      "agent.guidance.common": "Utilisez le workflow SC-WBS.",
      "agent.guidance.codex": "Utilisez scwbs packet --task <id>.",
      "agent.guidance.claude": "Utilisez npm run scwbs -- packet --task <id>.",
      "agent.guidance.cursor": "Utilisez le Task Contract pour chaque modification.",
      "agent.guidance.copilot": "Utilisez les commandes CLI SC-WBS via npm.",
      "agent.guidance.gemini": "Utilisez npm run scwbs -- packet --task <id>.",
      "agent.guidance.opencode": "Utilisez le Task Contract pour chaque modification."
    }
  }
];

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)].map((match) => match[1]).sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function listLocaleBundles(): LocaleBundle[] {
  return bundles.map((bundle) => ({ ...bundle, messages: { ...bundle.messages } }));
}

export function normalizeLocaleId(value: string | undefined): LocaleId | undefined {
  if (value === undefined) return "ja";
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (!/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(normalized)) return undefined;
  if (normalized === "ja-jp") return "ja";
  if (normalized === "en-us") return "en";
  return normalized;
}

export function validateLocaleBundle(bundle: unknown, reference: LocaleBundle = bundles[0]): string[] {
  if (!isRecord(bundle)) return ["locale.bundle.object"];
  const issues: string[] = [];
  if (bundle.schemaVersion !== LOCALE_BUNDLE_SCHEMA_VERSION) issues.push("locale.bundle.schemaVersion");
  if (typeof bundle.id !== "string" || !normalizeLocaleId(bundle.id)) issues.push("locale.bundle.id");
  if (typeof bundle.fallback !== "string" || !normalizeLocaleId(bundle.fallback)) issues.push("locale.bundle.fallback");
  if (!isRecord(bundle.messages)) return [...issues, "locale.bundle.messages"];
  const messages = bundle.messages;
  for (const key of commonKeys) {
    if (typeof messages[key] !== "string" || messages[key].length === 0) issues.push(`locale.message.missing:${key}`);
  }
  for (const key of Object.keys(messages)) {
    if (typeof messages[key] !== "string" || messages[key].length > 8192) issues.push(`locale.message.invalid:${key}`);
    if (!(key in reference.messages)) issues.push(`locale.message.unknown:${key}`);
    else if (typeof messages[key] === "string" && JSON.stringify(placeholders(messages[key])) !== JSON.stringify(placeholders(reference.messages[key]))) {
      issues.push(`locale.placeholder.mismatch:${key}`);
    }
  }
  for (const key of Object.keys(reference.messages)) {
    if (!(key in messages)) issues.push(`locale.message.missing:${key}`);
  }
  return issues;
}

export function validateLocaleKeys(keys: readonly string[]): string[] {
  const available = new Set<string>(LOCALE_MESSAGE_KEYS);
  return [...new Set(keys.filter((key) => !available.has(key)).map((key) => `locale.key.unknown:${key}`))];
}

export function validateLocaleBundles(input: readonly LocaleBundle[] = bundles): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  const reference = input.find((bundle) => bundle.id === "en") ?? input[0];
  if (!reference) return ["locale.bundle.empty"];
  for (const bundle of input) {
    if (ids.has(bundle.id)) issues.push(`locale.bundle.duplicate:${bundle.id}`);
    ids.add(bundle.id);
    issues.push(...validateLocaleBundle(bundle, reference));
  }
  for (const bundle of input) {
    if (!ids.has(bundle.fallback)) issues.push(`locale.fallback.missing:${bundle.id}:${bundle.fallback}`);
  }
  return [...new Set(issues)];
}

export function resolveLocale(value: string | undefined): { requested: LocaleId; id: LocaleId; fallbackUsed: boolean; bundle: LocaleBundle } {
  const requested = value === undefined ? "ja" : normalizeLocaleId(value) ?? value.trim().toLowerCase();
  const selected = bundles.find((bundle) => bundle.id === requested);
  if (selected) return { requested, id: selected.id, fallbackUsed: false, bundle: { ...selected, messages: { ...selected.messages } } };
  const fallback = bundles.find((bundle) => bundle.id === "en") ?? bundles[0];
  return { requested, id: fallback.id, fallbackUsed: true, bundle: { ...fallback, messages: { ...fallback.messages } } };
}

export function localeMessage(locale: string | undefined, key: string): string {
  const resolved = resolveLocale(locale);
  const message = resolved.bundle.messages[key];
  if (!message) throw new Error(`Missing locale message: ${key}`);
  return message;
}

export function renderAgentGuidance(locale: string | undefined, adapterGuidance: string, adapterLocaleKey?: string): string {
  const resolved = resolveLocale(locale);
  const bundleIssues = validateLocaleBundles();
  if (bundleIssues.length > 0) throw new Error(`Invalid locale bundles: ${bundleIssues.join(",")}`);
  for (const key of commonKeys) if (!resolved.bundle.messages[key]) throw new Error(`Missing locale message: ${key}`);
  if (adapterLocaleKey && validateLocaleKeys([adapterLocaleKey]).length > 0) throw new Error(`Unknown locale key: ${adapterLocaleKey}`);
  const localizedAdapterGuidance = adapterLocaleKey ? resolved.bundle.messages[adapterLocaleKey] : adapterGuidance;
  if (!localizedAdapterGuidance) throw new Error(`Missing locale message: ${adapterLocaleKey ?? "adapter guidance"}`);
  return `${resolved.bundle.messages["agent.header"]}\n\n${resolved.bundle.messages["agent.intro"]}\n${resolved.bundle.messages["agent.handoff"]}\n\n${resolved.bundle.messages["agent.rules"]}\n\n${resolved.bundle.messages["agent.guidance.common"]}\n${localizedAdapterGuidance}\n`;
}

export function localeMetadata(language: string): string {
  if (language === "ja") return "ja-JP";
  if (language === "en") return "en-US";
  return language;
}
