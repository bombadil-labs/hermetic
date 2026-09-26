import { RuleTester } from "@typescript-eslint/rule-tester";
import * as tsParser from "@typescript-eslint/parser";
import { Linter } from "eslint";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import plugin from "../../src/index.ts";
import { preferHermetic } from "../../src/rules/prefer-hermetic.ts";

const ruleTester = new RuleTester();
const lift = [{ lift: true }] as const;

ruleTester.run("prefer-hermetic: lift", preferHermetic, {
  valid: [
    { name: "lift is off by default", code: `const RATE = 0.1; function f(a: number) { return a * RATE; }` },
    { name: "a function using its own this", code: `const R = 1; function f() { return this.x + R; }`, options: lift },
    { name: "a function using arguments", code: `const R = 1; function f() { return arguments.length + R; }`, options: lift },
    {
      name: "a lifted reference inside a nested function expression",
      code: `const R = 1; function f(xs: number[]) { return xs.map(function (x) { return x * R; }); }`,
      options: lift,
    },
    { name: "a write to a constant", code: `const K = 1; function f() { K = 2; }`, options: lift },
    {
      name: "a function typed by its declaration",
      code: `const R = 1; const f: (x: number) => (y: number) => number = (x) => (y) => x * y * R;`,
      options: lift,
    },
    {
      name: "a function with a type-error suppression",
      code: `const R = 1;\nfunction f() {\n  // @ts-expect-error: deliberately wrong\n  return R.nope;\n}`,
      options: lift,
    },
    {
      name: "a default that reads a destructured parameter",
      code: `const R = 1; function f({ a }: { a: number }, b = a) { return a + b + R; }`,
      options: lift,
    },
    { name: "a const enum, which has no runtime value", code: `const enum E { A } function f() { return E.A; }`, options: lift },
    {
      name: "JSX",
      code: `const R = 1; function F() { return <b>{R}</b>; }`,
      filename: "react.tsx",
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      options: lift,
    },
    { name: "a class method", code: `const R = 1; class A { m() { return R; } }`, options: lift },
    {
      name: "a function declaration reading a constant, which it can run before",
      code: `export function f(a: number) { return a * R; }
const R = 2;`,
      options: lift,
    },
    { name: "a function declaration reading a named import", code: `import { clamp } from "./clamp";
export function f(a: number) { return clamp(a); }`, options: lift },
    { name: "a function declaration reading a global", code: `export function now() { return Date.now(); }`, options: lift },
    {
      name: "a name a class can't have as an accessor",
      code: `export const make = () => constructor;\nconst constructor = 1;`,
      options: lift,
    },
    {
      name: "a direct eval, which sees the caller's scope, and wouldn't through this",
      code: `export const run = (code: string) => { const local = 1; return eval(code) + local; };`,
      options: lift,
    },
    {
      name: "a default that calls a function, which the core would call again if it returned undefined",
      code: `const R = 1;\ndeclare function fallback(): undefined;\nexport const f = (x = fallback()) => [x, R];`,
      options: lift,
    },
    {
      name: "a function that inspects the stack, which gains a frame",
      code: `const R = 1;
export const where = () => new Error(String(R)).stack;`,
      options: lift,
    },
    {
      name: "a key-remapped mapped type written into the signature",
      code: `const R = 1;\nexport const f = <S>(s: S): { [K in keyof S as K extends string ? K : never]: S[K] } => (R ? s : s) as any;`,
      options: lift,
    },
    {
      name: "a generic rest parameter a spread would widen",
      code: `const R = 1;\nexport function f<A extends number[]>(...xs: A & { length: 2 }) { return xs.length + R; }`,
      options: lift,
    },
    { name: "a named function expression", code: `const R = 1; const f = function g() { return R; };`, options: lift },
    {
      name: "structural-only types, which the generated context type would break",
      code: `const R = 1; function f() { return R; }`,
      options: [{ lift: true, types: "structural-only" }],
    },
    {
      name: "a hand-written binding with a plain context object",
      code: [
        `const R = 1;`,
        `function f(a: number) {`,
        `  return fHermetic.call({ R }, a);`,
        `}`,
        `function fHermetic(this: { R: number }, a: number) {`,
        `  "use hermetic";`,
        `  return a * this.R;`,
        `}`,
      ].join("\n"),
      options: lift,
    },
    {
      name: "an already generated binding",
      code: [
        `const R = 1;`,
        `function f(a: number) {`,
        `  return fHermetic.call({ get R() { return R; } }, a);`,
        `}`,
        `function fHermetic(this: { R: typeof R }, a: number) {`,
        `  "use hermetic";`,
        `  return a * this.R;`,
        `}`,
      ].join("\n"),
      options: lift,
    },
  ],
  invalid: [
    {
      name: "a declaration passes what always exists directly, and keeps its name, signature and export",
      code: [
        `import * as units from "./units";`,
        ``,
        `/** Converts to cents. */`,
        `export function toCents(total: number): number {`,
        `  return units.cents(total);`,
        `}`,
      ].join("\n"),
      output: [
        `import * as units from "./units";`,
        ``,
        `/** Converts to cents. */`,
        `export function toCents(total: number): number {`,
        `  return toCentsHermetic.call({ units }, total);`,
        `}`,
        ``,
        `function toCentsHermetic(this: { units: typeof units }, total: number): number {`,
        `  "use hermetic";`,
        `  return this.units.cents(total);`,
        `}`,
      ].join("\n"),
      options: lift,
      errors: [{ messageId: "liftable", data: { fn: "toCents", names: "units" } }],
    },
    {
      name: "an arrow passes constants declared before it directly",
      code: `const STEP = 2;\nexport const next = (n: number) => n + STEP;`,
      output: [
        `const STEP = 2;`,
        `export const next = (n: number) => nextHermetic.call({ STEP }, n);`,
        ``,
        `function nextHermetic(this: { STEP: typeof STEP }, n: number) {`,
        `  "use hermetic";`,
        `  return n + this.STEP;`,
        `}`,
      ].join("\n"),
      options: lift,
      errors: [{ messageId: "liftable", data: { fn: "next", names: "STEP" } }],
    },
    {
      name: "a binding that can run before what it reads gets one shared context of getters",
      code: `export const total = (n: number) => n * RATE;\nconst RATE = 1.2;`,
      output: [
        `export const total = (n: number) => totalHermetic.call(totalContext, n);`,
        ``,
        `const totalContext = new (class {`,
        `  get RATE(): typeof RATE { return RATE; }`,
        `})();`,
        ``,
        `function totalHermetic(this: { RATE: typeof RATE }, n: number) {`,
        `  "use hermetic";`,
        `  return n * this.RATE;`,
        `}`,
        `const RATE = 1.2;`,
      ].join("\n"),
      options: lift,
      errors: [{ messageId: "liftable", data: { fn: "total", names: "RATE" } }],
    },
    {
      name: "comments in the core keep their statements",
      code: `const R = 1;\nconst f = () => {\n  // Reads the rate.\n  return R;\n};`,
      output: [
        `const R = 1;`,
        `const f = () => fHermetic.call({ R });`,
        ``,
        `function fHermetic(this: { R: typeof R }) {`,
        `  "use hermetic";`,
        `  // Reads the rate.`,
        `  return this.R;`,
        `}`,
      ].join("\n"),
      options: lift,
      errors: [{ messageId: "liftable", data: { fn: "f", names: "R" } }],
    },
    {
      name: "comments in the parameter list and after the arrow survive",
      code: `const R = 1;\nexport const f = (a: number, // the amount\n  b: number) => /* scaled */ (a + b) * R;`,
      output: [
        `const R = 1;`,
        `export const f = (a: number, b: number) => fHermetic.call({ R }, a, b);`,
        ``,
        `function fHermetic(this: { R: typeof R }, a: number, // the amount`,
        `  b: number) {`,
        `  "use hermetic";`,
        `  return /* scaled */ (a + b) * this.R;`,
        `}`,
      ].join("\n"),
      options: lift,
      errors: [{ messageId: "liftable", data: { fn: "f", names: "R" } }],
    },
    {
      name: "a comment that continues past the binding's line stays a comment",
      code: `export const f = () => R; /* a note\nthat continues */\nconst R = 1;`,
      output: [
        `export const f = () => fHermetic.call(fContext);`,
        ``,
        `const fContext = new (class {`,
        `  get R(): typeof R { return R; }`,
        `})();`,
        ``,
        `function fHermetic(this: { R: typeof R }) {`,
        `  "use hermetic";`,
        `  return this.R;`,
        `} /* a note`,
        `that continues */`,
        `const R = 1;`,
      ].join("\n"),
      options: lift,
      errors: [{ messageId: "liftable", data: { fn: "f", names: "R" } }],
    },
    {
      name: "a parameter list on several lines keeps its layout in the binding, trailing comma included",
      code: [`const STEP = 2;`, `export const scale = (`, `  value: number,`, `  factor: number,`, `): number => value * factor * STEP;`].join("\n"),
      output: [
        `const STEP = 2;`,
        `export const scale = (`,
        `  value: number,`,
        `  factor: number,`,
        `): number => scaleHermetic.call({ STEP }, value, factor);`,
        ``,
        `function scaleHermetic(`,
        `  this: { STEP: typeof STEP },`,
        `  value: number,`,
        `  factor: number,`,
        `): number {`,
        `  "use hermetic";`,
        `  return value * factor * this.STEP;`,
        `}`,
      ].join("\n"),
      options: lift,
      errors: [{ messageId: "liftable", data: { fn: "scale", names: "STEP" } }],
    },
    {
      name: "a parameter list on several lines without a trailing comma gains none",
      code: [`import * as units from "./units";`, `export function toCents(`, `  total: number,`, `  mode: "up" | "down"`, `): number {`, `  return units.cents(total, mode);`, `}`].join("\n"),
      output: [
        `import * as units from "./units";`,
        `export function toCents(`,
        `  total: number,`,
        `  mode: "up" | "down"`,
        `): number {`,
        `  return toCentsHermetic.call({ units }, total, mode);`,
        `}`,
        ``,
        `function toCentsHermetic(`,
        `  this: { units: typeof units },`,
        `  total: number,`,
        `  mode: "up" | "down"`,
        `): number {`,
        `  "use hermetic";`,
        `  return this.units.cents(total, mode);`,
        `}`,
      ].join("\n"),
      options: lift,
      errors: [{ messageId: "liftable", data: { fn: "toCents", names: "units" } }],
    },
    {
      name: "plain JavaScript gets no type annotations",
      code: `let count = 0;\nconst bump = (by) => {\n  count += by;\n  return count;\n};`,
      output: [
        `let count = 0;`,
        `const bump = (by) => bumpHermetic.call(bumpContext, by);`,
        ``,
        `const bumpContext = new (class {`,
        `  get count() { return count; }`,
        `  set count(value) { count = value; }`,
        `})();`,
        ``,
        `function bumpHermetic(by) {`,
        `  "use hermetic";`,
        `  this.count += by;`,
        `  return this.count;`,
        `}`,
      ].join("\n"),
      filename: "counter.js",
      options: lift,
      errors: [{ messageId: "liftable", data: { fn: "bump", names: "count" } }],
    },
    {
      name: "generated names avoid existing bindings",
      code: `const fHermetic = 0;\nconst fContext = 0;\nconst f = () => fHermetic + fContext + R;\nconst R = 1;`,
      output: [
        `const fHermetic = 0;`,
        `const fContext = 0;`,
        `const f = () => fHermetic2.call(fContext2);`,
        ``,
        `const fContext2 = new (class {`,
        `  get fHermetic(): typeof fHermetic { return fHermetic; }`,
        `  get fContext(): typeof fContext { return fContext; }`,
        `  get R(): typeof R { return R; }`,
        `})();`,
        ``,
        `function fHermetic2(this: { fHermetic: typeof fHermetic; fContext: typeof fContext; R: typeof R }) {`,
        `  "use hermetic";`,
        `  return this.fHermetic + this.fContext + this.R;`,
        `}`,
        `const R = 1;`,
      ].join("\n"),
      options: lift,
      errors: [{ messageId: "liftable", data: { fn: "f", names: "fHermetic, fContext, R" } }],
    },
  ],
});

/** Applies every fix `prefer-hermetic` offers with `lift`, as `eslint --fix` would. */
function fix(code: string): { output: string; remaining: Linter.LintMessage[] } {
  const result = new Linter().verifyAndFix(
    code,
    [
      {
        files: ["**/*.ts"],
        languageOptions: { parser: tsParser as Linter.Parser },
        plugins: { hermetic: plugin },
        rules: { "hermetic/prefer-hermetic": ["error", { lift: true }], "hermetic/sealed": "error" },
      },
    ],
    { filename: "module.ts" },
  );
  return { output: result.output, remaining: result.messages };
}

/** Runs a TypeScript module body in strict mode, as a module would, and returns the named bindings. */
function run(code: string, names: readonly string[]): Record<string, unknown> {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(`"use strict";\n${js}\nreturn { ${names.join(", ")} };`)() as Record<string, unknown>;
}

/** Type-checks one module in memory, with strict settings, and returns its diagnostics. */
function typecheck(code: string): string[] {
  const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts"], types: [] };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version) =>
    name === "module.ts" ? ts.createSourceFile(name, code, version) : getSourceFile(name, version);
  const program = ts.createProgram(["module.ts"], options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
}

describe("lifted code type-checks", () => {
  const modules: Record<string, string> = {
    "a generic function": `const PICK = 0;\nexport const first = <T, U extends T[] = T[]>(xs: U): T | undefined => xs[PICK];\nconst n: number | undefined = first([1, 2]);`,
    "a unique symbol, passed directly": `const key: unique symbol = Symbol("key");\nexport const tag = (o: object) => ({ ...o, [key]: true });`,
    "a unique symbol, read through a getter": `export const tag = (o: object) => ({ ...o, [key]: true });\nconst key: unique symbol = Symbol("key");`,
    "overloads, passing a declaration directly": `function sep() { return ","; }\nexport function join(a: string): string;\nexport function join(a: string[]): string;\nexport function join(a: string | string[]): string { return typeof a === "string" ? a : a.join(sep()); }`,
    "async and generators": `const OFFSET = 1;\nexport const later = async (x: number): Promise<number> => x + OFFSET;\nexport const count = function* (n: number): Generator<number> { for (let i = 0; i < n; i++) yield i + OFFSET; };`,
    "classes, enums and namespaces": `class Box { constructor(readonly v: number) {} }\nenum Color { Red }\nnamespace Units { export const scale = 2; }\nexport const make = (v: number) => [new Box(v * Units.scale), Color.Red] as const;`,
    "defaults without type annotations": `const BASE = 2;\nexport const scale = (x: number, factor = BASE, { round = true } = {}) => { const v = x * factor; return round ? Math.round(v) : v; };\nconst r: number = scale(1.5);`,
    "literal constants in mutable declarations": `const INITIAL = 100;\nconst MODE = "fast";\ntype Mode = "fast" | "slow";\nexport const backoff = (tries: number, mode: Mode = MODE) => { let delay = INITIAL; for (let i = 0; i < tries; i++) delay *= 2; return mode === "fast" ? delay : delay * 2; };`,
    "mutable state and type predicates": `let seen = 0;\nexport const isNumber = (x: unknown): x is number => { seen++; return typeof x === "number" && seen > 0; };`,
    "generic rest parameters": `const R = 1;\nexport const f = <A extends unknown[]>(...xs: A) => xs.length + R;\nexport const g = <A>(...xs: readonly A[]) => xs.length + R;`,
    "a key-remapped mapped type behind an alias": `const R = 1;\ntype Strings<S> = { [K in keyof S as K extends string ? K : never]: S[K] };\nexport const f = <S>(s: S): Strings<S> => (R ? s : s) as any;`,
    "a generic signature in the return type": `class Base { k = 1; }\nexport const tagged = <Tag extends string>(tag: Tag): new <A = {}>(args: A extends string ? void : A) => Readonly<A> & { readonly _tag: Tag } => class extends Base { readonly _tag = tag; } as any;`,
  };
  for (const [name, code] of Object.entries(modules)) {
    it(name, () => {
      expect(typecheck(code), "the original should type-check").toEqual([]);
      const { output, remaining } = fix(code);
      expect(output).not.toBe(code);
      expect(remaining).toEqual([]);
      expect(typecheck(output)).toEqual([]);
    });
  }
});

describe("lift semantics", () => {
  const cases: { name: string; code: string; probe: string }[] = [
    {
      name: "hoisted declarations pass each other directly",
      code: `const early = user();\nfunction user() { return base() + 1; }\nfunction base() { return 41; }\nconst FACTOR = 6;\nconst scaled = () => base() * FACTOR;\nconst probe = () => [early, user(), scaled()];`,
      probe: "probe",
    },
    {
      name: "a binding called during setup, before a constant it reads on another path",
      code: `const pick = (late: boolean) => (late ? LATER : 0);\nconst early = pick(false);\nconst LATER = 1;\nconst probe = () => [early, pick(true)];`,
      probe: "probe",
    },
    {
      name: "a binding called later on its own line finds its context",
      code: `let R = 1;\nconst f = () => R + 1; const early = f();\nconst probe = () => [early, f()];`,
      probe: "probe",
    },
    {
      name: "mutable module state, read and written",
      code: `let count = 0;\nconst bump = (by: number) => { count += by; return count; };\nconst probe = () => [bump(2), bump(3), count];`,
      probe: "probe",
    },
    {
      name: "state changed during a call is read when the core reads it",
      code: `let mode = "a";\nconst flip = () => { mode = "b"; };\nconst observe = () => { const before = mode; flip(); return [before, mode]; };\nconst probe = () => [observe()];`,
      probe: "probe",
    },
    {
      name: "destructuring assignment to module state",
      code: `let last: unknown;\nconst remember = (o: { last: unknown }) => { ({ last } = o); return last; };\nconst probe = () => [remember({ last: 4 }), last];`,
      probe: "probe",
    },
    {
      name: "recursion through the public name",
      code: `const ONE = 1;\nconst fact = (n: number): number => (n <= ONE ? ONE : n * fact(n - 1));\nfunction fib(n: number): number { return n < 2 ? n : fib(n - 1) + fib(n - 2); }\nconst probe = () => [fact(5), fib(10)];`,
      probe: "probe",
    },
    {
      name: "a global under typeof that does not exist",
      code: `const hasWindow = () => (typeof window !== "undefined" ? window : "none");\nconst probe = () => [hasWindow()];`,
      probe: "probe",
    },
    {
      name: "a host function called bare still gets no receiver",
      code: `(globalThis as any).hostFn = function (this: unknown) { "use strict"; return this === undefined; };\ndeclare const hostFn: () => boolean;\nconst callHost = () => hostFn();\nconst probe = () => [callHost()];`,
      probe: "probe",
    },
    {
      name: "a host function called bare and read as a value keeps its properties and identity",
      code: `(globalThis as any).hostFn = Object.assign(function (this: unknown) { "use strict"; return this === undefined; }, { version: 2 });\ndeclare const hostFn: { (): boolean; version: number };\nconst f = () => [hostFn(), hostFn.version, hostFn === (globalThis as any).hostFn, typeof hostFn];\nconst probe = () => [f()];`,
      probe: "probe",
    },
    {
      name: "a built-in's members, read through the context",
      code: `const roll = () => Math.random() < 2 && Math.max(1, 2) === 2;\nconst probe = () => [roll()];`,
      probe: "probe",
    },
    {
      name: "a built-in called bare keeps its own properties",
      code: `const parse = (s: string) => { const n = Number(s); return Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : BigInt(n) + BigInt.asUintN(8, 257n); };\nconst probe = () => [parse("4"), parse("x")];`,
      probe: "probe",
    },
    {
      name: "generators",
      code: `const STEP = 3;\nconst steps = function* (n: number) { for (let i = 0; i < n; i++) yield i * STEP; };\nconst probe = () => [[...steps(4)]];`,
      probe: "probe",
    },
    {
      name: "defaults, destructuring and rest parameters",
      code: `const DEFAULT_A = 10;\nconst BONUS = 1;\nconst withDefault = (a = DEFAULT_A) => a;\nconst pick = ({ a = 1, b }: { a?: number; b?: number } = {}) => a + (b ?? 0) + BONUS;\nconst sum = (...xs: number[]) => xs.reduce((x, y) => x + y, 0) * BONUS;\nconst probe = () => [withDefault(), withDefault(5), pick(), pick({ b: 2 }), sum(1, 2, 3)];`,
      probe: "probe",
    },
    {
      name: "shorthand properties and nested arrows",
      code: `const SCALE = 2;\nconst double = (x: number) => x * SCALE;\nconst wrap = (xs: number[]) => ({ SCALE, doubled: xs.map((x) => double(x)) });\nconst probe = () => [wrap([1, 2])];`,
      probe: "probe",
    },
  ];

  for (const { name, code, probe } of cases) {
    it(`preserves behavior: ${name}`, () => {
      const { output, remaining } = fix(code);
      expect(output, "the fix should change something").not.toBe(code);
      expect(remaining, "every core should pass sealed, and nothing should be left to lift").toEqual([]);
      const before = run(code, [probe]);
      const after = run(output, [probe]);
      expect((after[probe] as () => unknown)()).toEqual((before[probe] as () => unknown)());
    });
  }

  it("calls a host function without a receiver, and passes it unbound", () => {
    const { output } = fix(`declare const hostFn: { (): number; version: number };\nexport const f = () => hostFn() + hostFn.version;`);
    expect(output).toContain("(0, this.hostFn)() + this.hostFn.version");
    expect(output).toContain("get hostFn(): typeof hostFn { return hostFn; }");
  });

  it("preserves async behavior", async () => {
    const code = `const OFFSET = 5;\nconst later = async (x: number) => x + OFFSET;`;
    const { output, remaining } = fix(code);
    expect(output).not.toBe(code);
    expect(remaining).toEqual([]);
    const before = run(code, ["later"]);
    const after = run(output, ["later"]);
    await expect((after.later as (x: number) => Promise<number>)(1)).resolves.toBe(
      await (before.later as (x: number) => Promise<number>)(1),
    );
  });

  it("settles: a second run changes nothing", () => {
    const code = [
      `import { clamp } from "./clamp";`,
      `const RATE = 0.1;`,
      `export const apply = <T>(total: number, tag: T) => [clamp(total * (1 - RATE)), tag] as const;`,
      `export function toCents(x: number) { return round(x * 100); }`,
      `function round(x: number) { return Math.round(x); }`,
      `export const noop = () => {};`,
    ].join("\n");
    const once = fix(code).output;
    expect(once).toContain("applyContext");
    expect(once).toContain("{ round }");
    expect(fix(once).output).toBe(once);
  });
});
