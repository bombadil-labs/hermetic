import { RuleTester } from "@typescript-eslint/rule-tester";
import { sealed, type MessageIds } from "../../src/rules/sealed.ts";

const ruleTester = new RuleTester();

type ErrorSpec = { messageId: MessageIds; data?: Record<string, string>; line?: number; column?: number; endColumn?: number };

const free = (name: string, fn = "f"): ErrorSpec => ({ messageId: "freeVariable", data: { name, fn } });
const denied = (path: string, fn = "f"): ErrorSpec => ({ messageId: "deniedPath", data: { path, fn } });
const aliased = (path: string, fn = "f"): ErrorSpec => ({ messageId: "aliasedGround", data: { path, fn } });
const escape = (messageId: MessageIds, fn = "f"): ErrorSpec => ({ messageId, data: { fn } });

ruleTester.run("spec: valid cases", sealed, {
  valid: [
    { name: "arguments only", code: `function f(a) { "use hermetic"; return a.x + 1; }` },
    { name: "this in a declaration", code: `function f() { "use hermetic"; return this.rate; }` },
    {
      name: "inner closure over locals",
      code: `function f(xs) { "use hermetic"; const k = 2; return xs.map(x => x * k); }`,
    },
    { name: "ground name", code: `function f(a, b) { "use hermetic"; return Math.max(a, b); }` },
    { name: "calling a passed callback", code: `function f(cb) { "use hermetic"; return cb(1); }` },
    {
      name: "type-only import (default)",
      code: `import type { Invoice } from "./invoice"; function f(i: Invoice) { "use hermetic"; return i.total; }`,
    },
  ],
  invalid: [
    {
      name: "module constant",
      code: `const RATE = 0.1; function f(a) { "use hermetic"; return a * RATE; }`,
      errors: [free("RATE")],
    },
    {
      name: "imported function",
      code: `import { clamp } from "./clamp"; function f(a) { "use hermetic"; return clamp(a); }`,
      errors: [free("clamp")],
    },
    {
      name: "imported function, even hermetic",
      code: `function clamp(n) { "use hermetic"; return n; } function f(a) { "use hermetic"; return clamp(a); }`,
      errors: [free("clamp")],
    },
    {
      name: "this in hermetic arrow",
      code: `const f = () => { "use hermetic"; return this.x; }`,
      errors: [escape("lexicalThis")],
    },
    {
      name: "parameter default escapes",
      code: `function f(a = DEFAULT) { "use hermetic"; return a; }`,
      errors: [free("DEFAULT")],
    },
    {
      name: "denied path",
      code: `function f() { "use hermetic"; return Math.random(); }`,
      errors: [{ ...denied("Math.random"), line: 1, column: 39, endColumn: 50 }],
    },
    { name: "clock", code: `function f() { "use hermetic"; return Date.now(); }`, errors: [free("Date")] },
    {
      name: "super",
      code: `class A extends B { method() { "use hermetic"; return super.method(); } }`,
      errors: [escape("superReference", "method")],
    },
    {
      name: "import.meta",
      code: `function f() { "use hermetic"; return import.meta.url; }`,
      errors: [escape("importMeta")],
    },
    { name: "typeof on a global", code: `function f() { "use hermetic"; return typeof window; }`, errors: [free("window")] },
    { name: "eval", code: `function f(s) { "use hermetic"; return eval(s); }`, errors: [free("eval")] },
  ],
});

ruleTester.run("marking", sealed, {
  valid: [
    { name: "unmarked functions are not checked", code: `const R = 1; function f() { return R; }` },
    {
      name: "a directive after the prologue does not mark",
      code: `const R = 1; function f() { const x = R; "use hermetic"; return x; }`,
    },
    {
      name: "a JSDoc tag mentioned mid-sentence does not mark",
      code: `const R = 1; /** Not @hermetic, just a note. */ function f() { return R; }`,
    },
    { name: "a plain block comment does not mark", code: `const R = 1; /* @hermetic */ function f() { return R; }` },
    { name: "a line comment does not mark", code: `const R = 1;\n// @hermetic\nfunction f() { return R; }` },
    {
      name: "only the exact directive marks",
      code: `const R = 1; function f() { "use hermetic strict"; return R; }`,
    },
  ],
  invalid: [
    {
      name: "directive after other directives",
      code: `const R = 1; function f() { "use strict"; "use hermetic"; return R; }`,
      errors: [free("R")],
    },
    {
      name: "JSDoc on a function declaration",
      code: `const R = 1; /** @hermetic */ function f() { return R; }`,
      errors: [free("R")],
    },
    {
      name: "JSDoc on an exported function",
      code: `const R = 1; /** @hermetic */ export function f() { return R; }`,
      errors: [free("R")],
    },
    {
      name: "JSDoc on an expression-bodied arrow",
      code: `const R = 1; /** @hermetic */ const f = () => R;`,
      errors: [free("R")],
    },
    {
      name: "JSDoc on an exported const",
      code: `const R = 1; /** @hermetic */ export const f = function () { return R; };`,
      errors: [free("R")],
    },
    {
      name: "JSDoc tag among other tags",
      code: `const R = 1;\n/**\n * Adds R.\n * @param a a number\n * @hermetic\n */\nfunction f(a) { return a + R; }`,
      errors: [free("R")],
    },
    {
      name: "JSDoc directly before a function expression argument",
      code: `const R = 1; run(/** @hermetic */ function () { return R; });`,
      errors: [free("R", "<anonymous>")],
    },
    {
      name: "object method",
      code: `const R = 1; const o = { m() { "use hermetic"; return R; } };`,
      errors: [free("R", "m")],
    },
    {
      name: "JSDoc on an object property",
      code: `const R = 1; const o = { /** @hermetic */ m: () => R };`,
      errors: [free("R", "m")],
    },
    {
      name: "class method",
      code: `const R = 1; class C { m() { "use hermetic"; return R; } }`,
      errors: [free("R", "m")],
    },
    {
      name: "JSDoc on a class field arrow",
      code: `const R = 1; class C { /** @hermetic */ m = () => R; }`,
      errors: [free("R", "m")],
    },
    {
      name: "getter",
      code: `const R = 1; class C { get v() { "use hermetic"; return R; } }`,
      errors: [free("R", "v")],
    },
    {
      name: "private method",
      code: `const R = 1; class C { #m() { "use hermetic"; return R; } }`,
      errors: [free("R", "#m")],
    },
    {
      name: "anonymous default export",
      code: `const R = 1; export default function () { "use hermetic"; return R; }`,
      errors: [free("R", "default")],
    },
    {
      name: "JSDoc on an assignment",
      code: `const R = 1; /** @hermetic */ exports.f = function () { return R; };`,
      errors: [free("R")],
    },
    {
      name: "async function",
      code: `const R = 1; async function f() { "use hermetic"; return await R; }`,
      errors: [free("R")],
    },
    { name: "generator", code: `const R = 1; function* f() { "use hermetic"; yield R; }`, errors: [free("R")] },
  ],
});

ruleTester.run("free variables", sealed, {
  valid: [
    { name: "own arguments", code: `function f() { "use hermetic"; return arguments.length; }` },
    { name: "this in a nested arrow", code: `function f() { "use hermetic"; return [1].map(() => this.k); }` },
    {
      name: "a nested function's own this",
      code: `const f = () => { "use hermetic"; return function () { return this; }; };`,
    },
    { name: "this in a hermetic method", code: `const o = { m() { "use hermetic"; return this.x; } };` },
    { name: "own new.target", code: `function F() { "use hermetic"; return new.target; }` },
    {
      name: "super within a class declared inside",
      code: `function f() { "use hermetic"; class A { m() { return 1; } } class B extends A { m() { return super.m() + 1; } } return new B().m(); }`,
    },
    {
      name: "this in a static block of a class declared inside a hermetic arrow",
      code: `const f = () => { "use hermetic"; return class { static { this.y = 1; } }; };`,
    },
    {
      name: "named function expression recursion",
      code: `const fact = function self(n) { "use hermetic"; return n <= 1 ? 1 : n * self(n - 1); };`,
    },
    {
      name: "function declaration recursion",
      code: `function fact(n) { "use hermetic"; return n <= 1 ? 1 : n * fact(n - 1); }`,
    },
    {
      name: "overloaded declaration recursion",
      code: `function f(n: string): string; function f(n: number): number; function f(n: any): any { "use hermetic"; return n ? f(n - 1) : n; }`,
    },
    { name: "locals shadow outer names", code: `const R = 1; function f() { "use hermetic"; const R = 2; return R; }` },
    {
      name: "parameters, destructuring, defaults and catch",
      code: `function f({ a }, b = a) { "use hermetic"; try { return b; } catch (e) { return e; } }`,
    },
    { name: "labels", code: `function f() { "use hermetic"; outer: for (;;) { break outer; } }` },
    {
      name: "default ground names",
      code: `function f(s) { "use hermetic"; const m = new Map([[1, new Set()]]); return [JSON.parse(s) ?? undefined ?? NaN, Promise.resolve(m), new TypeError("x"), Number.isFinite(Infinity)]; }`,
    },
    {
      // Known limit, documented in the README: being hermetic is not confinement.
      name: "reaching Function through a literal is member access, not a free variable",
      code: `function f() { "use hermetic"; return [].constructor.constructor; }`,
    },
  ],
  invalid: [
    {
      name: "arguments inside a hermetic arrow belongs to the enclosing function",
      code: `function outer() { return () => { "use hermetic"; return arguments[0]; }; }`,
      errors: [free("arguments", "<anonymous>")],
    },
    {
      name: "a const arrow referring to itself",
      code: `const f = () => { "use hermetic"; return f; };`,
      errors: [free("f")],
    },
    {
      name: "a reassigned function declaration referring to itself",
      code: `function f() { "use hermetic"; return f; } f = null;`,
      errors: [free("f")],
    },
    {
      name: "a class referring to itself from a method",
      code: `class A { m() { "use hermetic"; return new A(); } }`,
      errors: [free("A", "m")],
    },
    {
      name: "an escape from a nested closure is reported once",
      code: `const R = 1; function f(xs) { "use hermetic"; return xs.map((x) => x * R); }`,
      errors: [free("R")],
    },
    {
      name: "implicit global assignment",
      code: `function f() { "use hermetic"; leaked = 1; }`,
      errors: [free("leaked")],
    },
    {
      name: "a local binding that shadows a ground name",
      code: `const Math = { max: () => 0 }; function f(a, b) { "use hermetic"; return Math.max(a, b); }`,
      errors: [{ messageId: "shadowedGround", data: { name: "Math", fn: "f" } }],
    },
    {
      name: "an import that shadows a ground name",
      code: `import { JSON } from "./json"; function f(s) { "use hermetic"; return JSON.parse(s); }`,
      errors: [{ messageId: "shadowedGround", data: { name: "JSON", fn: "f" } }],
    },
    {
      name: "assigning to a ground name",
      code: `function f() { "use hermetic"; Math = null; }`,
      errors: [{ messageId: "groundWrite", data: { name: "Math", fn: "f" } }],
    },
    {
      name: "ambient authority",
      code: `function f() { "use hermetic"; console.log(globalThis, fetch, setTimeout, process, Function, Intl); }`,
      errors: ["console", "globalThis", "fetch", "setTimeout", "process", "Function", "Intl"].map((name) => free(name)),
    },
    {
      name: "a template tag",
      code: "const html = (s) => s; function f() { \"use hermetic\"; return html`x`; }",
      errors: [free("html")],
    },
    {
      name: "a class extending an outer class",
      code: `function f() { "use hermetic"; return class extends Base {}; }`,
      errors: [free("Base")],
    },
    {
      name: "an enum value (its type annotation is fine)",
      code: `enum Color { Red } function f(c: Color) { "use hermetic"; return c === Color.Red; }`,
      errors: [free("Color")],
    },
    {
      name: "the documented diagnostic",
      code: `const taxRate = 0.2; function applyDiscount(invoice) { "use hermetic"; return invoice.total * (1 - taxRate); }`,
      errors: [free("taxRate", "applyDiscount")],
    },
  ],
});

ruleTester.run("nested hermetic functions", sealed, {
  valid: [],
  invalid: [
    {
      name: "an escape through two marked functions is reported for the innermost",
      code: `const R = 1; function outer() { "use hermetic"; function inner() { "use hermetic"; return R; } return inner; }`,
      errors: [free("R", "inner")],
    },
    {
      name: "an inner hermetic function may not close over its outer function",
      code: `function outer() { "use hermetic"; const k = 1; function inner() { "use hermetic"; return k; } return inner; }`,
      errors: [free("k", "inner")],
    },
    {
      name: "lexical this through two marked arrows is reported once",
      code: `const f = () => { "use hermetic"; const g = () => { "use hermetic"; return this; }; return g; };`,
      errors: [escape("lexicalThis", "g")],
    },
  ],
});

ruleTester.run("syntactic escapes", sealed, {
  valid: [
    { name: "new.target in a class field", code: `const f = () => { "use hermetic"; return class { x = new.target; }; };` },
    {
      name: "this in a class field initializer of a class declared inside",
      code: `const f = () => { "use hermetic"; return class { x = this; }; };`,
    },
  ],
  invalid: [
    {
      name: "this in an arrow nested in a hermetic arrow",
      code: `const f = () => { "use hermetic"; return [1].map(() => this.k); };`,
      errors: [escape("lexicalThis")],
    },
    {
      name: "this in a hermetic class field arrow",
      code: `class C { f = () => { "use hermetic"; return this.x; }; }`,
      errors: [escape("lexicalThis")],
    },
    {
      name: "this in a computed key of a class declared inside a hermetic arrow",
      code: `const f = () => { "use hermetic"; return class { [this.k]() {} }; };`,
      errors: [escape("lexicalThis")],
    },
    {
      name: "new.target in a hermetic arrow",
      code: `function F() { const g = () => { "use hermetic"; return new.target; }; return g; }`,
      errors: [escape("lexicalNewTarget", "g")],
    },
    {
      name: "super in an arrow inside a hermetic method",
      code: `class A extends B { m() { "use hermetic"; return () => super.m(); } }`,
      errors: [escape("superReference", "m")],
    },
    {
      name: "super in a hermetic arrow inside a method",
      code: `class A extends B { m() { const g = () => { "use hermetic"; return super.m(); }; return g; } }`,
      errors: [escape("superReference", "g")],
    },
    {
      name: "super() in a hermetic constructor",
      code: `class A extends B { constructor() { "use hermetic"; super(); } }`,
      errors: [escape("superReference", "constructor")],
    },
    {
      name: "super in a hermetic object method",
      code: `const o = { m() { "use hermetic"; return super.toString(); } };`,
      errors: [escape("superReference", "m")],
    },
    {
      name: "import.meta in a nested function",
      code: `function f() { "use hermetic"; return () => import.meta.url; }`,
      errors: [escape("importMeta")],
    },
    {
      name: "dynamic import",
      code: `async function f() { "use hermetic"; return import("./x"); }`,
      errors: [escape("dynamicImport")],
    },
    {
      name: "JSX is reported once per tree",
      code: `function f() { "use hermetic"; return <div><span /></div>; }`,
      filename: "react.tsx",
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      errors: [escape("jsx")],
    },
    {
      name: "JSX component names are free variables too",
      code: `function f() { "use hermetic"; return <Other />; }`,
      filename: "react.tsx",
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      errors: [escape("jsx"), free("Other")],
    },
  ],
});

ruleTester.run("denied paths", sealed, {
  valid: [
    { name: "other members of a partly denied object", code: `function f(x) { "use hermetic"; return Math.floor(x) * Math.PI; }` },
    { name: "a computed literal key", code: `function f(x) { "use hermetic"; return Math["floor"](x); }` },
    { name: "destructuring allowed members", code: `function f(x) { "use hermetic"; const { max, floor } = Math; return max(floor(x), 0); }` },
    {
      name: "best-effort: an alias hides the path",
      code: `function f() { "use hermetic"; const m = Math; return m.random(); }`,
    },
    { name: "best-effort: a dynamic key hides the path", code: `function f(k) { "use hermetic"; return Math[k](); }` },
    { name: "best-effort: a rest element", code: `function f() { "use hermetic"; const { ...rest } = Math; return rest; }` },
  ],
  invalid: [
    { name: "string key", code: `function f() { "use hermetic"; return Math["random"](); }`, errors: [denied("Math.random")] },
    { name: "template key", code: "function f() { \"use hermetic\"; return Math[`random`](); }", errors: [denied("Math.random")] },
    { name: "optional chaining", code: `function f() { "use hermetic"; return Math?.random(); }`, errors: [denied("Math.random")] },
    {
      name: "type assertion and non-null wrappers",
      code: `function f() { "use hermetic"; return [(Math as any).random(), Math!.random(), (<any>Math).random()]; }`,
      errors: [denied("Math.random"), denied("Math.random"), denied("Math.random")],
    },
    {
      name: "a longer chain reports the denied prefix",
      code: `function f() { "use hermetic"; return Math.random.call(null); }`,
      errors: [{ ...denied("Math.random"), column: 39, endColumn: 50 }],
    },
    {
      name: "typeof still reads the member",
      code: `function f() { "use hermetic"; return typeof Math.random; }`,
      errors: [denied("Math.random")],
    },
    {
      name: "destructuring",
      code: `function f() { "use hermetic"; const { random } = Math; return random(); }`,
      errors: [denied("Math.random")],
    },
    {
      name: "destructuring with rename and default",
      code: `function f() { "use hermetic"; const { random: r = () => 0 } = Math; return r(); }`,
      errors: [denied("Math.random")],
    },
    {
      name: "destructuring assignment",
      code: `function f() { "use hermetic"; let random; ({ random } = Math); return random; }`,
      errors: [denied("Math.random")],
    },
    {
      name: "destructuring a parameter default",
      code: `function f({ random } = Math) { "use hermetic"; return random(); }`,
      errors: [denied("Math.random")],
    },
  ],
});

ruleTester.run("aliasing: forbid", sealed, {
  valid: [
    { name: "static member access", code: `function f(a, b) { "use hermetic"; return Math.max(a, b); }`, options: [{ aliasing: "forbid" }] },
    { name: "static destructuring", code: `function f(a) { "use hermetic"; const { abs } = Math; return abs(a); }`, options: [{ aliasing: "forbid" }] },
    { name: "typeof", code: `function f() { "use hermetic"; return typeof Math; }`, options: [{ aliasing: "forbid" }] },
    {
      name: "fully allowed ground objects may be aliased",
      code: `function f() { "use hermetic"; const j = JSON; return j; }`,
      options: [{ aliasing: "forbid" }],
    },
  ],
  invalid: [
    {
      name: "an alias",
      code: `function f() { "use hermetic"; const m = Math; return m.random(); }`,
      options: [{ aliasing: "forbid" }],
      errors: [aliased("Math")],
    },
    {
      name: "a dynamic key",
      code: `function f(k) { "use hermetic"; return Math[k](); }`,
      options: [{ aliasing: "forbid" }],
      errors: [aliased("Math")],
    },
    {
      name: "passing the object along",
      code: `function f(g) { "use hermetic"; return g(Math); }`,
      options: [{ aliasing: "forbid" }],
      errors: [aliased("Math")],
    },
    {
      name: "a rest element",
      code: `function f() { "use hermetic"; const { max, ...rest } = Math; return rest; }`,
      options: [{ aliasing: "forbid" }],
      errors: [aliased("Math")],
    },
    {
      name: "a computed destructuring key",
      code: `function f(k) { "use hermetic"; const { [k]: v } = Math; return v; }`,
      options: [{ aliasing: "forbid" }],
      errors: [aliased("Math")],
    },
  ],
});

ruleTester.run("types", sealed, {
  valid: [
    {
      name: "typeof in a type position is erased",
      code: `const RATE = 1; function f(a: typeof RATE): typeof RATE { "use hermetic"; return a; }`,
    },
    {
      name: "the spec's bootstrap signature",
      code: `export function ground(realm: typeof globalThis) { "use hermetic"; return { allow: { Math: realm.Math }, deny: ["Math.random"] }; }`,
    },
    {
      name: "a named this type",
      code: `interface Ctx { rate: number } function f(this: Ctx, x: number) { "use hermetic"; return x * this.rate; }`,
    },
    {
      name: "as, satisfies, and generic constraints",
      code: `function f<T extends Invoice>(a: unknown, t: T): T { "use hermetic"; return ((a as Invoice).total satisfies number) ? t : t; }`,
    },
    {
      name: "implements",
      code: `function f() { "use hermetic"; return class implements Shape { area() { return 0; } }; }`,
    },
    {
      name: "structural-only: lib types",
      code: `function f(xs: Array<number>, m: Map<string, Date>): Record<string, number> { "use hermetic"; return {}; }`,
      options: [{ types: "structural-only" }],
    },
    {
      name: "structural-only: structural this and argument types",
      code: `function f(this: { rate: number }, invoice: { total: number }) { "use hermetic"; return invoice.total * this.rate; }`,
      options: [{ types: "structural-only" }],
    },
    {
      name: "structural-only: own type parameters and local types",
      code: `function f<T>(x: T): T { "use hermetic"; interface Local { a: number } return (x as unknown as Local).a ? x : x; }`,
      options: [{ types: "structural-only" }],
    },
    {
      name: "structural-only: undeclared global types are ambient",
      code: `function f(b: Buffer) { "use hermetic"; return b; }`,
      options: [{ types: "structural-only" }],
    },
  ],
  invalid: [
    {
      name: "structural-only: a type import",
      code: `import type { Invoice } from "./invoice"; function f(i: Invoice) { "use hermetic"; return i.total; }`,
      options: [{ types: "structural-only" }],
      errors: [{ messageId: "typeReference", data: { name: "Invoice", fn: "f" } }],
    },
    {
      name: "structural-only: a module-level interface",
      code: `interface Ctx { rate: number } function f(this: Ctx) { "use hermetic"; return this.rate; }`,
      options: [{ types: "structural-only" }],
      errors: [{ messageId: "typeReference", data: { name: "Ctx", fn: "f" } }],
    },
    {
      name: "structural-only: typeof a module value",
      code: `const RATE = 1; function f(a: typeof RATE) { "use hermetic"; return a; }`,
      options: [{ types: "structural-only" }],
      errors: [{ messageId: "typeReference", data: { name: "RATE", fn: "f" } }],
    },
    {
      name: "structural-only: an enclosing class's type parameter",
      code: `class Box<T> { map(g: (x: T) => T) { "use hermetic"; return g; } }`,
      options: [{ types: "structural-only" }],
      errors: [
        { messageId: "typeReference", data: { name: "T", fn: "map" } },
        { messageId: "typeReference", data: { name: "T", fn: "map" } },
      ],
    },
  ],
});
