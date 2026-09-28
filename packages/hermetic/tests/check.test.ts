import { parse } from "acorn";
import { describe, expect, it } from "vitest";
import { check, type CheckContext, checkHermetic, IMMUTABLE_GLOBALS } from "../src/index.ts";

/** Each problem as `kind:name`, in source order. */
function problems(source: string): string[] {
  return check(source).problems.map((problem) => `${problem.kind}:${problem.name}`);
}

describe("check: forms", () => {
  it.each([
    ["an arrow function", "(a, b) => a + b"],
    ["an async arrow function", "async (a) => await a"],
    ["a function expression", "function (a) { return a }"],
    ["a function declaration's source", "function add(a, b) { return a + b }"],
    ["a generator", "function* (a) { yield a }"],
    ["an async generator", "async function* (a) { yield await a }"],
  ])("reads %s as a function", (_label, source) => {
    expect(check(source)).toEqual({ form: "function", marked: false, hermetic: true, problems: [], needs: [] });
  });

  it.each([
    ["a method", "total(items) { return items.length }", []],
    ["a getter", "get size() { return this.items.length }", ["items"]],
    ["a setter", "set size(value) { this.items.length = value }", ["items"]],
    ["an async generator method", "async *pages(n) { yield n }", []],
    ["a method with a computed key, which runs outside it", "[this.key]() { return this.value }", ["value"]],
    ["an object literal's method named constructor", "constructor() { return this.value }", ["value"]],
  ])("reads %s as a method, whose this is its object", (_label, source, needs) => {
    expect(check(source)).toEqual({ form: "method", marked: false, hermetic: true, problems: [], needs });
  });

  it("reads a class whole", () => {
    expect(check("class Shape { area() { return 0 } }")).toEqual({
      form: "class",
      marked: false,
      hermetic: true,
      problems: [],
      needs: undefined,
    });
  });

  it("takes a function, method or class value, through Function.prototype.toString", () => {
    const shape = {
      area(width: number, height: number) {
        return width * height;
      },
    };
    class Rect {
      width = 1;
      height = 1;
      area() {
        return this.width * this.height;
      }
      static unit() {
        return new this();
      }
    }
    expect(check((a: number) => a * 2)).toMatchObject({ form: "function", hermetic: true });
    expect(check(shape.area)).toMatchObject({ form: "method", hermetic: true });
    expect(check(Rect.prototype.area)).toMatchObject({ form: "method", hermetic: true, needs: ["width", "height"] });
    expect(check(Rect.unit)).toMatchObject({ form: "method", hermetic: true });
    expect(check(Rect)).toMatchObject({ form: "class", hermetic: true });
  });

  it.each([
    ["a number", "42"],
    ["two functions in a sequence", "x => x), (y => y"],
    ["a function and a statement", "x => x); globalThis.leak = 1; (0"],
    ["two methods", "a() {} b() {}"],
    ["a class field", "count = 0"],
    ["a static block", "static { }"],
    ["a method escaping its class", "m() {} }); globalThis.leak = 1; (class {"],
  ])("refuses %s", (_label, source) => {
    expect(check(source)).toEqual({
      form: undefined,
      marked: false,
      hermetic: false,
      problems: [{ kind: "notAFunction", name: expect.any(String), start: 0, end: source.length }],
    });
  });

  it("reports a syntax error where parsing stopped", () => {
    const source = "function (a { return a }";
    const result = check(source);
    expect(result).toMatchObject({ form: undefined, hermetic: false });
    expect(result.problems).toEqual([{ kind: "syntax", name: "Unexpected token", start: 12, end: 12 }]);
  });

  it("reports a native function as a syntax error, since its source isn't available", () => {
    expect(problems(Function.prototype.toString.call(Math.max))).toEqual(["syntax:Unexpected token"]);
  });

  it("closes each wrapper on a new line, so a trailing line comment can't swallow it", () => {
    expect(check("x => x // done")).toMatchObject({ form: "function", hermetic: true });
    expect(check("m() { return 1 } // done")).toMatchObject({ form: "method" });
  });

  it("falls back to script code for sloppy-mode functions", () => {
    expect(check("function (yield) { return yield }")).toMatchObject({ form: "function", hermetic: true });
    expect(check("function () { return 010 }")).toMatchObject({ form: "function", hermetic: true });
  });
});

describe("check: marking", () => {
  it("finds the directive at the head of the body", () => {
    expect(check('function (a) { "use hermetic"; return a }').marked).toBe(true);
    expect(check("(a) => { 'use hermetic'; return a }").marked).toBe(true);
  });

  it("finds it among other directives", () => {
    expect(check('function () { "use strict"; "use hermetic"; }').marked).toBe(true);
  });

  it("ignores it after the first statement, and in expression bodies", () => {
    expect(check('function () { let a; "use hermetic"; }').marked).toBe(false);
    expect(check('() => "use hermetic"').marked).toBe(false);
  });

  it("reports hermeticity whether or not the function is marked", () => {
    expect(check('function () { "use hermetic"; return y }')).toMatchObject({ marked: true, hermetic: false });
    expect(check("function () { return 1 }")).toMatchObject({ marked: false, hermetic: true });
  });

  it("finds it in a method", () => {
    expect(check('m() { "use hermetic"; return 1 }')).toMatchObject({ marked: true, hermetic: true });
  });

  it("finds it in a class's constructor", () => {
    expect(check('class { constructor() { "use hermetic"; } }')).toMatchObject({ form: "class", marked: true });
    expect(check('class { m() { "use hermetic"; } }')).toMatchObject({ form: "class", marked: false });
  });
});

describe("check: names", () => {
  it("reports every name from outside the function, globals included", () => {
    expect(problems("(a) => a + b + Math.max(c, JSON.stringify(d))")).toEqual([
      "freeVariable:b",
      "freeVariable:Math",
      "freeVariable:c",
      "freeVariable:JSON",
      "freeVariable:d",
    ]);
  });

  it("reads undefined, NaN and Infinity as if they were keywords", () => {
    expect(problems("(a) => [undefined, NaN, Infinity, typeof undefined, a === undefined]")).toEqual([]);
    expect([...IMMUTABLE_GLOBALS]).toEqual(["undefined", "NaN", "Infinity"]);
  });

  it("reads what comes in through this and the arguments", () => {
    expect(problems("function (n) { return this.Math.max(n, this.limit) }")).toEqual([]);
    expect(problems("({ Math }, n) => Math.round(n)")).toEqual([]);
  });

  it("reports writes to globals like reads", () => {
    expect(problems("() => { Math = 1; [JSON] = []; for (Object of []) ; }")).toEqual([
      "freeVariable:Math",
      "freeVariable:JSON",
      "freeVariable:Object",
    ]);
  });

  it.each([
    ["destructured and rest parameters", "({ a, b: [c] }, ...rest) => a + c + rest.length"],
    ["a default reading an earlier parameter", "(a, b = a) => b"],
    ["a hoisted var", "function () { x = 1; var x; return x }"],
    ["a hoisted function declaration", "() => { return f(); function f() { return 1 } }"],
    ["a named function expression's own name", "function fact(n) { return n ? n * fact(n - 1) : 1 }"],
    ["arguments in a function", "function () { return arguments.length }"],
    ["a class and its name inside itself", "() => { class A { static make() { return new A() } } return A }"],
    ["catch parameters", "() => { try { return 1 } catch ({ message }) { return message } }"],
    ["loop bindings", "(xs) => { for (const [k, v] of xs) k + v; for (let i = 0; i < 1; i++) i; for (var j in xs) j; return j }"],
    ["switch case bindings", "(n) => { switch (n) { case 1: let m = n; return m } }"],
    ["labels", "() => { outer: for (;;) { break outer } }"],
    ["object keys and member names", "(o) => ({ key: o.prop, [o.dynamic]: 1 }).key"],
    ["a var inside a static block", "() => class { static { var hidden = 1; hidden } }"],
    ["locals named like globals", "() => { let Math = 1; Math++; return Math }"],
    ["a parameter named undefined", "(undefined) => undefined"],
  ])("resolves %s", (_label, source) => {
    expect(problems(source)).toEqual([]);
  });

  it("keeps a default parameter from seeing the body's declarations", () => {
    expect(problems("function (a = b) { var b = 1; return a }")).toEqual(["freeVariable:b"]);
  });

  it("keeps block-scoped names inside their block", () => {
    expect(problems("() => { { let x = 1; } return x }")).toEqual(["freeVariable:x"]);
    expect(problems("() => { { function f() {} } return f }")).toEqual(["freeVariable:f"]);
  });

  it("reports arguments in an arrow function, which comes from the enclosing function", () => {
    expect(problems("() => arguments.length")).toEqual(["freeVariable:arguments"]);
  });

  it("reports names under typeof, shorthand properties and spreads", () => {
    expect(problems("() => [typeof a, { b }, ...c]")).toEqual(["freeVariable:a", "freeVariable:b", "freeVariable:c"]);
  });
});

describe("check: this, super and the module", () => {
  it("reports this and new.target in an arrow function", () => {
    expect(problems("() => [this, new.target]")).toEqual(["lexicalThis:this", "lexicalNewTarget:new.target"]);
  });

  it("allows this and new.target in a function, where they are inputs", () => {
    expect(problems("function () { return [this, new.target, () => this] }")).toEqual([]);
  });

  it("allows this where a nested function or class binds it", () => {
    expect(problems("() => [function () { return this }, class { x = this; static { this } }]")).toEqual([]);
  });

  it("reports this in a class's computed keys and heritage, which run outside it", () => {
    expect(problems("() => class extends this.Base { [this.key]() {} }")).toEqual([
      "lexicalThis:this",
      "lexicalThis:this",
    ]);
  });

  it("reports super in an arrow function taken from a method", () => {
    expect(check("() => super.m()")).toMatchObject({ form: "function", problems: [{ kind: "superReference" }] });
  });

  it("reads a function using super as a method named function, the only way it parses", () => {
    expect(check("function () { return super.m() }")).toMatchObject({
      form: "method",
      problems: [{ kind: "superReference", name: "super" }],
    });
  });

  it("allows super in a class or object defined inside the function", () => {
    expect(problems("(Base) => [{ m() { return super.m } }, class extends Base { n() { return super.n } }]")).toEqual(
      [],
    );
  });

  it("reports import.meta and import()", () => {
    expect(problems('async () => [import.meta.url, await import("node:fs")]')).toEqual([
      "importMeta:import.meta",
      "dynamicImport:import()",
    ]);
  });

  it("reports with statements", () => {
    expect(problems("function (o) { var random; with (o) { return random() } }")).toEqual(["withStatement:with"]);
  });
});

describe("check: needs", () => {
  const needs = (source: string) => check(source).needs;

  it("lists the names a function reads from this, in the order it first reads them", () => {
    expect(needs("function (a) { return this.round(this.rate * a) + this.round(a) }")).toEqual(["round", "rate"]);
  });

  it("lists names taken by destructuring this", () => {
    expect(needs('function () { const { clamp, "rate": r } = this; return clamp(r) }')).toEqual(["clamp", "rate"]);
    expect(needs("function () { let clock; ({ clock } = this); return clock.now() }")).toEqual(["clock"]);
  });

  it("counts writes, updates and deletes, which touch a name too", () => {
    expect(needs("function () { this.count++; this.total = 0; delete this.cache }")).toEqual(["count", "total", "cache"]);
  });

  it("follows this into arrow functions, class heritage and computed keys, which share it", () => {
    expect(needs("function (xs) { return xs.map((x) => this.scale * x) }")).toEqual(["scale"]);
    expect(needs("function () { return class extends this.Base { [this.key]() {} } }")).toEqual(["Base", "key"]);
  });

  it("leaves out this where a nested function, method, field or static block binds its own", () => {
    const source = "function () { return [function () { return this.a }, { m() { return this.b } }, class { c = this.c; static { this.d } }] }";
    expect(needs(source)).toEqual([]);
  });

  it.each([
    ["a computed name", "function (key) { return this[key] }"],
    ["this passed along", "function (helper) { return helper(this) }"],
    ["this kept in a variable", "function () { const self = this; return self.a }"],
    ["a rest element", "function () { const { a, ...rest } = this; return rest }"],
    ["a computed key in a pattern", "function (k) { const { [k]: v } = this; return v }"],
    ["this spread", "function () { return { ...this } }"],
    ["this under typeof", "function () { return typeof this }"],
  ])("can't list what a function reads through %s", (_label, source) => {
    expect(needs(source)).toBeUndefined();
  });

  it("lists nothing for an arrow function, whose this isn't one of its inputs", () => {
    expect(check("() => this.a")).toMatchObject({ hermetic: false, needs: [] });
    expect(needs("(a) => a.b")).toEqual([]);
  });

  it("lists what a method needs, and gives no list for a class or source that isn't a function", () => {
    expect(needs("area() { return this.w * this.h }")).toEqual(["w", "h"]);
    expect(needs("class { m() { return this.a } }")).toBeUndefined();
    expect(needs("function (a {")).toBeUndefined();
  });

  it("lists the names whether or not the function is hermetic", () => {
    expect(check("function () { return this.a + b }")).toMatchObject({ hermetic: false, needs: ["a"] });
    expect(check('function (key) { "use hermetic"; return this[key] }')).toMatchObject({ hermetic: true, needs: undefined });
  });
});

describe("check: offsets", () => {
  it.each([
    ["an arrow function", "(a) => a + missing"],
    ["a function", "function (a) { return a + missing }"],
    ["a nested function", "(a) => [1].map(function () { return missing })"],
  ])("point into the source of %s", (_label, source) => {
    const [problem] = check(source).problems;
    expect(problem && source.slice(problem.start, problem.end)).toBe("missing");
  });
});

describe("checkHermetic", () => {
  const context: CheckContext = {
    parse: (source, sourceType) => parse(source, { ecmaVersion: "latest", sourceType, checkPrivateFields: false }),
  };

  it("is itself marked and hermetic: it reads no globals either", () => {
    expect(check(checkHermetic)).toEqual({ form: "function", marked: true, hermetic: true, problems: [], needs: ["parse"] });
  });

  it("works when evaluated from its source alone and bound to a parser", () => {
    const relocated = new Function(`return ${Function.prototype.toString.call(checkHermetic)}`)() as typeof checkHermetic;
    const sources = ["() => Math.max(1) + y", "m() { return super.m(this) }", "x => x), (y => y", "function (a { }"];
    for (const source of sources) expect(relocated.call(context, source)).toEqual(check(source));
  });

  it("uses whatever parser it is given", () => {
    const seen: string[] = [];
    const tracing: CheckContext = {
      parse: (source, sourceType) => {
        seen.push(sourceType);
        return context.parse(source, sourceType);
      },
    };
    expect(checkHermetic.call(tracing, "function (o) { with (o) {} }")).toMatchObject({ hermetic: false });
    expect(seen).toEqual(["module", "module", "module", "script"]);
  });
});

describe("check: methods", () => {
  it("lists what a method reads from its object, siblings included", () => {
    expect(check("perimeter() { return 2 * (this.width + this.height) + this.area() * 0 }").needs).toEqual(["width", "height", "area"]);
  });

  it("reports super, whose class is outside the method", () => {
    expect(problems("toString() { return 'Rect:' + super.toString() }")).toEqual(["superReference:super"]);
  });

  it("reports the private names of the class around it, where they are used", () => {
    const source = "get count() { return this.#n + (#m in this ? 1 : 0) }";
    expect(check(source).problems).toEqual([
      { kind: "privateName", name: "#n", start: 26, end: 28 },
      { kind: "privateName", name: "#m", start: 32, end: 34 },
    ]);
  });

  it("allows private names that a class inside the method declares", () => {
    expect(problems("make() { return class { #x = 1; get x() { return this.#x } static has(o) { return #x in o } } }")).toEqual([]);
  });

  it("reports its class's own name, which is outside it", () => {
    expect(problems("static unit() { return new Rect(1, 1) }")).toEqual(["freeVariable:Rect"]);
  });
});

describe("check: classes", () => {
  it("allows the private names and the name the class declares", () => {
    const source = "class Counter { #n = 0; constructor(start) { this.#n = start } next() { return ++this.#n } static is(o) { return #n in o } static zero() { return new Counter(0) } }";
    expect(check(source)).toMatchObject({ form: "class", hermetic: true, problems: [] });
  });

  it("reports what any member reads from outside the class", () => {
    expect(problems("class Cache extends Base { items = new Map(); static { register(this) } get size() { return LIMIT } }")).toEqual([
      "freeVariable:Base",
      "freeVariable:Map",
      "freeVariable:register",
      "freeVariable:LIMIT",
    ]);
  });

  it("reports this in its computed keys, which run outside it", () => {
    expect(problems("class { [this.key]() { return this } }")).toEqual(["lexicalThis:this"]);
  });

  it("allows super in its own members", () => {
    expect(problems("class { toString() { return super.toString() } }")).toEqual([]);
  });

  it("reports private names from a class around it, even in its heritage", () => {
    expect(problems("class extends (class { static has(o) { return #x in o } }) { #x = 1 }")).toEqual(["privateName:#x"]);
  });
});
