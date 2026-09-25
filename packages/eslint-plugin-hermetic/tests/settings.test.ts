import * as tsParser from "@typescript-eslint/parser";
import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import plugin from "../src/index.ts";

const lint = (settings: Record<string, unknown>) =>
  new Linter().verify(
    `function f(a) { "use hermetic"; return a; }`,
    [
      {
        files: ["**/*.ts"],
        languageOptions: { parser: tsParser as Linter.Parser },
        plugins: { hermetic: plugin },
        rules: { "hermetic/sealed": "error" },
        settings,
      },
    ],
    { filename: "module.ts" },
  );

describe("settings.hermetic", () => {
  it("takes types", () => {
    expect(lint({ hermetic: { types: "structural-only" } })).toEqual([]);
  });

  it.each(["ground", "aliasing"])("says %s was removed, and why", (name) => {
    expect(() => lint({ hermetic: { [name]: "anything" } })).toThrow(
      `settings.hermetic.${name} was removed in 0.3.0: hermetic functions read no globals, so there is nothing to allow. Pass what they need through 'this' or an argument.`,
    );
  });
});
