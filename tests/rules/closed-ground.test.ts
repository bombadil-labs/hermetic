import { pathToFileURL } from "node:url";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { Linter } from "eslint";
import * as tsParser from "@typescript-eslint/parser";
import { describe, expect, it } from "vitest";
import plugin from "../../src/index.ts";
import { closed } from "../../src/rules/closed.ts";
import { fixture } from "../helpers.ts";

const ruleTester = new RuleTester();
const clock = fixture("clock.ground.ts");
const app = fixture("app.ground.ts");

ruleTester.run("configured ground", closed, {
  valid: [
    {
      name: "globals the bootstrap allows",
      code: `function f(t) { "use isolated"; return new Date(t).getTime() + Date.UTC(2020, 0) + Object.keys(t).length; }`,
      options: [{ ground: clock }],
    },
    {
      name: "a path relative to the working directory",
      code: `function f(t) { "use isolated"; return new Date(t); }`,
      options: [{ ground: "tests/fixtures/grounds/clock.ground.ts" }],
    },
    {
      name: "a file URL",
      code: `function f(t) { "use isolated"; return new Date(t); }`,
      options: [{ ground: pathToFileURL(clock).href }],
    },
    {
      name: "best-effort: aliasing a nested object",
      code: `function f(x) { "use isolated"; const p = Object.prototype; return p.toString.call(x); }`,
      options: [{ ground: clock }],
    },
    {
      name: "an ambient declaration describes a ground global",
      code: `declare const __DEV__: boolean; function f() { "use isolated"; return __DEV__ ? JSON.stringify(1) : ""; }`,
      options: [{ ground: app }],
    },
  ],
  invalid: [
    {
      name: "a denied path in a configured ground",
      code: `function f() { "use isolated"; return Date.now(); }`,
      options: [{ ground: clock }],
      errors: [{ messageId: "deniedPath", data: { path: "Date.now", fn: "f" } }],
    },
    {
      name: "a default ground name the bootstrap leaves out",
      code: `function f(s) { "use isolated"; return JSON.parse(s); }`,
      options: [{ ground: clock }],
      errors: [{ messageId: "freeVariable", data: { name: "JSON", fn: "f" } }],
    },
    {
      name: "a three-segment denied path",
      code: `function f(x) { "use isolated"; return Object.prototype.toString.call(x); }`,
      options: [{ ground: clock }],
      errors: [{ messageId: "deniedPath", data: { path: "Object.prototype.toString", fn: "f" } }],
    },
    {
      name: "nested destructuring",
      code: `function f(x) { "use isolated"; const { prototype: { toString } } = Object; return toString.call(x); }`,
      options: [{ ground: clock }],
      errors: [{ messageId: "deniedPath", data: { path: "Object.prototype.toString", fn: "f" } }],
    },
    {
      name: "forbid: aliasing a nested object with denied members",
      code: `function f() { "use isolated"; const p = Object.prototype; return p; }`,
      options: [{ ground: clock, aliasing: "forbid" }],
      errors: [{ messageId: "aliasedGround", data: { path: "Object.prototype", fn: "f" } }],
    },
    {
      name: "forbid: destructuring a nested object with denied members",
      code: `function f() { "use isolated"; const { prototype } = Object; return prototype; }`,
      options: [{ ground: clock, aliasing: "forbid" }],
      errors: [{ messageId: "aliasedGround", data: { path: "Object.prototype", fn: "f" } }],
    },
    {
      name: "a real binding still shadows a ground global",
      code: `const __DEV__ = true; function f() { "use isolated"; return __DEV__; }`,
      options: [{ ground: app }],
      errors: [{ messageId: "shadowedGround", data: { name: "__DEV__", fn: "f" } }],
    },
  ],
});

describe("a ground bootstrap that fails to load", () => {
  it("stops the lint run with the reason", () => {
    const linter = new Linter();
    const lint = () =>
      linter.verify(`function f() { "use isolated"; }`, [
        {
          files: ["**/*.ts"],
          languageOptions: { parser: tsParser as Linter.Parser },
          plugins: { isolated: plugin as never },
          rules: { "isolated/closed": ["error", { ground: fixture("unmarked.ground.ts") }] },
        },
      ], { filename: "file.ts" });
    expect(lint).toThrow(/must be marked isolated/);
  });
});
