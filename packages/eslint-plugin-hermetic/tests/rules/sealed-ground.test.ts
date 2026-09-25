import path from "node:path";
import { pathToFileURL } from "node:url";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { Linter } from "eslint";
import * as tsParser from "@typescript-eslint/parser";
import { describe, expect, it } from "vitest";
import plugin from "../../src/index.ts";
import { sealed } from "../../src/rules/sealed.ts";
import { fixture } from "../helpers.ts";

const ruleTester = new RuleTester();
const clock = fixture("clock.ground.ts");
const app = fixture("app.ground.ts");

ruleTester.run("configured ground", sealed, {
  valid: [
    {
      name: "globals the bootstrap allows",
      code: `function f(t) { "use hermetic"; return new Date(t).getTime() + Date.UTC(2020, 0) + Object.keys(t).length; }`,
      options: [{ ground: clock }],
    },
    {
      name: "a ground set once in settings.hermetic",
      code: `function f(t) { "use hermetic"; return new Date(t); }`,
      settings: { hermetic: { ground: clock } },
    },
    {
      name: "a path relative to the working directory",
      code: `function f(t) { "use hermetic"; return new Date(t); }`,
      options: [{ ground: path.relative(process.cwd(), clock) }],
    },
    {
      name: "a file URL",
      code: `function f(t) { "use hermetic"; return new Date(t); }`,
      options: [{ ground: pathToFileURL(clock).href }],
    },
    {
      name: "best-effort: aliasing a nested object",
      code: `function f(x) { "use hermetic"; const p = Object.prototype; return p.toString.call(x); }`,
      options: [{ ground: clock }],
    },
    {
      name: "forbid: uses that do not hand the object anywhere",
      code: `function f(x) { "use hermetic"; return [new Date(0), Date(0), Object(x), typeof Date, x instanceof Date, "now" in Date, x === Date]; }`,
      options: [{ ground: clock, aliasing: "forbid" }],
    },
    {
      name: "an ambient declaration describes a ground global",
      code: `declare const __DEV__: boolean; function f() { "use hermetic"; return __DEV__ ? JSON.stringify(1) : ""; }`,
      options: [{ ground: app }],
    },
  ],
  invalid: [
    {
      name: "a denied path in a configured ground",
      code: `function f() { "use hermetic"; return Date.now(); }`,
      options: [{ ground: clock }],
      errors: [{ messageId: "deniedPath", data: { path: "Date.now", fn: "f" } }],
    },
    {
      name: "a default ground name the bootstrap leaves out",
      code: `function f(s) { "use hermetic"; return JSON.parse(s); }`,
      options: [{ ground: clock }],
      errors: [{ messageId: "freeVariable", data: { name: "JSON", fn: "f" } }],
    },
    {
      name: "a three-segment denied path",
      code: `function f(x) { "use hermetic"; return Object.prototype.toString.call(x); }`,
      options: [{ ground: clock }],
      errors: [{ messageId: "deniedPath", data: { path: "Object.prototype.toString", fn: "f" } }],
    },
    {
      name: "nested destructuring",
      code: `function f(x) { "use hermetic"; const { prototype: { toString } } = Object; return toString.call(x); }`,
      options: [{ ground: clock }],
      errors: [{ messageId: "deniedPath", data: { path: "Object.prototype.toString", fn: "f" } }],
    },
    {
      name: "forbid: aliasing a nested object with denied members",
      code: `function f() { "use hermetic"; const p = Object.prototype; return p; }`,
      options: [{ ground: clock, aliasing: "forbid" }],
      errors: [{ messageId: "aliasedGround", data: { path: "Object.prototype", fn: "f" } }],
    },
    {
      name: "forbid: destructuring a nested object with denied members",
      code: `function f() { "use hermetic"; const { prototype } = Object; return prototype; }`,
      options: [{ ground: clock, aliasing: "forbid" }],
      errors: [{ messageId: "aliasedGround", data: { path: "Object.prototype", fn: "f" } }],
    },
    {
      name: "forbid: aliasing or passing a callable ground object",
      code: `function f(g) { "use hermetic"; const D = Date; return g(D, Date); }`,
      options: [{ ground: clock, aliasing: "forbid" }],
      errors: [
        { messageId: "aliasedGround", data: { path: "Date", fn: "f" } },
        { messageId: "aliasedGround", data: { path: "Date", fn: "f" } },
      ],
    },
    {
      name: "rule options win over settings.hermetic",
      code: `function f(t) { "use hermetic"; return new Date(t); }`,
      settings: { hermetic: { ground: clock } },
      options: [{ ground: app }],
      errors: [{ messageId: "freeVariable", data: { name: "Date", fn: "f" } }],
    },
    {
      name: "a real binding still shadows a ground global",
      code: `const __DEV__ = true; function f() { "use hermetic"; return __DEV__; }`,
      options: [{ ground: app }],
      errors: [{ messageId: "shadowedGround", data: { name: "__DEV__", fn: "f" } }],
    },
  ],
});

describe("settings.hermetic", () => {
  it("rejects an unknown value", () => {
    const lint = () =>
      new Linter().verify(`function f() { "use hermetic"; }`, [
        {
          files: ["**/*.ts"],
          languageOptions: { parser: tsParser as Linter.Parser },
          plugins: { hermetic: plugin as never },
          settings: { hermetic: { types: "strict" } },
          rules: { "hermetic/sealed": "error" },
        },
      ], { filename: "file.ts" });
    expect(lint).toThrow(/settings\.hermetic\.types must be "allow" or "structural-only"/);
  });
});

describe("a ground bootstrap that fails to load", () => {
  it("stops the lint run with the reason", () => {
    const linter = new Linter();
    const lint = () =>
      linter.verify(`function f() { "use hermetic"; }`, [
        {
          files: ["**/*.ts"],
          languageOptions: { parser: tsParser as Linter.Parser },
          plugins: { hermetic: plugin as never },
          rules: { "hermetic/sealed": ["error", { ground: fixture("unmarked.ground.ts") }] },
        },
      ], { filename: "file.ts" });
    expect(lint).toThrow(/must be marked hermetic/);
  });
});
