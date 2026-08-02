import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

function warningsOnly(config) {
  const rules = Object.fromEntries(
    Object.entries(config.rules ?? {}).map(([name, value]) => {
      if (value === "off" || value === 0) return [name, value];
      if (Array.isArray(value)) return [name, ["warn", ...value.slice(1)]];
      return [name, "warn"];
    })
  );
  return { ...config, rules };
}

export default tseslint.config(
  {
    ignores: ["contracts/**", "coverage/**", "dist/**", "node_modules/**", "wjs/**"]
  },
  warningsOnly(eslint.configs.recommended),
  ...tseslint.configs.recommended.map(warningsOnly),
  {
    files: ["**/*.{cjs,js,mjs,ts,tsx}"],
    languageOptions: {
      globals: globals.nodeBuiltin
    },
    linterOptions: {
      reportUnusedDisableDirectives: "warn"
    }
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      globals: globals.node
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off"
    }
  }
);
