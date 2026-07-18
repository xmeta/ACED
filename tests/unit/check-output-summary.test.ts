import { describe, expect, test } from "vitest";
import { CHECK_OUTPUT_SUMMARY_LIMIT, summarizeCheckOutput } from "../../src/core/check-output-summary.js";

function diagnostic(index: number): string {
  return [
    `failed test=tests/integration/example-${index}.test.ts :: failure ${index}`,
    `cause=expected ${index} to equal ${index + 1}`,
    `rerun=npx vitest run tests/integration/example-${index}.test.ts -t \"failure ${index}\"`
  ].join("\n");
}

describe("summarizeCheckOutput", () => {
  test.each(["head", "middle", "tail"])("preserves a diagnostic group at the %s of long output", (position) => {
    const noise = "noise ".repeat(300);
    const parts = position === "head"
      ? [diagnostic(1), noise, noise]
      : position === "middle"
        ? [noise, diagnostic(1), noise]
        : [noise, noise, diagnostic(1)];
    const summary = summarizeCheckOutput(parts.join("\n"));
    expect(summary).toContain("failed test=tests/integration/example-1.test.ts :: failure 1");
    expect(summary).toContain("cause=expected 1 to equal 2");
    expect(summary).toContain("rerun=npx vitest run tests/integration/example-1.test.ts");
    expect(summary?.length).toBeLessThanOrEqual(CHECK_OUTPUT_SUMMARY_LIMIT);
  });

  test("deduplicates diagnostics and prevents repeated progress from displacing them", () => {
    const progress = Array.from({ length: 100 }, (_, index) =>
      `scwbs progress task=T check=1/1:test status=executed elapsed=${index}s pid=${100 + index} startedAt=2026-01-01T00:00:00Z`
    ).join("\n");
    const summary = summarizeCheckOutput(`${diagnostic(1)}\n${diagnostic(1)}\n${progress}`);
    expect(summary?.match(/^failed test=/gm)).toHaveLength(1);
    expect(summary).toContain("rerun=npx vitest run");
    expect(summary).toContain("[progress summaries=1]");
    expect(summary?.length).toBeLessThanOrEqual(CHECK_OUTPUT_SUMMARY_LIMIT);
  });

  test("keeps complete multiple failures up to the limit and reports omitted groups", () => {
    const summary = summarizeCheckOutput(Array.from({ length: 12 }, (_, index) => diagnostic(index)).join("\n"));
    expect(summary).toContain("failed test=tests/integration/example-0.test.ts");
    expect(summary).toMatch(/\[\d+ diagnostic group\(s\) omitted\]/);
    expect(summary?.length).toBeLessThanOrEqual(CHECK_OUTPUT_SUMMARY_LIMIT);
    for (const block of summary?.split(/\n(?=failed test=|\[\d+ diagnostic)/) ?? []) {
      if (block.startsWith("failed test=")) {
        expect(block).toContain("cause=");
        expect(block).toContain("rerun=");
      }
    }
  });

  test.each([
    "timeout while waiting for integration report",
    "report unavailable\n" + "tail ".repeat(400),
    "failed test=tests/integration/incomplete.test.ts :: incomplete\n" + "noise ".repeat(400),
    "marker-free output\n" + "body ".repeat(400)
  ])("uses a bounded fail-closed fallback for %s", (output) => {
    const summary = summarizeCheckOutput(output);
    expect(summary?.length).toBeLessThanOrEqual(CHECK_OUTPUT_SUMMARY_LIMIT);
    expect(summary).toContain(output.split("\n")[0]?.slice(0, 40));
  });

  test("normalizes CRLF and redacts credential-shaped values before retention", () => {
    const jwt = "eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop";
    const summary = summarizeCheckOutput(
      `failed test=x :: y\r\ncause=Authorization: Bearer top-secret-token\r\nrerun=TOKEN=plain-secret node test\r\nAPI_KEY=also-secret\r\n${jwt}`
    );
    expect(summary).toContain("failed test=x :: y");
    expect(summary).toContain("cause=Authorization: Bearer [redacted]");
    expect(summary).toContain("rerun=TOKEN=[redacted] node test");
    expect(summary).not.toContain("top-secret-token");
    expect(summary).not.toContain("plain-secret");
    expect(summary).not.toContain("also-secret");
    expect(summary).not.toContain(jwt);
  });

  test("returns undefined for empty output or an invalid limit", () => {
    expect(summarizeCheckOutput("")).toBeUndefined();
    expect(summarizeCheckOutput("content", 0)).toBeUndefined();
  });
});
