import { describe, expect, test } from "vitest";
import { matchesAny, matchesGlob, validateGlobPattern } from "../../src/core/glob.js";

describe("glob matching", () => {
  test("globstar matches zero or more path segments", () => {
    expect(matchesGlob("foo.ts", "**/*.ts")).toBe(true);
    expect(matchesGlob("src/foo.ts", "**/*.ts")).toBe(true);
    expect(matchesGlob("src/a/b/foo.ts", "src/**/foo.ts")).toBe(true);
    expect(matchesGlob("src/foo.ts", "src/**/foo.ts")).toBe(true);
    expect(matchesGlob("src/a/foo.js", "src/**/foo.ts")).toBe(false);
  });

  test("single star remains segment-local and separators normalize", () => {
    expect(matchesGlob("src\\features\\api.ts", "src/*/api.ts")).toBe(true);
    expect(matchesGlob("src/a/b/api.ts", "src/*/api.ts")).toBe(false);
    expect(matchesAny("src/a/b/api.ts", ["src/**/api.ts"])).toBe(true);
  });

  test("unsupported syntax is rejected instead of reinterpreted", () => {
    expect(validateGlobPattern("src/{api,web}/**")).toContain("only * and ** wildcards are supported");
    expect(validateGlobPattern("src/**.ts")).toContain("** must occupy a complete path segment");
    expect(matchesGlob("src/api/index.ts", "src/{api,web}/**")).toBe(false);
  });
});
