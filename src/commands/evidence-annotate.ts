import { writeFileSync } from "node:fs";
import { readEvidence } from "../core/contracts.js";
import { evidencePath, resolveFrom } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import type { Evidence } from "../core/types.js";

type TestQuality = NonNullable<Evidence["testQuality"]>;

export type EvidenceAnnotateOptions = {
  pullRequest?: string;
  testQuality?: TestQuality;
};

export function buildAnnotatedEvidence(existing: Evidence, options: EvidenceAnnotateOptions): Evidence {
  return {
    ...existing,
    git: {
      ...(existing.git ?? {}),
      ...(options.pullRequest ? { pullRequest: options.pullRequest } : {})
    },
    ...(options.testQuality ? { testQuality: options.testQuality } : {})
  };
}

export function runEvidenceAnnotate(root: string, taskId: string, options: EvidenceAnnotateOptions): number {
  try {
    if (!options.pullRequest && !options.testQuality) {
      console.error("Provide --pull-request or test quality metadata");
      return 2;
    }
    const { evidence, issues } = readEvidence(root, taskId);
    if (!evidence) throw new Error(issues.map((issue) => issue.message).join("\n"));
    const annotated = buildAnnotatedEvidence(evidence, options);
    writeFileSync(
      resolveFrom(root, evidencePath(taskId)),
      stringifySimpleYaml(annotated as unknown as Record<string, unknown>),
      "utf8"
    );
    console.log(`annotated ${evidencePath(taskId)} (subject provenance and checks preserved)`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
