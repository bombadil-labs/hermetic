import * as tsParser from "@typescript-eslint/parser";
import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import plugin from "../src/index.ts";
import { unlift } from "../src/unlift.ts";

/** Applies `prefer-hermetic`'s fixes, with or without lift. */
function fix(code: string, filename: string, lift: boolean): string {
  return new Linter().verifyAndFix(
    code,
    [
      {
        files: ["**/*.ts", "**/*.js"],
        languageOptions: { parser: tsParser as Linter.Parser },
        plugins: { hermetic: plugin },
        rules: { "hermetic/prefer-hermetic": ["error", { lift }] },
      },
    ],
    { filename },
  ).output;
}

describe("unlift undoes the lift exactly", () => {
  const modules: Record<string, string> = {
    "a declaration, passed its helpers directly": [
      `import * as units from "./units";`,
      ``,
      `/** Converts dollars to whole cents. */`,
      `export function toCents(dollars: number) {`,
      `  return round(units.centsPerDollar * dollars);`,
      `}`,
      ``,
      `function round(amount: number) {`,
      `  return Math.round(amount);`,
      `}`,
    ].join("\n"),
    "state, host functions, built-ins and a guarded global, through a shared context": [
      `let calls = 0;`,
      `declare const hostFn: { (): number; version: number };`,
      `declare const hostTag: (strings: TemplateStringsArray) => string;`,
      `export const probe = (n: number) => {`,
      `  calls += n;`,
      `  const seen = typeof window === "undefined" ? 0 : 1;`,
      `  return [calls, hostFn(), hostFn?.(), hostFn.version, hostTag\`n\`, seen, Date.now() > 0, Number(n), Number.isFinite(n)];`,
      `};`,
    ].join("\n"),
    "expression bodies with parentheses and comments": [
      `const STEP = 2;`,
      `export const next = (n: number) => /* step */ ({ n: n + STEP });`,
      `export const pair = (a: number) => (a, STEP);`,
      `export const later = (n: number) => // explain`,
      `  n * STEP;`,
    ].join("\n"),
    "generics, overloads and a unique symbol": [
      `const key: unique symbol = Symbol("key");`,
      `const SEP = ",";`,
      `export const tag = <T extends object>(o: T) => ({ ...o, [key]: true });`,
      `function sep() { return SEP; }`,
      `export function join(a: string): string;`,
      `export function join(a: string[]): string;`,
      `export function join(a: string | string[]): string {`,
      `  return typeof a === "string" ? a : a.join(sep());`,
      `}`,
    ].join("\n"),
    "async, generators and a default export": [
      `const OFFSET = 1;`,
      `export const later = async (x: number): Promise<number> => x + OFFSET;`,
      `export const count = function* (n: number) {`,
      `  for (let i = 0; i < n; i++) yield i + OFFSET;`,
      `};`,
      `function base() { return 41; }`,
      `export default function answer() {`,
      `  return base() + 1;`,
      `}`,
    ].join("\n"),
    "defaults, patterns, rest parameters and shorthand": [
      `const BASE = 2;`,
      `let last: unknown;`,
      `export const scale = (x: number, factor = BASE, { round = true }: { round?: boolean } = {}, ...rest: number[]) => {`,
      `  ({ last } = { last: rest });`,
      `  return { BASE, value: round ? Math.round(x * factor) : x * factor };`,
      `};`,
    ].join("\n"),
    "recursion through the public name": [
      `const ONE = 1;`,
      `export const fact = (n: number): number => (n <= ONE ? ONE : n * fact(n - 1));`,
      `export function fib(n: number): number {`,
      `  return n < 2 ? n : fib(n - 1) + fib(n - 2);`,
      `}`,
    ].join("\n"),
    "comments in parameter lists, and layouts": [
      `const R = 1;`,
      `export const f = (a: number, // the amount`,
      `  b: number) => (a + b) * R;`,
      `export const g = (`,
      `  a: number,`,
      `  b: number,`,
      `) => a * b * R;`,
    ].join("\n"),
    "code sharing the binding's line": [
      `export const f = () => R + 1; const early = f; /* a note`,
      `that continues */`,
      `export const g = () => R; // trailing`,
      `const R = 1;`,
    ].join("\n"),
    "Windows line breaks": [`const R = 1;`, `export function f(a: number) {`, `  return a * R;`, `}`, `export const g = () => R;`].join("\r\n"),
  };

  for (const [name, code] of Object.entries(modules)) {
    it(name, () => {
      const lifted = fix(code, "module.ts", true);
      expect(lifted, "the lift should change the module").not.toBe(fix(code, "module.ts", false));
      const result = unlift(lifted);
      expect(result.skipped).toEqual([]);
      expect(result.code).toBe(fix(code, "module.ts", false));
    });
  }

  it("plain JavaScript", () => {
    const code = `let count = 0;\nconst STEP = 2;\nexport const bump = (by) => {\n  count += by * STEP;\n  return count;\n};\nexport function twice(n) {\n  return bump(bump(n));\n}`;
    const lifted = fix(code, "counter.js", true);
    expect(lifted).toContain("bumpContext");
    expect(unlift(lifted, "counter.js").code).toBe(fix(code, "counter.js", false));
  });

  it("JavaScript whose types were stripped after the lift", () => {
    const lifted = [
      `const RATE = 0.1;`,
      `export const apply = (total) => (applyHermetic).call({ RATE }, total);`,
      ``,
      `function applyHermetic(total) {`,
      `  "use hermetic";`,
      `  return total * (1 - this.RATE);`,
      `}`,
    ].join("\n");
    expect(unlift(lifted, "module.js").code).toBe(`const RATE = 0.1;\nexport const apply = (total) => total * (1 - RATE);`);
  });

  it("leaves hermetic functions and everything else as they are", () => {
    const code = [
      `function f(a: number) {\n  "use hermetic";\n  return a + 1;\n}`,
      `export const g = () => f(1);`,
      `export const h = () => g.call(undefined);`,
      `function notHermetic(this: { R: number }) {\n  return this.R;\n}`,
      `export const i = () => notHermetic.call({ R: 1 });`,
    ].join("\n");
    expect(unlift(code)).toEqual({ code, unlifted: [], skipped: [] });
  });
});

describe("unlift leaves bindings it cannot undo exactly", () => {
  const core = (body: string, params = "") => `function fHermetic(this: { R: typeof R }${params}) {\n  "use hermetic";\n  ${body}\n}`;
  const cases: { name: string; code: string; reason: string }[] = [
    {
      name: "an exported core",
      code: `const R = 1;\nexport const f = () => fHermetic.call({ R });\nexport ${core("return this.R;")}`,
      reason: "the core is exported",
    },
    {
      name: "a core called from elsewhere",
      code: `const R = 1;\nexport const f = () => fHermetic.call({ R });\n${core("return this.R;")}\nexport const test = () => fHermetic.call({ R: 2 });`,
      reason: "the core is used elsewhere",
    },
    {
      name: "a context that is neither a literal nor a constant",
      code: `const R = 1;\nexport const f = () => fHermetic.call(undefined);\n${core("return 1;")}`,
      reason: "the context is not a module constant holding an object literal",
    },
    {
      name: "a getter that does more than read",
      code: `let reads = 0;\nconst R = 1;\nexport const f = () => fHermetic.call(fContext);\nconst fContext = {\n  get R() { reads++; return R; },\n};\n${core("return this.R;")}`,
      reason: "the context's accessor for 'R' does more than read or write a name",
    },
    {
      name: "a core that passes this along",
      code: `const R = 1;\nexport const f = () => fHermetic.call({ R });\n${core("return [this.R, this];")}`,
      reason: "the core uses this other than to read a name",
    },
    {
      name: "a local that would capture the name",
      code: `const R = 1;\nexport const f = () => fHermetic.call({ R });\n${core("{ const R = 2; return this.R + R; }")}`,
      reason: "a local 'R' in the core shadows the binding",
    },
    {
      name: "defaults that differ",
      code: `const R = 1;\nexport const f = (x = 1) => fHermetic.call({ R }, x);\n${core("return this.R + x;", ", x = 2")}`,
      reason: "the binding's parameters do not match the core's",
    },
    {
      name: "a write through a direct context, which never reached the binding",
      code: `let R = 1;\nexport const f = () => fHermetic.call({ R });\n${core("this.R = 2; return this.R;")}`,
      reason: "the core assigns 'this.R', which its context cannot write",
    },
    {
      name: "a context that reads a parameter of the binding",
      code: `export const f = (R: number) => fHermetic.call({ R }, R);\n${core("return this.R + x;", ", x: number")}`,
      reason: "the context reads a parameter or local of the binding",
    },
  ];

  for (const { name, code, reason } of cases) {
    it(name, () => {
      const result = unlift(code);
      expect(new Set(result.skipped.map((skip) => skip.reason))).toEqual(new Set([reason]));
      expect(result.code).toBe(code);
    });
  }
});
