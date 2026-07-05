import { runRegistryRebuild } from "./registry-rebuild.js";

/**
 * M2-023: `scwbs fix` only performs safe, deterministic, idempotent repairs.
 * It never guesses intent, never edits Task Contracts, Evidence, Approvals,
 * or WBS content, and never runs arbitrary checks. Today the only safe fix
 * is regenerating the derived contracts/registry.yaml index, since it is
 * fully computed from other contract files and carries no human judgment.
 *
 * Anything else (fixing a failing check, resolving an allowedPaths
 * violation, requesting approval) requires a human or AI decision and is
 * intentionally left to the fixCommand hints in check-diff/finish output
 * instead of being auto-applied here.
 */
export function runFix(root: string): number {
  console.log("scwbs fix: applying safe automatic fixes only");
  console.log("- registry rebuild (derived index; safe to regenerate)");
  const registryExit = runRegistryRebuild(root, { check: false, force: true });
  if (registryExit !== 0) {
    console.error("scwbs fix: registry rebuild failed; no other automatic fixes were attempted");
    return registryExit;
  }
  console.log("scwbs fix: done. Some issues (failing checks, path violations, missing approvals) require manual action; see fixCommand hints from `check`, `check-diff`, or `finish`.");
  return 0;
}
