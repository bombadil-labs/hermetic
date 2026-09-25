import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import hermetic from "./packages/eslint-plugin-hermetic/src/index.ts";

export default defineConfig(
  { ignores: ["**/dist/", "coverage/", "packages/eslint-plugin-hermetic/tests/fixtures/", ".corpus/", ".scratch/", "_site/"] },
  ...tseslint.configs.recommended,
  // Dogfood: the rule checks every function in this repository marked hermetic.
  hermetic.configs.recommended,
);
