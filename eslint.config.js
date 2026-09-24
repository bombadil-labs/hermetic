import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import hermetic from "./src/index.ts";

export default defineConfig(
  { ignores: ["dist/", "coverage/", "tests/fixtures/", ".corpus/", ".scratch/"] },
  ...tseslint.configs.recommended,
  // Dogfood: the rule checks every function in this repository marked hermetic.
  hermetic.configs.recommended,
);
