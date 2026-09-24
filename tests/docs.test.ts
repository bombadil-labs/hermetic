import fs from "node:fs";
import path from "node:path";
import * as tsParser from "@typescript-eslint/parser";
import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import plugin from "../src/index.ts";
import { repoRoot } from "./helpers.ts";

const doc = fs.readFileSync(path.join(repoRoot, "docs/rules/sealed.md"), "utf8");
const [incorrect, correct] = [...doc.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");

const lint = (code: string) =>
  new Linter().verify(
    code,
    [
      {
        files: ["**/*.tsx"],
        languageOptions: { parser: tsParser as Linter.Parser },
        plugins: { hermetic: plugin },
        rules: { "hermetic/sealed": "error" },
      },
    ],
    { filename: "doc.tsx" },
  );

describe("docs/rules/sealed.md", () => {
  it("reports exactly one problem per incorrect example", () => {
    expect(lint(incorrect ?? "").map((message) => message.messageId ?? message.message)).toEqual([
      "freeVariable",
      "freeVariable",
      "deniedPath",
      "freeVariable",
      "lexicalThis",
      "superReference",
      "importMeta",
      "jsx",
    ]);
  });

  it("reports nothing for the correct examples", () => {
    expect(lint(correct ?? "")).toEqual([]);
  });
});
