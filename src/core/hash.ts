import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolveFrom } from "./paths.js";

export function fileSha256(root: string, relativePath: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(resolveFrom(root, relativePath)));
  return `sha256:${hash.digest("hex")}`;
}
