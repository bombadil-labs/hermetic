import fs from "node:fs";
import path from "node:path";
import * as tsParser from "@typescript-eslint/parser";
import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import plugin from "../src/index.ts";
import { repoRoot } from "./helpers.ts";

const doc = fs.readFileSync(path.join(repoRoot, "docs/rules/no-hidden-inputs.md"), "utf8");
const [incorrect, correct] = [...doc.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");

const lint = (code: string) =>
  new Linter().verify(
    code,
    [
      {
        files: ["**/*.tsx"],
        languageOptions: { parser: tsParser as Linter.Parser },
        plugins: { hermetic: plugin },
        rules: { "hermetic/no-hidden-inputs": "error" },
      },
    ],
    { filename: "doc.tsx" },
  );

describe("docs/rules/no-hidden-inputs.md", () => {
  it("reports exactly one problem per incorrect example", () => {
    expect(lint(incorrect ?? "").map((message) => message.messageId ?? message.message)).toEqual([
      "freeVariable",
      "freeVariable",
      "freeVariable",
      "freeVariable",
      "lexicalThis",
      "privateName",
      "superReference",
      "freeVariable",
      "importMeta",
      "jsx",
    ]);
  });

  it("reports nothing for the correct examples", () => {
    expect(lint(correct ?? "")).toEqual([]);
  });
});

describe("docs/rules/prefer-hermetic.md", () => {
  const preferDoc = fs.readFileSync(path.join(repoRoot, "docs/rules/prefer-hermetic.md"), "utf8");
  const blocks = [...preferDoc.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  const methods = preferDoc.indexOf("### Lifting methods");
  const methodBlocks = [...preferDoc.slice(methods).matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  const examples = { functions: blocks.slice(0, 2), methods: methodBlocks.slice(0, 2) };

  it.each(Object.entries(examples))("shows exactly what the fix does to %s", (_, [before, after]) => {
    const result = new Linter().verifyAndFix(
      before ?? "",
      [
        {
          files: ["**/*.ts"],
          languageOptions: { parser: tsParser as Linter.Parser },
          plugins: { hermetic: plugin },
          rules: { "hermetic/prefer-hermetic": ["error", { lift: true }], "hermetic/no-hidden-inputs": "error" },
        },
      ],
      { filename: "doc.ts" },
    );
    expect(result.output).toBe(after);
    expect(result.messages).toEqual([]);
  });
});
