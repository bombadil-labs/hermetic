import { createRequire } from "node:module";
import type { ESLint, Linter, Rule } from "eslint";
import { closed } from "./rules/closed.ts";

const { name, version } = createRequire(import.meta.url)("../package.json") as { name: string; version: string };

/**
 * Typed with ESLint's own plugin and config types, so `configs.recommended`
 * drops straight into `defineConfig`. The precisely typed rule is exported
 * separately as `closed`.
 */
export interface IsolatedPlugin extends ESLint.Plugin {
  meta: { name: string; version: string };
  rules: { closed: Rule.RuleModule };
  configs: { recommended: Linter.Config };
}

const plugin: IsolatedPlugin = {
  meta: { name, version },
  // The same object seen through ESLint's types rather than typescript-eslint's.
  rules: { closed: closed as unknown as Rule.RuleModule },
  configs: {} as IsolatedPlugin["configs"],
};

// The config must hold the plugin object itself: ESLint rejects two different
// objects registered under one plugin name.
plugin.configs.recommended = {
  name: "isolated/recommended",
  plugins: { isolated: plugin },
  rules: { "isolated/closed": "error" },
};

export default plugin;
export { closed };
export { GroundBootstrapError } from "./ground/bootstrap.ts";
export type { ClosedOptions } from "./rules/closed.ts";
export type { GroundConfig } from "./ground/ground.ts";
