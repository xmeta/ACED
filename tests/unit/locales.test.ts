import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { listLocaleBundles, renderAgentGuidance, resolveLocale, validateLocaleBundle, validateLocaleBundles, validateLocaleKeys } from "../../src/core/locales.js";

describe("locale bundles", () => {
  test("bundles are versioned, complete, and include an extensibility fixture", () => {
    expect(validateLocaleBundles()).toEqual([]);
    const fixture = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/locales/fr.json"), "utf8"));
    expect(validateLocaleBundle(fixture)).toEqual([]);
    expect(listLocaleBundles().map((bundle) => bundle.id)).toEqual(expect.arrayContaining(["ja", "en", "fr"]));
  });

  test("fallback is deterministic and machine-facing keys are not translated by guidance rendering", () => {
    expect(resolveLocale("en-US")).toMatchObject({ id: "en", fallbackUsed: false });
    expect(resolveLocale("unknown-locale")).toMatchObject({ id: "en", fallbackUsed: true });
    expect(renderAgentGuidance("fr", "Use scwbs packet --task <id>.")).toContain("Use scwbs packet --task <id>.");
  });

  test("Japanese guidance translates prose while retaining stable project terms", () => {
    const guidance = renderAgentGuidance("ja", "Use scwbs packet --task <id>.", "agent.guidance.codex");
    expect(guidance).toContain("AGENTS.md と Task Contract に従ってください。");
    expect(guidance).toContain("許可されたパス内に留まってください。");
    expect(guidance).toContain("scwbs packet --task <id>");
    expect(guidance).not.toContain("Follow AGENTS.md and Task Contract.");
  });

  test("adapter locale metadata rejects unknown message keys", () => {
    expect(validateLocaleKeys(["agent.guidance.codex", "agent.guidance.common"])).toEqual([]);
    expect(validateLocaleKeys(["agent.guidance.missing"])).toEqual(["locale.key.unknown:agent.guidance.missing"]);
  });

  test("missing keys and placeholder mismatches fail closed", () => {
    const reference = listLocaleBundles()[0];
    const missing = { ...reference, id: "xx", messages: { "agent.header": "# x" } };
    expect(validateLocaleBundle(missing)).toEqual(expect.arrayContaining(["locale.message.missing:agent.intro"]));
    const placeholder = { ...reference, id: "xx", messages: { ...reference.messages, "agent.header": "# {name}" } };
    expect(validateLocaleBundle(placeholder)).toEqual(expect.arrayContaining(["locale.placeholder.mismatch:agent.header"]));
  });
});
