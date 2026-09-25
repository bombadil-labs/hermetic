import { RuleTester } from "@typescript-eslint/rule-tester";
import { preferHermetic } from "../../src/rules/prefer-hermetic.ts";
import { fixture } from "../helpers.ts";

const ruleTester = new RuleTester();
const already = (fn: string) => ({ messageId: "alreadyHermetic" as const, data: { fn } });

ruleTester.run("prefer-hermetic: marking", preferHermetic, {
  valid: [
    { name: "already marked", code: `function f(a) { "use hermetic"; return a + 1; }` },
    { name: "already tagged", code: `/** @hermetic */ const f = (a) => a + 1;` },
    { name: "not hermetic", code: `const R = 1; function f() { return R; }` },
    { name: "a lexical this escapes", code: `const f = () => this;` },
    { name: "a nested function", code: `const R = 1; function outer() { function inner() { return 1; } return inner() + R; }` },
    { name: "a callback", code: `run(() => 1);` },
    { name: "an IIFE", code: `(function () { return 1; })();` },
    { name: "outside the default ground", code: `function f() { return Date.now(); }` },
  ],
  invalid: [
    {
      name: "a one-line declaration",
      code: `function f(a) { return a + 1; }`,
      output: `function f(a) { "use hermetic"; return a + 1; }`,
      errors: [{ ...already("f"), line: 1, column: 10 }],
    },
    {
      name: "a multi-line declaration keeps indentation",
      code: `export function f(a: number) {\n    // Adds one.\n    return a + 1;\n}`,
      output: `export function f(a: number) {\n    "use hermetic";\n    // Adds one.\n    return a + 1;\n}`,
      errors: [already("f")],
    },
    {
      name: "a type-error suppression stays on the line before its statement",
      code: `function f(o: { a: number }) {\n  // @ts-expect-error: b is not declared\n  return o.b;\n}`,
      output: `function f(o: { a: number }) {\n  "use hermetic";\n  // @ts-expect-error: b is not declared\n  return o.b;\n}`,
      errors: [already("f")],
    },
    {
      name: "a comment after the brace stays on the brace's line",
      code: `function f(o: { a: number }) { // @ts-expect-error: b is not declared\n  return o.b;\n}`,
      output: `function f(o: { a: number }) { "use hermetic"; // @ts-expect-error: b is not declared\n  return o.b;\n}`,
      errors: [already("f")],
    },
    {
      name: "a statement flush against the brace",
      code: `function f(){return 1}`,
      output: `function f(){ "use hermetic"; return 1}`,
      errors: [already("f")],
    },
    {
      name: "Windows line breaks",
      code: `function f() {\r\n  return 1;\r\n}`,
      output: `function f() {\r\n  "use hermetic";\r\n  return 1;\r\n}`,
      errors: [already("f")],
    },
    {
      name: "an empty body",
      code: `function noop() {}`,
      output: `function noop() { "use hermetic"; }`,
      errors: [already("noop")],
    },
    {
      name: "an empty body over two lines",
      code: `  function noop() {\n  }`,
      output: `  function noop() {\n    "use hermetic";\n  }`,
      errors: [already("noop")],
    },
    {
      name: "existing directives stay",
      code: `function f() {\n  "use strict";\n  return 1;\n}`,
      output: `function f() {\n  "use hermetic";\n  "use strict";\n  return 1;\n}`,
      errors: [already("f")],
    },
    {
      name: "an expression-bodied arrow gets a JSDoc tag",
      code: `const inc = (a: number) => a + 1;`,
      output: `/** @hermetic */\nconst inc = (a: number) => a + 1;`,
      errors: [already("inc")],
    },
    {
      name: "the tag joins an existing multi-line JSDoc",
      code: `/**\n * Adds one.\n */\nexport const inc = (a: number) => a + 1;`,
      output: `/**\n * Adds one.\n * @hermetic\n */\nexport const inc = (a: number) => a + 1;`,
      errors: [already("inc")],
    },
    {
      name: "a one-line JSDoc becomes multi-line",
      code: `  /** Adds one. */\n  export const inc = (a: number) => a + 1;`,
      output: `  /**\n   * Adds one.\n   * @hermetic\n   */\n  export const inc = (a: number) => a + 1;`,
      errors: [already("inc")],
    },
    {
      name: "an object property",
      code: `export const api = { inc: (a: number) => a + 1 };`,
      output: `export const api = { /** @hermetic */ inc: (a: number) => a + 1 };`,
      errors: [already("inc")],
    },
    {
      name: "a class method",
      code: `class Calc {\n  twice(a: number) {\n    return a * 2;\n  }\n}`,
      output: `class Calc {\n  twice(a: number) {\n    "use hermetic";\n    return a * 2;\n  }\n}`,
      errors: [already("twice")],
    },
    {
      name: "a method's own this is its declared environment",
      code: `class A { f() { return this.x; } }`,
      output: `class A { f() { "use hermetic"; return this.x; } }`,
      errors: [already("f")],
    },
    {
      name: "several declarators are tagged one by one",
      code: `const a = () => 1, b = () => 2;`,
      output: `const a = /** @hermetic */ () => 1, b = /** @hermetic */ () => 2;`,
      errors: [already("a"), already("b")],
    },
    {
      name: "an anonymous default export",
      code: `export default (a: number) => a + 1;`,
      output: `/** @hermetic */\nexport default (a: number) => a + 1;`,
      errors: [already("default")],
    },
    {
      name: "the configured ground decides",
      code: `function f(t: number) { return new Date(t); }`,
      output: `function f(t: number) { "use hermetic"; return new Date(t); }`,
      settings: { hermetic: { ground: fixture("clock.ground.ts") } },
      errors: [already("f")],
    },
  ],
});
