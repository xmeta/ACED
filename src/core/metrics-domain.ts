export type NumericSummary = { total: number | null; average: number | null; minimum: number | null; maximum: number | null };

export function numericValues(values: Array<number | null | undefined>): number[] {
  return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

export function summarizeNumbers(values: Array<number | null | undefined>): NumericSummary {
  const observed = numericValues(values);
  if (observed.length === 0) return { total: null, average: null, minimum: null, maximum: null };
  const total = observed.reduce((sum, value) => sum + value, 0);
  return { total, average: Math.round(total / observed.length), minimum: Math.min(...observed), maximum: Math.max(...observed) };
}
