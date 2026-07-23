import type { Profile, WbsDocument } from "./types.js";

export type GovernanceWarningBudgetThresholds = {
  governanceFiles?: number;
  governanceLines?: number;
  governanceToSourceLineRatio?: number;
};

export type GovernanceBaseline = {
  completedTaskCount: number;
  minimumCompletedTaskCount: 10;
  observedHumanGateCount: number;
  minimumObservedHumanGateCount: 2;
  executionClasses: {
    full: number;
    metadataDescendant: number;
    minimumEach: 2;
  };
};

export type GovernanceWarningBudgets = {
  status: "available" | "insufficient-baseline" | "not-configured";
  source: "wbs-extension";
  profile: Profile;
  baseline: GovernanceBaseline;
  thresholds: GovernanceWarningBudgetThresholds | null;
  warnings: string[];
  reason?: string;
};

type GovernanceMeasurement = {
  governanceFiles: number;
  governanceLines: number;
  governanceToSourceLineRatio: number | null;
};

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function configuredWarningBudget(wbs: WbsDocument, profile: Profile): GovernanceWarningBudgetThresholds | undefined {
  const scwbs = wbs.extensions?.scwbs;
  if (typeof scwbs !== "object" || scwbs === null || Array.isArray(scwbs)) return undefined;
  const governanceCost = (scwbs as Record<string, unknown>).governanceCost;
  if (typeof governanceCost !== "object" || governanceCost === null || Array.isArray(governanceCost)) return undefined;
  const warningBudgets = (governanceCost as Record<string, unknown>).warningBudgets;
  if (typeof warningBudgets !== "object" || warningBudgets === null || Array.isArray(warningBudgets)) return undefined;
  const selected = (warningBudgets as Record<string, unknown>)[profile];
  if (typeof selected !== "object" || selected === null || Array.isArray(selected)) return undefined;
  const record = selected as Record<string, unknown>;
  const thresholds = {
    governanceFiles: nonNegativeNumber(record.governanceFiles),
    governanceLines: nonNegativeNumber(record.governanceLines),
    governanceToSourceLineRatio: nonNegativeNumber(record.governanceToSourceLineRatio)
  };
  return Object.values(thresholds).some((value) => value !== undefined) ? thresholds : undefined;
}

function baselineReady(baseline: GovernanceBaseline): boolean {
  return baseline.completedTaskCount >= baseline.minimumCompletedTaskCount
    && baseline.observedHumanGateCount >= baseline.minimumObservedHumanGateCount
    && baseline.executionClasses.full >= baseline.executionClasses.minimumEach
    && baseline.executionClasses.metadataDescendant >= baseline.executionClasses.minimumEach;
}

export function evaluateGovernanceWarningBudgets(
  wbs: WbsDocument,
  profile: Profile,
  baseline: GovernanceBaseline,
  measurement: GovernanceMeasurement
): GovernanceWarningBudgets {
  const thresholds = configuredWarningBudget(wbs, profile);
  if (!thresholds) {
    return {
      status: "not-configured",
      source: "wbs-extension",
      profile,
      baseline,
      thresholds: null,
      warnings: [],
      reason: `extensions.scwbs.governanceCost.warningBudgets.${profile} is not configured`
    };
  }
  if (!baselineReady(baseline)) {
    return {
      status: "insufficient-baseline",
      source: "wbs-extension",
      profile,
      baseline,
      thresholds,
      warnings: [],
      reason: "requires 10 completed Tasks, 2 observed Human Gates, and 2 Tasks in each execution class"
    };
  }
  const warnings: string[] = [];
  if (thresholds.governanceFiles !== undefined && measurement.governanceFiles > thresholds.governanceFiles) {
    warnings.push(`governance files ${measurement.governanceFiles} exceed ${thresholds.governanceFiles}`);
  }
  if (thresholds.governanceLines !== undefined && measurement.governanceLines > thresholds.governanceLines) {
    warnings.push(`governance lines ${measurement.governanceLines} exceed ${thresholds.governanceLines}`);
  }
  if (thresholds.governanceToSourceLineRatio !== undefined && measurement.governanceToSourceLineRatio !== null
    && measurement.governanceToSourceLineRatio > thresholds.governanceToSourceLineRatio) {
    warnings.push(`governance/source line ratio ${measurement.governanceToSourceLineRatio} exceeds ${thresholds.governanceToSourceLineRatio}`);
  }
  return { status: "available", source: "wbs-extension", profile, baseline, thresholds, warnings: warnings.slice(0, 3) };
}
