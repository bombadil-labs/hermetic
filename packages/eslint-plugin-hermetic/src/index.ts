import { createRequire } from "node:module";
import type { ESLint, Linter, Rule } from "eslint";
import { noHiddenInputs, sealed } from "./rules/no-hidden-inputs.ts";
import { preferHermetic } from "./rules/prefer-hermetic.ts";

const { name, version } = createRequire(import.meta.url)("../package.json") as { name: string; version: string };

/**
 * Typed with ESLint's own plugin and config types, so `configs.recommended`
 * drops straight into `defineConfig`. The precisely typed rules are exported
 * separately, as `noHiddenInputs` and `preferHermetic`.
 */
export interface HermeticPlugin extends ESLint.Plugin {
  meta: { name: string; version: string };
  rules: { "no-hidden-inputs": Rule.RuleModule; "prefer-hermetic": Rule.RuleModule; sealed: Rule.RuleModule };
  configs: { recommended: Linter.Config };
}

const plugin: HermeticPlugin = {
  meta: { name, version },
  // The same object seen through ESLint's types rather than typescript-eslint's.
  rules: {
    "no-hidden-inputs": noHiddenInputs as unknown as Rule.RuleModule,
    "prefer-hermetic": preferHermetic as unknown as Rule.RuleModule,
    // The name until 0.3.0, deprecated: it reports what no-hidden-inputs reports.
    sealed: sealed as unknown as Rule.RuleModule,
  },
  configs: {} as HermeticPlugin["configs"],
};

// The config must hold the plugin object itself: ESLint rejects two different
// objects registered under one plugin name.
plugin.configs.recommended = {
  name: "hermetic/recommended",
  plugins: { hermetic: plugin },
  rules: { "hermetic/no-hidden-inputs": "error" },
};

export default plugin;
export { noHiddenInputs, preferHermetic, sealed };
export type { NoHiddenInputsOptions, SealedOptions } from "./rules/no-hidden-inputs.ts";
export type { PreferHermeticOptions } from "./rules/prefer-hermetic.ts";
