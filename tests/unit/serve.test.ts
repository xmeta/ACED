import { describe, expect, test } from "vitest";
import { dashboardHtmlForTest, parseServePort } from "../../src/core/serve.js";

describe("localhost dashboard server", () => {
  test("bounds and validates ports", () => {
    expect(parseServePort(undefined)).toBe(0);
    expect(parseServePort("0")).toBe(0);
    expect(parseServePort(65535)).toBe(65535);
    expect(() => parseServePort("65536")).toThrow("serve.port.invalid");
    expect(() => parseServePort("remote")).toThrow("serve.port.invalid");
  });

  test("ships an offline page with no external origins and escaped text rendering", () => {
    const html = dashboardHtmlForTest();
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("connect-src 'self'");
    expect(html).toContain("textContent");
    expect(html).not.toMatch(/https?:\/\//);
  });
});
