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
      { plugins: { isolated: plugin }, rules: { "isolated/closed": ["error", { types: "structural-only" }] } },
    );
    const messages = new Linter().verify(`const R = 1; function f() { "use isolated"; return R; }`, config, {
      filename: "file.ts",
    });
    expect(messages.map((message) => message.ruleId)).toEqual(["isolated/closed"]);
  });

  it("names itself for ESLint's config inspection and caching", () => {
    expect(plugin.meta).toEqual({ name: "eslint-plugin-isolated", version: expect.any(String) });
    expect(plugin.configs.recommended.plugins?.isolated).toBe(plugin);
  });
});
