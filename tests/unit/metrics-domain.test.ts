import { describe, expect, test } from "vitest";
import { numericValues, summarizeNumbers } from "../../src/core/metrics-domain.js";

describe("metrics domain", () => {
  test("keeps only finite numeric observations", () => {
    expect(numericValues([null, undefined, 1, Number.NaN, Number.POSITIVE_INFINITY, 3])).toEqual([1, 3]);
  });

  test("returns null aggregates for no observations and rounded aggregates otherwise", () => {
    expect(summarizeNumbers([null, undefined])).toEqual({ total: null, average: null, minimum: null, maximum: null });
    expect(summarizeNumbers([1, 2, 4])).toEqual({ total: 7, average: 2, minimum: 1, maximum: 4 });
  });
});
