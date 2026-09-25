import { createRequire } from "node:module";
import type { ESLint, Linter, Rule } from "eslint";
import { preferHermetic } from "./rules/prefer-hermetic.ts";
import { sealed } from "./rules/sealed.ts";

const { name, version } = createRequire(import.meta.url)("../package.json") as { name: string; version: string };

/**
 * Typed with ESLint's own plugin and config types, so `configs.recommended`
 * drops straight into `defineConfig`. The precisely typed rule is exported
 * separately as `sealed`.
 */
export interface HermeticPlugin extends ESLint.Plugin {
  meta: { name: string; version: string };
  rules: { sealed: Rule.RuleModule; "prefer-hermetic": Rule.RuleModule };
  configs: { recommended: Linter.Config };
}

const plugin: HermeticPlugin = {
  meta: { name, version },
  // The same object seen through ESLint's types rather than typescript-eslint's.
  rules: {
    sealed: sealed as unknown as Rule.RuleModule,
    "prefer-hermetic": preferHermetic as unknown as Rule.RuleModule,
  },
  configs: {} as HermeticPlugin["configs"],
};

// The config must hold the plugin object itself: ESLint rejects two different
// objects registered under one plugin name.
plugin.configs.recommended = {
  name: "hermetic/recommended",
  plugins: { hermetic: plugin },
  rules: { "hermetic/sealed": "error" },
};

export default plugin;
export { preferHermetic, sealed };
export { GroundBootstrapError } from "./ground/bootstrap.ts";
export type { PreferHermeticOptions } from "./rules/prefer-hermetic.ts";
export type { SealedOptions } from "./rules/sealed.ts";
export type { GroundConfig } from "@bombadil/hermetic";
