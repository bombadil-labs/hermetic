import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import isolated from "./src/index.ts";

export default defineConfig(
  { ignores: ["dist/", "coverage/", "tests/fixtures/"] },
  ...tseslint.configs.recommended,
  // Dogfood: the rule checks every function in this repository marked isolated.
  isolated.configs.recommended,
);
