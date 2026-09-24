import { defineConfig } from "eslint/config";
import { Linter } from "eslint";
import * as tsParser from "@typescript-eslint/parser";
import { describe, expect, it } from "vitest";
import plugin from "../src/index.ts";

describe("the plugin", () => {
  it("fits ESLint's defineConfig, alone and alongside its own plugin entry", () => {
    // This file typechecks only if the plugin's types fit defineConfig.
    const config = defineConfig(
      { files: ["**/*.ts"], languageOptions: { parser: tsParser } },
      plugin.configs.recommended,
      { plugins: { hermetic: plugin }, rules: { "hermetic/sealed": ["error", { types: "structural-only" }] } },
    );
    const messages = new Linter().verify(`const R = 1; function f() { "use hermetic"; return R; }`, config, {
      filename: "file.ts",
    });
    expect(messages.map((message) => message.ruleId)).toEqual(["hermetic/sealed"]);
    // The wording the README documents.
    expect(messages[0]?.message).toBe("'R' is a free variable in hermetic function 'f'. Pass it through 'this' or an argument.");
  });

  it("names itself for ESLint's config inspection and caching", () => {
    expect(plugin.meta).toEqual({ name: "eslint-plugin-hermetic", version: expect.any(String) });
    expect(plugin.configs.recommended.plugins?.hermetic).toBe(plugin);
  });
});
