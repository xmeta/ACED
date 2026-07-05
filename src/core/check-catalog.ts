/**
 * M2-003: Check Catalog.
 *
 * A small, explicit mapping from a `requiredChecks` name (as used in Task
 * Contracts) to the executable command that satisfies it. Keeping this in
 * one place means `finish`/`evidence collect` never has to guess how to run
 * a check, and new checks can be added without touching call sites.
 */
export type CheckCatalogEntry = {
  name: string;
  description: string;
  command: string[];
};

export const CHECK_CATALOG: readonly CheckCatalogEntry[] = [
  { name: "test", description: "Run the test suite.", command: ["npm", "test"] },
  { name: "typecheck", description: "Run the TypeScript type checker without emitting output.", command: ["npm", "run", "typecheck"] },
  { name: "build", description: "Compile the CLI.", command: ["npm", "run", "build"] }
];

const CATALOG_BY_NAME = new Map(CHECK_CATALOG.map((entry) => [entry.name, entry]));

/**
 * Resolve a requiredChecks entry to a command. Unknown checks fall back to
 * `npm run <name>`, matching prior behavior, so existing package.json
 * scripts keep working without being registered in the catalog.
 */
export function resolveCheckCommand(name: string): string[] {
  const entry = CATALOG_BY_NAME.get(name);
  if (entry) return [...entry.command];
  return ["npm", "run", name];
}

export function isKnownCheck(name: string): boolean {
  return CATALOG_BY_NAME.has(name);
}

export function listCheckCatalog(): readonly CheckCatalogEntry[] {
  return CHECK_CATALOG;
}
