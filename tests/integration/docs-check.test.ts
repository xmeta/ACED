import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { buildDocsCheckReport, runDocsCheck } from "../../src/commands/docs-check.js";
import { collectCheckIssues } from "../../src/commands/check.js";
import { main } from "../../src/cli.js";
import { collectDocumentLifecycleIssues } from "../../src/core/document-lifecycle.js";
import { makeTempRepo, writeJson, writeScwbsProject, writeText } from "../helpers.js";

type DocumentSetFixture = {
  documentId: string;
  status: string;
  version: string;
  appliesToCli: string;
  entrypoint: string;
  paths: string[];
  supersedes: string[];
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
    ...overrides
  };
}

function writeFixture(root: string, documents: DocumentSetFixture[], standardEntrypoints = [documents[0].entrypoint]): void {
  writeJson(root, "package.json", { version: "0.1.0" });
  for (const document of documents) {
    writeText(root, document.entrypoint, `# ${document.documentId}\n`);
  }
  writeJson(root, "docs/document-lifecycle.json", {
    schemaVersion: "1.0.0",
    standardEntrypoints,
    documents
  });
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

    const schema = JSON.parse(readFileSync(
      path.join(process.cwd(), "docs/scwbs/schemas/docs-check.schema.json"),
      "utf8"
    ));
    const ajv = new Ajv2020({ strict: false });
    expect(ajv.compile(schema)(report)).toBe(true);

    const manifestSchema = JSON.parse(readFileSync(
      path.join(process.cwd(), "docs/scwbs/schemas/document-lifecycle.schema.json"),
      "utf8"
    ));
    const manifest = JSON.parse(readFileSync(path.join(root, "docs/document-lifecycle.json"), "utf8"));
    expect(ajv.compile(manifestSchema)(manifest)).toBe(true);

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

    expect(collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code))
      .toContain("docs.document.status");

    writeFixture(
      root,
      documents.filter((document) => document.documentId !== "bad-status"),
      ["docs/current/index.md", "docs/missing.md"]
    );
    const codes = collectDocumentLifecycleIssues(root).issues.map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining([
      "docs.entrypoint.scope",
      "docs.appliesToCli.mismatch",
      "docs.normative.conflict",
      "docs.supersedes.cycle",
      "docs.standardEntrypoint.missing",
      "docs.documentId.duplicate"
    ]));
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
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "docs.standardEntrypoint.nonCurrent",
      "docs.successor.missing"
    ]));
  });

  test("is available in CLI help and aggregate scwbs check", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeFixture(root, [
      documentSet({ appliesToCli: ">=9.0.0" })
    ]);

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
});
