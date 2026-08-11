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
  "agent.rules"
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
      "agent.rules": "- Stay in allowed paths.\n- Run checks and collect Evidence.\n- Stop for Human Gate or schema, dependency, auth, release decisions."
    }
  },
  {
    schemaVersion: LOCALE_BUNDLE_SCHEMA_VERSION,
    id: "ja",
    fallback: "en",
    messages: {
      "agent.header": "# SC-WBS",
      "agent.intro": "Follow AGENTS.md and Task Contract.",
      "agent.handoff": "Use Japanese for handoffs when practical.",
      "agent.rules": "- Stay in allowed paths.\n- Run checks and collect Evidence.\n- Stop for Human Gate or schema, dependency, auth, release decisions."
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
      "agent.rules": "- Restez dans les chemins autorisés.\n- Exécutez les vérifications et collectez les Evidence.\n- Arrêtez-vous pour un Human Gate ou une décision de schéma, dépendance, authentification ou publication."
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

export function renderAgentGuidance(locale: string | undefined, adapterGuidance: string): string {
  const resolved = resolveLocale(locale);
  for (const key of commonKeys) if (!resolved.bundle.messages[key]) throw new Error(`Missing locale message: ${key}`);
  return `${resolved.bundle.messages["agent.header"]}\n\n${resolved.bundle.messages["agent.intro"]}\n${resolved.bundle.messages["agent.handoff"]}\n\n${resolved.bundle.messages["agent.rules"]}\n\n${adapterGuidance}\n`;
}

export function localeMetadata(language: string): string {
  if (language === "ja") return "ja-JP";
  if (language === "en") return "en-US";
  return language;
}
