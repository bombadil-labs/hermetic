import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "eslint/config";
import { Linter } from "eslint";
import * as tsParser from "@typescript-eslint/parser";
import { describe, expect, it } from "vitest";
import plugin from "../src/index.ts";
import { repoRoot } from "./helpers.ts";

describe("the plugin", () => {
  it("fits ESLint's defineConfig, alone and alongside its own plugin entry", () => {
    // This file typechecks only if the plugin's types fit defineConfig.
    const config = defineConfig(
      { files: ["**/*.ts"], languageOptions: { parser: tsParser } },
      plugin.configs.recommended,
      { plugins: { hermetic: plugin }, rules: { "hermetic/no-hidden-inputs": ["error", { types: "structural-only" }] } },
    );
    const messages = new Linter().verify(`const R = 1; function f() { "use hermetic"; return R; }`, config, {
      filename: "file.ts",
    });
    expect(messages.map((message) => message.ruleId)).toEqual(["hermetic/no-hidden-inputs"]);
    // The wording the README documents.
    expect(messages[0]?.message).toBe("'R' is a free variable in hermetic function 'f'. Pass it through 'this' or an argument.");
  });

  it("keeps the rule's old name, sealed, working, and marks it deprecated", () => {
    const code = `const R = 1; function f() { "use hermetic"; return R; }`;
    const lint = (rule: string) =>
      new Linter().verify(code, { files: ["**/*.ts"], languageOptions: { parser: tsParser }, plugins: { hermetic: plugin }, rules: { [rule]: "error" } }, { filename: "file.ts" });
    const renamed = lint("hermetic/no-hidden-inputs");
    const old = lint("hermetic/sealed");
    expect(old.map((message) => message.message)).toEqual(renamed.map((message) => message.message));
    expect(old.map((message) => message.ruleId)).toEqual(["hermetic/sealed"]);
    expect(plugin.rules.sealed.meta?.deprecated).toMatchObject({ replacedBy: [{ rule: { name: "no-hidden-inputs" } }] });
    expect(plugin.configs.recommended.rules).toEqual({ "hermetic/no-hidden-inputs": "error" });
  });

  it("links each rule to its documentation, which exists", () => {
    for (const [name, rule] of Object.entries(plugin.rules)) {
      const url = rule.meta?.docs?.url ?? "";
      expect(url, name).toBe(`https://github.com/bombadil-labs/hermetic/blob/main/packages/eslint-plugin-hermetic/docs/rules/${name}.md`);
      expect(fs.existsSync(path.join(repoRoot, "docs/rules", `${name}.md`)), name).toBe(true);
    }
  });

  it("names itself for ESLint's config inspection and caching", () => {
    expect(plugin.meta).toEqual({ name: "@bombadil/eslint-plugin-hermetic", version: expect.any(String) });
    expect(plugin.configs.recommended.plugins?.hermetic).toBe(plugin);
  });
});
