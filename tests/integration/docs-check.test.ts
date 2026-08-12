import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { load } from "js-yaml";
import { describe, expect, test } from "vitest";
import { buildDocsCheckReport, runDocsCheck } from "../../src/commands/docs-check.js";
import { collectCheckIssues } from "../../src/commands/check.js";
import { main } from "../../src/cli.js";
import { collectDocumentLifecycleIssues } from "../../src/core/document-lifecycle.js";
import {
  validateEvidence,
  validateEvidenceSchema,
  validateTaskContract,
  validateTaskContractSchema
} from "../../src/core/schema.js";
import { makeTempRepo, writeJson, writeScwbsProject, writeText } from "../helpers.js";

type DocumentSetFixture = {
  documentId: string;
  status: string;
  version: string;
  appliesToCli: string;
  entrypoint: string;
  paths: string[];
  supersedes: string[];
  language: "ja" | "en";
};

function documentSet(overrides: Partial<DocumentSetFixture> = {}): DocumentSetFixture {
  return {
    documentId: "current",
    status: "normative",
    version: "1.0.0",
    appliesToCli: ">=0.1.0 <0.2.0",
    entrypoint: "docs/current/index.md",
    paths: ["docs/current/**"],
    supersedes: [],
    language: "ja",
    ...overrides
  };
}

function writeFixture(
  root: string,
  documents: DocumentSetFixture[],
  standardEntrypoints = [documents[0].entrypoint],
  ignoredPaths: string[] = [],
  qualityExceptions: Array<{ path: string; reason: string; owner: string; expiresAt: string }> = []
): void {
  writeJson(root, "package.json", { version: "0.1.0" });
  for (const document of documents) {
    writeText(root, document.entrypoint, `# ${document.documentId}\n`);
  }
  writeJson(root, "docs/document-lifecycle.json", {
    schemaVersion: "1.1.0",
    maxLines: 500,
    qualityExceptions,
    standardEntrypoints,
    ignoredPaths,
    documents
  });
}

function yamlExampleAfterHeading(markdown: string, heading: string): unknown {
  const headingIndex = markdown.indexOf(heading);
  if (headingIndex < 0) throw new Error(`missing heading: ${heading}`);
  const match = markdown.slice(headingIndex).match(/```yaml\n([\s\S]*?)```/);
  if (!match) throw new Error(`missing YAML example after: ${heading}`);
  return load(match[1]);
}

type CapabilityFixture = {
  id?: string;
  status?: string;
  summary?: string;
  commands?: string[];
  files?: string[];
  tests?: string[];
};

function writeCapabilities(root: string, capabilities: CapabilityFixture[]): void {
  writeJson(root, "docs/documentation-capabilities.json", {
    schemaVersion: "scwbs.documentation-capabilities.v1",
    capabilities: capabilities.map((capability) => ({
      id: capability.id ?? "demo-capability",
      status: capability.status ?? "implemented",
      summary: capability.summary ?? "A documented capability fixture.",
      evidence: {
        commands: capability.commands ?? [],
        files: capability.files ?? ["src/demo.ts"],
        tests: capability.tests ?? ["tests/demo.test.ts"]
      }
    }))
  });
}

function writeCapabilityMatrix(root: string, ...markers: string[]): void {
  writeText(root, "docs/implementation-gaps.md", markers.join("\n") + "\n");
}

describe("docs check", () => {
  test("validates the lifecycle manifest and emits schema-conforming JSON", () => {
    const root = makeTempRepo();
    writeFixture(root, [
      documentSet(),
      documentSet({
        documentId: "proposal",
        status: "proposal",
        entrypoint: "docs/proposal/index.md",
        paths: ["docs/proposal/**"]
      })
    ]);

    const report = buildDocsCheckReport(root);
    expect(report.status).toBe("pass");
    expect(report.summary).toMatchObject({ documents: 2, normative: 1, proposal: 1, errors: 0 });

    const schema = JSON.parse(
      readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/docs-check.schema.json"), "utf8")
    );
    const ajv = new Ajv2020({ strict: false });
    expect(ajv.compile(schema)(report)).toBe(true);

    const manifestSchema = JSON.parse(
      readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/document-lifecycle.schema.json"), "utf8")
    );
    const manifest = JSON.parse(readFileSync(path.join(root, "docs/document-lifecycle.json"), "utf8"));
    expect(ajv.compile(manifestSchema)(manifest)).toBe(true);

    const capabilitiesSchema = JSON.parse(
      readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/documentation-capabilities.schema.json"), "utf8")
    );
    const capabilities = JSON.parse(
      readFileSync(path.join(process.cwd(), "docs/documentation-capabilities.json"), "utf8")
    );
    expect(ajv.compile(capabilitiesSchema)(capabilities)).toBe(true);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      expect(runDocsCheck(root)).toBe(0);
      expect(runDocsCheck(root, { json: true })).toBe(0);
    } finally {
      console.log = originalLog;
    }
    expect(output[0]).toBe("PASS docs check (2 document sets)");
    expect(JSON.parse(output[1])).toEqual(report);
  });

  test("fails invalid status, entrypoint scope, CLI range, normative conflict, and successor graph", () => {
    const root = makeTempRepo();
    const documents = [
      documentSet({ documentId: "first", paths: ["docs/shared/**"] }),
      documentSet({
        documentId: "second",
        entrypoint: "docs/second/index.md",
        paths: ["docs/shared/**"],
        appliesToCli: ">=9.0.0",
        supersedes: ["legacy"]
      }),
      documentSet({
        documentId: "legacy",
        status: "deprecated",
        entrypoint: "docs/legacy/index.md",
        paths: ["docs/legacy/**"],
        supersedes: ["second"]
      }),
      documentSet({
        documentId: "first",
        status: "informative",
        entrypoint: "docs/duplicate/index.md",
        paths: ["docs/duplicate/**"]
      }),
      documentSet({
        documentId: "bad-status",
        status: "draft",
        entrypoint: "docs/bad/index.md",
        paths: ["docs/other/**"]
      })
    ];
    writeFixture(root, documents);

    expect(collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code)).toContain("docs.document.status");

    writeFixture(
      root,
      documents.filter((document) => document.documentId !== "bad-status"),
      ["docs/current/index.md", "docs/missing.md"]
    );
    const codes = collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "docs.entrypoint.scope",
        "docs.appliesToCli.mismatch",
        "docs.normative.conflict",
        "docs.supersedes.cycle",
        "docs.standardEntrypoint.missing",
        "docs.documentId.duplicate"
      ])
    );
    expect(runDocsCheck(root)).toBe(1);
  });

  test("warns when a noncurrent document is a standard entrypoint and requires successors", () => {
    const root = makeTempRepo();
    writeFixture(root, [
      documentSet({
        documentId: "old",
        status: "superseded",
        entrypoint: "docs/old/index.md",
        paths: ["docs/old/**"]
      })
    ]);

    const report = buildDocsCheckReport(root);
    expect(report.status).toBe("fail");
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["docs.standardEntrypoint.nonCurrent", "docs.successor.missing"])
    );
  });

  test("reports orphan Markdown and supports explicit ignored paths", () => {
    const root = makeTempRepo();
    writeFixture(root, [documentSet()]);
    writeText(root, "docs/orphan.md", "# Orphan\n");

    expect(collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code)).toContain(
      "docs.orphan.unregistered"
    );

    writeFixture(root, [documentSet()], undefined, ["docs/orphan.md"]);
    expect(collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code)).not.toContain(
      "docs.orphan.unregistered"
    );
  });

  test("reports lint threshold drift between package.json and README", () => {
    const root = makeTempRepo();
    writeFixture(root, [documentSet()]);
    writeJson(root, "package.json", { version: "0.1.0", scripts: { lint: "eslint --max-warnings=0" } });
    writeText(root, "README.md", "# ACED\nThe baseline is currently up to 37 warnings.\n");

    expect(collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code)).toContain("docs.fact.lintThreshold");
  });

  test("reports implemented documentation automation that remains in the gaps table", () => {
    const root = makeTempRepo();
    const gaps = documentSet({
      documentId: "gaps",
      entrypoint: "docs/implementation-gaps.md",
      paths: ["docs/implementation-gaps.md"]
    });
    writeFixture(root, [gaps]);
    writeText(
      root,
      "docs/implementation-gaps.md",
      "| Documentation automation | Markdown generation from contracts | missing |\n"
    );
    writeText(root, "src/cli.ts", 'program.command("generate");\n');

    expect(collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code)).toContain(
      "docs.fact.implementedMissing"
    );
  });

  test("keeps the live capability matrix aligned with current implementation evidence", () => {
    const codes = collectDocumentLifecycleIssues(process.cwd()).issues.map((issue) => issue.code);
    expect(codes.filter((code) => code.startsWith("docs.capability."))).toEqual([]);
  });

  test("enforces the physical line limit and permits only valid current exceptions", () => {
    const root = makeTempRepo();
    const document = documentSet({ entrypoint: "docs/current/index.md" });
    writeFixture(root, [document]);
    writeText(root, document.entrypoint, `${Array.from({ length: 501 }, (_, index) => `line ${index}`).join("\n")}\n`);
    expect(collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code)).toContain("docs.size.exceeded");

    writeFixture(root, [document], undefined, [], [
      { path: document.entrypoint, reason: "planned split", owner: "docs-team", expiresAt: "2099-12-31" }
    ]);
    expect(collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code)).not.toContain("docs.size.exceeded");

    writeFixture(root, [document], undefined, [], [
      { path: document.entrypoint, reason: "", owner: "docs-team", expiresAt: "2000-01-01" }
    ]);
    expect(collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code)).toContain(
      "docs.quality.exceptionInvalid"
    );
  });

  test("requires language on current manifests and checks prose without inspecting code", () => {
    const root = makeTempRepo();
    const document = documentSet();
    writeFixture(root, [document]);
    const manifestPath = path.join(root, "docs/document-lifecycle.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const documents = manifest.documents as Array<Record<string, unknown>>;
    delete documents[0].language;
    writeJson(root, "docs/document-lifecycle.json", manifest);
    expect(collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code)).toContain("docs.language.missing");

    documents[0].language = "ja";
    writeJson(root, "docs/document-lifecycle.json", manifest);
    writeText(
      root,
      document.entrypoint,
      "This is clear English prose that should fail the Japanese declaration.\n```text\nThis code is ignored.\n```\n"
    );
    expect(collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code)).toContain("docs.language.mixedProse");

    documents[0].language = "en";
    writeJson(root, "docs/document-lifecycle.json", manifest);
    writeText(root, document.entrypoint, "これはコード外の日本語本文である。\n`npm run scwbs -- docs check` は識別子として扱う。\n");
    expect(collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code)).toContain("docs.language.mixedProse");
  });

  test("detects broken internal links in split documentation", () => {
    const root = makeTempRepo();
    const document = documentSet({ entrypoint: "docs/current/index.md" });
    writeFixture(root, [document]);
    writeText(root, document.entrypoint, "[missing](details.md)\n");
    expect(collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code)).toContain("docs.link.missing");
  });

  test("rejects duplicate capability ids and duplicate matrix claims", () => {
    const root = makeTempRepo();
    const gaps = documentSet({
      documentId: "gaps",
      entrypoint: "docs/implementation-gaps.md",
      paths: ["docs/implementation-gaps.md"]
    });
    writeFixture(root, [gaps]);
    writeText(root, "src/demo.ts", "export const demo = true;\n");
    writeText(root, "tests/demo.test.ts", "test('demo', () => {});\n");
    writeCapabilities(root, [{ id: "demo-capability" }, { id: "demo-capability" }]);
    writeCapabilityMatrix(
      root,
      "<!-- scwbs-capability: demo-capability status=implemented -->",
      "<!-- scwbs-capability: demo-capability status=implemented -->"
    );

    const codes = collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code);
    expect(codes).toContain("docs.capability.id.duplicate");

    writeCapabilities(root, [{ id: "demo-capability" }]);
    const duplicateMatrixCodes = collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code);
    expect(duplicateMatrixCodes).toContain("docs.capability.matrix.duplicate");
  });

  test("rejects unknown commands, missing evidence, and matrix status mismatch", () => {
    const root = makeTempRepo();
    const gaps = documentSet({
      documentId: "gaps",
      entrypoint: "docs/implementation-gaps.md",
      paths: ["docs/implementation-gaps.md"]
    });
    writeFixture(root, [gaps]);
    writeCapabilities(root, [
      { id: "unknown-command", commands: ["not-a-command"], files: [], tests: [] },
      { id: "missing-evidence", files: ["src/missing.ts"], tests: [] },
      { id: "status-mismatch", status: "partial" }
    ]);
    writeCapabilityMatrix(
      root,
      "<!-- scwbs-capability: unknown-command status=implemented -->",
      "<!-- scwbs-capability: missing-evidence status=implemented -->",
      "<!-- scwbs-capability: status-mismatch status=implemented -->"
    );
    writeText(root, "src/demo.ts", "export const demo = true;\n");
    writeText(root, "tests/demo.test.ts", "test('demo', () => {});\n");

    const codes = collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "docs.capability.command.unknown",
        "docs.capability.evidence.missing",
        "docs.capability.matrix.mismatch"
      ])
    );
  });

  test("requires repository visibility claims to be dated snapshots with revalidation", () => {
    const root = makeTempRepo();
    const protection = documentSet({
      documentId: "merge-protection",
      entrypoint: "docs/scwbs/merge-protection.md",
      paths: ["docs/scwbs/merge-protection.md"]
    });
    writeFixture(root, [protection]);
    writeText(root, "docs/scwbs/merge-protection.md", "This repository is currently private.\n");

    expect(collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code)).toContain(
      "docs.fact.transientRepositoryState"
    );

    writeText(root, "docs/scwbs/merge-protection.md", "This is a dated snapshot; revalidate with gh api.\n");
    expect(collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code)).not.toContain(
      "docs.fact.transientRepositoryState"
    );
  });

  test("is available in CLI help and aggregate scwbs check", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeFixture(root, [documentSet({ appliesToCli: ">=9.0.0" })]);

    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code === "docs.appliesToCli.mismatch")).toBe(true);

    const output: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(main(["docs", "check", "--help"], root)).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(output.join("")).toContain("--json");
    expect(output.join("")).toContain("documentation status");
  });

  test("keeps normative Core Task and Evidence examples valid against current schemas", () => {
    const markdown = readFileSync(path.join(process.cwd(), "docs/sc-wbs-core/03-minimal-artifacts.md"), "utf8");
    const task = yamlExampleAfterHeading(markdown, "## Task Contract Core");
    const evidence = yamlExampleAfterHeading(markdown, "## Evidence Core");

    expect(validateTaskContractSchema(task, "Task Contract Core example")).toEqual([]);
    expect(validateTaskContract(task, "Task Contract Core example")).toEqual([]);
    expect(validateEvidenceSchema(evidence, "Evidence Core example")).toEqual([]);
    expect(validateEvidence(evidence, "Evidence Core example")).toEqual([]);
  });
});
