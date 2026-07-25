import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("canonical typecheck configuration", () => {
  test("checks production, tests, and JavaScript runners without changing the build", () => {
    const packageJson = readJson("package.json");
    const scripts = packageJson.scripts as Record<string, string>;

    expect(scripts.build).toBe("tsc -p tsconfig.json");
    expect(scripts.typecheck).toBe(
      "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.tests.json && tsc -p scripts/tsconfig.json"
    );
  });

  test("includes all test TypeScript with no output", () => {
    const config = readJson("tsconfig.tests.json");
    const compilerOptions = config.compilerOptions as Record<string, unknown>;

    expect(config.include).toEqual(["tests/**/*.ts"]);
    expect(config.exclude).toBeUndefined();
    expect(compilerOptions.noEmit).toBe(true);
    expect(compilerOptions.rootDir).toBe(".");
  });

  test("checks JavaScript runners while recording the implicit-any migration boundary", () => {
    const config = readJson("scripts/tsconfig.json");
    const compilerOptions = config.compilerOptions as Record<string, unknown>;

    expect(config.include).toEqual(["*.mjs"]);
    expect(compilerOptions.allowJs).toBe(true);
    expect(compilerOptions.checkJs).toBe(true);
    expect(compilerOptions.noEmit).toBe(true);
    expect(compilerOptions.noImplicitAny).toBe(false);
  });
});
