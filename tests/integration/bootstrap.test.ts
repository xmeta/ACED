import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { runBootstrap, validateBootstrapManifest } from "../../scripts/scwbs-bootstrap.mjs";
import { makeTempRepo, writeJson } from "../helpers.js";

const baseManifest = (digest: string) => ({
  schemaVersion: "1.0.0",
  packageVersion: "0.1.0",
  tag: "v0.1.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  tarball: "scwbs-0.1.0.tgz",
  sha256: digest,
  validation: {
    workflow: ".github/workflows/scwbs.yml",
    workflowRunId: 42,
    checks: ["core", "integration", "wjs", "distribution", "validate"].map((name) => ({ name, conclusion: "success" }))
  }
});

function writeFixture(root: string, digest: string): { manifestPath: string; artifactPath: string; artifact: Buffer } {
  const artifact = Buffer.from("verified scwbs tarball");
  const manifestPath = path.join(root, "release-manifest.json");
  const artifactPath = path.join(root, "scwbs-0.1.0.tgz");
  writeJson(root, "release-manifest.json", baseManifest(digest));
  writeFileSync(artifactPath, artifact);
  return { manifestPath, artifactPath, artifact };
}

function digest(artifact: Buffer): string {
  return createHash("sha256").update(artifact).digest("hex");
}

describe("standalone bootstrap installer", () => {
  test("dry-run returns schema-valid bounded JSON and preserves package.json", async () => {
    const root = makeTempRepo();
    writeJson(root, "package.json", { name: "consumer", devDependencies: { existing: "1.0.0" } });
    const fixture = writeFixture(root, "");
    writeJson(root, "release-manifest.json", baseManifest(digest(fixture.artifact)));
    const before = readFileSync(path.join(root, "package.json"), "utf8");
    const result = await runBootstrap({ argv: ["install", "--dry-run", "--json", "--manifest", fixture.manifestPath, "--artifact", fixture.artifactPath], cwd: root });

    expect(result.exitCode).toBe(0);
    if (!result.output) throw new Error("bootstrap output is missing");
    expect(result.output).toMatchObject({ version: "scwbs.bootstrap-install.v1", status: "pass", mode: "dry-run", releaseTag: "v0.1.0", packageVersion: "0.1.0", mutation: { changed: false } });
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe(before);
    const schema = JSON.parse(readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/bootstrap.schema.json"), "utf8"));
    expect(new Ajv2020({ strict: false }).compile(schema)(result.output)).toBe(true);
  });

  test("explicit install writes only the exact tarball URL after digest verification", async () => {
    const root = makeTempRepo();
    writeJson(root, "package.json", { name: "consumer", devDependencies: { existing: "1.0.0" } });
    const fixture = writeFixture(root, "");
    writeJson(root, "release-manifest.json", baseManifest(digest(fixture.artifact)));
    const result = await runBootstrap({ argv: ["install", "--save-dev", "--manifest", fixture.manifestPath, "--artifact", fixture.artifactPath], cwd: root });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))).toEqual({ name: "consumer", devDependencies: { existing: "1.0.0", scwbs: "https://github.com/xmeta/ACED/releases/download/v0.1.0/scwbs-0.1.0.tgz" } });
  });

  test("latest resolution uses the release tag but never writes a floating URL", async () => {
    const root = makeTempRepo();
    writeJson(root, "package.json", { name: "consumer" });
    const artifact = Buffer.from("verified remote tarball");
    const remoteManifest = baseManifest(digest(artifact));
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("/releases/latest")) return new Response(JSON.stringify({ tag_name: "v0.1.0", draft: false, prerelease: false }), { status: 200 });
      if (url.endsWith("release-manifest.json")) return new Response(JSON.stringify(remoteManifest), { status: 200 });
      if (url.endsWith("scwbs-0.1.0.tgz")) return new Response(artifact, { status: 200 });
      return new Response("not found", { status: 404 });
    };
    const result = await runBootstrap({ argv: ["install", "--dry-run", "--json"], cwd: root, fetchImpl });

    expect(result.exitCode).toBe(0);
    if (!result.output) throw new Error("bootstrap output is missing");
    expect(result.output.artifactUrl).toBe("https://github.com/xmeta/ACED/releases/download/v0.1.0/scwbs-0.1.0.tgz");
    expect(String(result.output.artifactUrl)).not.toContain("latest");
  });

  test("digest mismatch and unknown options fail closed without package mutation", async () => {
    const root = makeTempRepo();
    writeJson(root, "package.json", { name: "consumer" });
    const fixture = writeFixture(root, "a".repeat(64));
    const before = readFileSync(path.join(root, "package.json"), "utf8");
    const mismatch = await runBootstrap({ argv: ["install", "--save-dev", "--manifest", fixture.manifestPath, "--artifact", fixture.artifactPath, "--json"], cwd: root });

    expect(mismatch.exitCode).toBe(1);
    if (!mismatch.output) throw new Error("bootstrap output is missing");
    expect(mismatch.output.reasons[0]?.code).toBe("bootstrap.digest.mismatch");
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe(before);
    const unknown = await runBootstrap({ argv: ["install", "--save-dev", "--json", "--unknown"], cwd: root });
    expect(unknown.exitCode).toBe(2);
    if (!unknown.output) throw new Error("bootstrap output is missing");
    expect(unknown.output.reasons[0]?.code).toBe("bootstrap.usage");
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe(before);

    const offline = await runBootstrap({ argv: ["install", "--save-dev", "--json"], cwd: root, fetchImpl: async () => { throw new Error("offline"); } });
    expect(offline.exitCode).toBe(1);
    if (!offline.output) throw new Error("bootstrap output is missing");
    expect(offline.output.status).toBe("unavailable");
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe(before);
  });

  test("validates the release subject before artifact access", () => {
    expect(validateBootstrapManifest({ ...baseManifest("a".repeat(64)), tag: "v0.2.0" }, "v0.1.0").reasons.map((item) => item.code)).toContain("bootstrap.subject.tag-mismatch");
  });
});
