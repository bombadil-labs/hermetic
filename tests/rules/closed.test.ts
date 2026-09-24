import { RuleTester } from "@typescript-eslint/rule-tester";
import { closed, type MessageIds } from "../../src/rules/closed.ts";

const ruleTester = new RuleTester();

type ErrorSpec = { messageId: MessageIds; data?: Record<string, string>; line?: number; column?: number; endColumn?: number };

const free = (name: string, fn = "f"): ErrorSpec => ({ messageId: "freeVariable", data: { name, fn } });
const denied = (path: string, fn = "f"): ErrorSpec => ({ messageId: "deniedPath", data: { path, fn } });
const aliased = (path: string, fn = "f"): ErrorSpec => ({ messageId: "aliasedGround", data: { path, fn } });
const escape = (messageId: MessageIds, fn = "f"): ErrorSpec => ({ messageId, data: { fn } });

ruleTester.run("spec: valid cases", closed, {
  valid: [
    { name: "arguments only", code: `function f(a) { "use isolated"; return a.x + 1; }` },
    { name: "this in a declaration", code: `function f() { "use isolated"; return this.rate; }` },
    {
      name: "inner closure over locals",
      code: `function f(xs) { "use isolated"; const k = 2; return xs.map(x => x * k); }`,
    },
    { name: "ground name", code: `function f(a, b) { "use isolated"; return Math.max(a, b); }` },
    { name: "calling a passed callback", code: `function f(cb) { "use isolated"; return cb(1); }` },
    {
      name: "type-only import (default)",
      code: `import type { Invoice } from "./invoice"; function f(i: Invoice) { "use isolated"; return i.total; }`,
    },
  ],
  invalid: [
    {
      name: "module constant",
      code: `const RATE = 0.1; function f(a) { "use isolated"; return a * RATE; }`,
      errors: [free("RATE")],
    },
    {
      name: "imported function",
      code: `import { clamp } from "./clamp"; function f(a) { "use isolated"; return clamp(a); }`,
      errors: [free("clamp")],
    },
    {
      name: "imported function, even isolated",
      code: `function clamp(n) { "use isolated"; return n; } function f(a) { "use isolated"; return clamp(a); }`,
      errors: [free("clamp")],
    },
    {
      name: "this in isolated arrow",
      code: `const f = () => { "use isolated"; return this.x; }`,
      errors: [escape("lexicalThis")],
    },
    {
      name: "parameter default escapes",
      code: `function f(a = DEFAULT) { "use isolated"; return a; }`,
      errors: [free("DEFAULT")],
    },
    {
      name: "denied path",
      code: `function f() { "use isolated"; return Math.random(); }`,
      errors: [{ ...denied("Math.random"), line: 1, column: 39, endColumn: 50 }],
    },
    { name: "clock", code: `function f() { "use isolated"; return Date.now(); }`, errors: [free("Date")] },
    {
      name: "super",
      code: `class A extends B { method() { "use isolated"; return super.method(); } }`,
      errors: [escape("superReference", "method")],
    },
    {
      name: "import.meta",
      code: `function f() { "use isolated"; return import.meta.url; }`,
      errors: [escape("importMeta")],
    },
    { name: "typeof on a global", code: `function f() { "use isolated"; return typeof window; }`, errors: [free("window")] },
    { name: "eval", code: `function f(s) { "use isolated"; return eval(s); }`, errors: [free("eval")] },
  ],
});

ruleTester.run("marking", closed, {
  valid: [
    { name: "unmarked functions are not checked", code: `const R = 1; function f() { return R; }` },
    {
      name: "a directive after the prologue does not mark",
      code: `const R = 1; function f() { const x = R; "use isolated"; return x; }`,
    },
    {
      name: "a JSDoc tag mentioned mid-sentence does not mark",
      code: `const R = 1; /** Not @isolated, just a note. */ function f() { return R; }`,
    },
    { name: "a plain block comment does not mark", code: `const R = 1; /* @isolated */ function f() { return R; }` },
    { name: "a line comment does not mark", code: `const R = 1;\n// @isolated\nfunction f() { return R; }` },
    {
      name: "only the exact directive marks",
      code: `const R = 1; function f() { "use isolated strict"; return R; }`,
    },
  ],
  invalid: [
    {
      name: "directive after other directives",
      code: `const R = 1; function f() { "use strict"; "use isolated"; return R; }`,
      errors: [free("R")],
    },
    {
      name: "JSDoc on a function declaration",
      code: `const R = 1; /** @isolated */ function f() { return R; }`,
      errors: [free("R")],
    },
    {
      name: "JSDoc on an exported function",
      code: `const R = 1; /** @isolated */ export function f() { return R; }`,
      errors: [free("R")],
    },
    {
      name: "JSDoc on an expression-bodied arrow",
      code: `const R = 1; /** @isolated */ const f = () => R;`,
      errors: [free("R")],
    },
    {
      name: "JSDoc on an exported const",
      code: `const R = 1; /** @isolated */ export const f = function () { return R; };`,
      errors: [free("R")],
    },
    {
      name: "JSDoc tag among other tags",
      code: `const R = 1;\n/**\n * Adds R.\n * @param a a number\n * @isolated\n */\nfunction f(a) { return a + R; }`,
      errors: [free("R")],
    },
    {
      name: "JSDoc directly before a function expression argument",
      code: `const R = 1; run(/** @isolated */ function () { return R; });`,
      errors: [free("R", "<anonymous>")],
    },
    {
      name: "object method",
      code: `const R = 1; const o = { m() { "use isolated"; return R; } };`,
      errors: [free("R", "m")],
    },
    {
      name: "JSDoc on an object property",
      code: `const R = 1; const o = { /** @isolated */ m: () => R };`,
      errors: [free("R", "m")],
    },
    {
      name: "class method",
      code: `const R = 1; class C { m() { "use isolated"; return R; } }`,
      errors: [free("R", "m")],
    },
    {
      name: "JSDoc on a class field arrow",
      code: `const R = 1; class C { /** @isolated */ m = () => R; }`,
      errors: [free("R", "m")],
    },
    {
      name: "getter",
      code: `const R = 1; class C { get v() { "use isolated"; return R; } }`,
      errors: [free("R", "v")],
    },
    {
      name: "private method",
      code: `const R = 1; class C { #m() { "use isolated"; return R; } }`,
      errors: [free("R", "#m")],
    },
    {
      name: "anonymous default export",
      code: `const R = 1; export default function () { "use isolated"; return R; }`,
      errors: [free("R", "default")],
    },
    {
      name: "JSDoc on an assignment",
      code: `const R = 1; /** @isolated */ exports.f = function () { return R; };`,
      errors: [free("R")],
    },
    {
      name: "async function",
      code: `const R = 1; async function f() { "use isolated"; return await R; }`,
      errors: [free("R")],
    },
    { name: "generator", code: `const R = 1; function* f() { "use isolated"; yield R; }`, errors: [free("R")] },
  ],
});

ruleTester.run("closedness", closed, {
  valid: [
    { name: "own arguments", code: `function f() { "use isolated"; return arguments.length; }` },
    { name: "this in a nested arrow", code: `function f() { "use isolated"; return [1].map(() => this.k); }` },
    {
      name: "a nested function's own this",
      code: `const f = () => { "use isolated"; return function () { return this; }; };`,
    },
    { name: "this in an isolated method", code: `const o = { m() { "use isolated"; return this.x; } };` },
    { name: "own new.target", code: `function F() { "use isolated"; return new.target; }` },
    {
      name: "super within a class declared inside",
      code: `function f() { "use isolated"; class A { m() { return 1; } } class B extends A { m() { return super.m() + 1; } } return new B().m(); }`,
    },
    {
      name: "this in a static block of a class declared inside an isolated arrow",
      code: `const f = () => { "use isolated"; return class { static { this.y = 1; } }; };`,
    },
    {
      name: "named function expression recursion",
      code: `const fact = function self(n) { "use isolated"; return n <= 1 ? 1 : n * self(n - 1); };`,
    },
    {
      name: "function declaration recursion",
      code: `function fact(n) { "use isolated"; return n <= 1 ? 1 : n * fact(n - 1); }`,
    },
    {
      name: "overloaded declaration recursion",
      code: `function f(n: string): string; function f(n: number): number; function f(n: any): any { "use isolated"; return n ? f(n - 1) : n; }`,
    },
    { name: "locals shadow outer names", code: `const R = 1; function f() { "use isolated"; const R = 2; return R; }` },
    {
      name: "parameters, destructuring, defaults and catch",
      code: `function f({ a }, b = a) { "use isolated"; try { return b; } catch (e) { return e; } }`,
    },
    { name: "labels", code: `function f() { "use isolated"; outer: for (;;) { break outer; } }` },
    {
      name: "default ground names",
      code: `function f(s) { "use isolated"; const m = new Map([[1, new Set()]]); return [JSON.parse(s) ?? undefined ?? NaN, Promise.resolve(m), new TypeError("x"), Number.isFinite(Infinity)]; }`,
    },
    {
      // Known limit, documented in the README: closedness is not confinement.
      name: "reaching Function through a literal is member access, not a free variable",
      code: `function f() { "use isolated"; return [].constructor.constructor; }`,
    },
  ],
  invalid: [
    {
      name: "arguments inside an isolated arrow belongs to the enclosing function",
      code: `function outer() { return () => { "use isolated"; return arguments[0]; }; }`,
      errors: [free("arguments", "<anonymous>")],
    },
    {
      name: "a const arrow referring to itself",
      code: `const f = () => { "use isolated"; return f; };`,
      errors: [free("f")],
    },
    {
      name: "a reassigned function declaration referring to itself",
      code: `function f() { "use isolated"; return f; } f = null;`,
      errors: [free("f")],
    },
    {
      name: "a class referring to itself from a method",
      code: `class A { m() { "use isolated"; return new A(); } }`,
      errors: [free("A", "m")],
    },
    {
      name: "an escape from a nested closure is reported once",
      code: `const R = 1; function f(xs) { "use isolated"; return xs.map((x) => x * R); }`,
      errors: [free("R")],
    },
    {
      name: "implicit global assignment",
      code: `function f() { "use isolated"; leaked = 1; }`,
      errors: [free("leaked")],
    },
    {
      name: "a local binding that shadows a ground name",
      code: `const Math = { max: () => 0 }; function f(a, b) { "use isolated"; return Math.max(a, b); }`,
      errors: [{ messageId: "shadowedGround", data: { name: "Math", fn: "f" } }],
    },
    {
      name: "an import that shadows a ground name",
      code: `import { JSON } from "./json"; function f(s) { "use isolated"; return JSON.parse(s); }`,
      errors: [{ messageId: "shadowedGround", data: { name: "JSON", fn: "f" } }],
    },
    {
      name: "assigning to a ground name",
      code: `function f() { "use isolated"; Math = null; }`,
      errors: [{ messageId: "groundWrite", data: { name: "Math", fn: "f" } }],
    },
    {
      name: "ambient authority",
      code: `function f() { "use isolated"; console.log(globalThis, fetch, setTimeout, process, Function, Intl); }`,
      errors: ["console", "globalThis", "fetch", "setTimeout", "process", "Function", "Intl"].map((name) => free(name)),
    },
    {
      name: "a template tag",
      code: "const html = (s) => s; function f() { \"use isolated\"; return html`x`; }",
      errors: [free("html")],
    },
    {
      name: "a class extending an outer class",
      code: `function f() { "use isolated"; return class extends Base {}; }`,
      errors: [free("Base")],
    },
    {
      name: "an enum value (its type annotation is fine)",
      code: `enum Color { Red } function f(c: Color) { "use isolated"; return c === Color.Red; }`,
      errors: [free("Color")],
    },
    {
      name: "the spec's diagnostic, verbatim",
      code: `const taxRate = 0.2; function applyDiscount(invoice) { "use isolated"; return invoice.total * (1 - taxRate); }`,
      errors: [free("taxRate", "applyDiscount")],
    },
  ],
});

ruleTester.run("nested isolated functions", closed, {
  valid: [],
  invalid: [
    {
      name: "an escape through two marked functions is reported for the innermost",
      code: `const R = 1; function outer() { "use isolated"; function inner() { "use isolated"; return R; } return inner; }`,
      errors: [free("R", "inner")],
    },
    {
      name: "an inner isolated function may not close over its outer function",
      code: `function outer() { "use isolated"; const k = 1; function inner() { "use isolated"; return k; } return inner; }`,
      errors: [free("k", "inner")],
    },
    {
      name: "lexical this through two marked arrows is reported once",
      code: `const f = () => { "use isolated"; const g = () => { "use isolated"; return this; }; return g; };`,
      errors: [escape("lexicalThis", "g")],
    },
  ],
});

ruleTester.run("syntactic escapes", closed, {
  valid: [
    { name: "new.target in a class field", code: `const f = () => { "use isolated"; return class { x = new.target; }; };` },
    {
      name: "this in a class field initializer of a class declared inside",
      code: `const f = () => { "use isolated"; return class { x = this; }; };`,
    },
  ],
  invalid: [
    {
      name: "this in an arrow nested in an isolated arrow",
      code: `const f = () => { "use isolated"; return [1].map(() => this.k); };`,
      errors: [escape("lexicalThis")],
    },
    {
      name: "this in an isolated class field arrow",
      code: `class C { f = () => { "use isolated"; return this.x; }; }`,
      errors: [escape("lexicalThis")],
    },
    {
      name: "this in a computed key of a class declared inside an isolated arrow",
      code: `const f = () => { "use isolated"; return class { [this.k]() {} }; };`,
      errors: [escape("lexicalThis")],
    },
    {
      name: "new.target in an isolated arrow",
      code: `function F() { const g = () => { "use isolated"; return new.target; }; return g; }`,
      errors: [escape("lexicalNewTarget", "g")],
    },
    {
      name: "super in an arrow inside an isolated method",
      code: `class A extends B { m() { "use isolated"; return () => super.m(); } }`,
      errors: [escape("superReference", "m")],
    },
    {
      name: "super in an isolated arrow inside a method",
      code: `class A extends B { m() { const g = () => { "use isolated"; return super.m(); }; return g; } }`,
      errors: [escape("superReference", "g")],
    },
    {
      name: "super() in an isolated constructor",
      code: `class A extends B { constructor() { "use isolated"; super(); } }`,
      errors: [escape("superReference", "constructor")],
    },
    {
      name: "super in an isolated object method",
      code: `const o = { m() { "use isolated"; return super.toString(); } };`,
      errors: [escape("superReference", "m")],
    },
    {
      name: "import.meta in a nested function",
      code: `function f() { "use isolated"; return () => import.meta.url; }`,
      errors: [escape("importMeta")],
    },
    {
      name: "dynamic import",
      code: `async function f() { "use isolated"; return import("./x"); }`,
      errors: [escape("dynamicImport")],
    },
    {
      name: "JSX is reported once per tree",
      code: `function f() { "use isolated"; return <div><span /></div>; }`,
      filename: "react.tsx",
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      errors: [escape("jsx")],
    },
    {
      name: "JSX component names are free variables too",
      code: `function f() { "use isolated"; return <Other />; }`,
      filename: "react.tsx",
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      errors: [escape("jsx"), free("Other")],
    },
  ],
});

ruleTester.run("denied paths", closed, {
  valid: [
    { name: "other members of a partly denied object", code: `function f(x) { "use isolated"; return Math.floor(x) * Math.PI; }` },
    { name: "a computed literal key", code: `function f(x) { "use isolated"; return Math["floor"](x); }` },
    { name: "destructuring allowed members", code: `function f(x) { "use isolated"; const { max, floor } = Math; return max(floor(x), 0); }` },
    {
      name: "best-effort: an alias hides the path",
      code: `function f() { "use isolated"; const m = Math; return m.random(); }`,
    },
    { name: "best-effort: a dynamic key hides the path", code: `function f(k) { "use isolated"; return Math[k](); }` },
    { name: "best-effort: a rest element", code: `function f() { "use isolated"; const { ...rest } = Math; return rest; }` },
  ],
  invalid: [
    { name: "string key", code: `function f() { "use isolated"; return Math["random"](); }`, errors: [denied("Math.random")] },
    { name: "template key", code: "function f() { \"use isolated\"; return Math[`random`](); }", errors: [denied("Math.random")] },
    { name: "optional chaining", code: `function f() { "use isolated"; return Math?.random(); }`, errors: [denied("Math.random")] },
    {
      name: "type assertion and non-null wrappers",
      code: `function f() { "use isolated"; return [(Math as any).random(), Math!.random(), (<any>Math).random()]; }`,
      errors: [denied("Math.random"), denied("Math.random"), denied("Math.random")],
    },
    {
      name: "a longer chain reports the denied prefix",
      code: `function f() { "use isolated"; return Math.random.call(null); }`,
      errors: [{ ...denied("Math.random"), column: 39, endColumn: 50 }],
    },
    {
      name: "typeof still reads the member",
      code: `function f() { "use isolated"; return typeof Math.random; }`,
      errors: [denied("Math.random")],
    },
    {
      name: "destructuring",
      code: `function f() { "use isolated"; const { random } = Math; return random(); }`,
      errors: [denied("Math.random")],
    },
    {
      name: "destructuring with rename and default",
      code: `function f() { "use isolated"; const { random: r = () => 0 } = Math; return r(); }`,
      errors: [denied("Math.random")],
    },
    {
      name: "destructuring assignment",
      code: `function f() { "use isolated"; let random; ({ random } = Math); return random; }`,
      errors: [denied("Math.random")],
    },
    {
      name: "destructuring a parameter default",
      code: `function f({ random } = Math) { "use isolated"; return random(); }`,
      errors: [denied("Math.random")],
    },
  ],
});

ruleTester.run("aliasing: forbid", closed, {
  valid: [
    { name: "static member access", code: `function f(a, b) { "use isolated"; return Math.max(a, b); }`, options: [{ aliasing: "forbid" }] },
    { name: "static destructuring", code: `function f(a) { "use isolated"; const { abs } = Math; return abs(a); }`, options: [{ aliasing: "forbid" }] },
    { name: "typeof", code: `function f() { "use isolated"; return typeof Math; }`, options: [{ aliasing: "forbid" }] },
    {
      name: "fully allowed ground objects may be aliased",
      code: `function f() { "use isolated"; const j = JSON; return j; }`,
      options: [{ aliasing: "forbid" }],
    },
  ],
  invalid: [
    {
      name: "an alias",
      code: `function f() { "use isolated"; const m = Math; return m.random(); }`,
      options: [{ aliasing: "forbid" }],
      errors: [aliased("Math")],
    },
    {
      name: "a dynamic key",
      code: `function f(k) { "use isolated"; return Math[k](); }`,
      options: [{ aliasing: "forbid" }],
      errors: [aliased("Math")],
    },
    {
      name: "passing the object along",
      code: `function f(g) { "use isolated"; return g(Math); }`,
      options: [{ aliasing: "forbid" }],
      errors: [aliased("Math")],
    },
    {
      name: "a rest element",
      code: `function f() { "use isolated"; const { max, ...rest } = Math; return rest; }`,
      options: [{ aliasing: "forbid" }],
      errors: [aliased("Math")],
    },
    {
      name: "a computed destructuring key",
      code: `function f(k) { "use isolated"; const { [k]: v } = Math; return v; }`,
      options: [{ aliasing: "forbid" }],
      errors: [aliased("Math")],
    },
  ],
});

ruleTester.run("types", closed, {
  valid: [
    {
      name: "typeof in a type position is erased",
      code: `const RATE = 1; function f(a: typeof RATE): typeof RATE { "use isolated"; return a; }`,
    },
    {
      name: "the spec's bootstrap signature",
      code: `export function ground(realm: typeof globalThis) { "use isolated"; return { allow: { Math: realm.Math }, deny: ["Math.random"] }; }`,
    },
    {
      name: "a named this type",
      code: `interface Ctx { rate: number } function f(this: Ctx, x: number) { "use isolated"; return x * this.rate; }`,
    },
    {
      name: "as, satisfies, and generic constraints",
      code: `function f<T extends Invoice>(a: unknown, t: T): T { "use isolated"; return ((a as Invoice).total satisfies number) ? t : t; }`,
    },
    {
      name: "implements",
      code: `function f() { "use isolated"; return class implements Shape { area() { return 0; } }; }`,
    },
    {
      name: "structural-only: lib types",
      code: `function f(xs: Array<number>, m: Map<string, Date>): Record<string, number> { "use isolated"; return {}; }`,
      options: [{ types: "structural-only" }],
    },
    {
      name: "structural-only: structural this and argument types",
      code: `function f(this: { rate: number }, invoice: { total: number }) { "use isolated"; return invoice.total * this.rate; }`,
      options: [{ types: "structural-only" }],
    },
    {
      name: "structural-only: own type parameters and local types",
      code: `function f<T>(x: T): T { "use isolated"; interface Local { a: number } return (x as unknown as Local).a ? x : x; }`,
      options: [{ types: "structural-only" }],
    },
    {
      name: "structural-only: undeclared global types are ambient",
      code: `function f(b: Buffer) { "use isolated"; return b; }`,
      options: [{ types: "structural-only" }],
    },
  ],
  invalid: [
    {
      name: "structural-only: a type import",
      code: `import type { Invoice } from "./invoice"; function f(i: Invoice) { "use isolated"; return i.total; }`,
      options: [{ types: "structural-only" }],
      errors: [{ messageId: "typeReference", data: { name: "Invoice", fn: "f" } }],
    },
    {
      name: "structural-only: a module-level interface",
      code: `interface Ctx { rate: number } function f(this: Ctx) { "use isolated"; return this.rate; }`,
      options: [{ types: "structural-only" }],
      errors: [{ messageId: "typeReference", data: { name: "Ctx", fn: "f" } }],
    },
    {
      name: "structural-only: typeof a module value",
      code: `const RATE = 1; function f(a: typeof RATE) { "use isolated"; return a; }`,
      options: [{ types: "structural-only" }],
      errors: [{ messageId: "typeReference", data: { name: "RATE", fn: "f" } }],
    },
    {
      name: "structural-only: an enclosing class's type parameter",
      code: `class Box<T> { map(g: (x: T) => T) { "use isolated"; return g; } }`,
      options: [{ types: "structural-only" }],
      errors: [
        { messageId: "typeReference", data: { name: "T", fn: "map" } },
        { messageId: "typeReference", data: { name: "T", fn: "map" } },
      ],
    },
  ],
});
