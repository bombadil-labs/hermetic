import { parse } from "acorn";
import { describe, expect, it } from "vitest";
import { check, type CheckContext, checkHermetic, createGround, DEFAULT_GROUND, type GroundConfig } from "../src/index.ts";

/** Each problem as `kind:name`, in source order. */
function problems(source: string, ground?: GroundConfig): string[] {
  return check(source, ground).problems.map((problem) => `${problem.kind}:${problem.name}`);
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
    expect(check(source)).toEqual({ form: "function", marked: false, hermetic: true, problems: [] });
  });

  it.each([
    ["a method", "total(items) { return items.length }"],
    ["a getter", "get size() { return this.items.length }"],
    ["a setter", "set size(value) { this.items.length = value }"],
    ["an async generator method", "async *pages(n) { yield n }"],
    ["a method with a computed key", "[Symbol.iterator]() { return this }"],
    ["a private method", "#total() { return this.#items.length }"],
    ["an object literal's method named constructor", "constructor() { return this }"],
  ])("reads %s as a method", (_label, source) => {
    expect(check(source)).toEqual({ form: "method", marked: false, hermetic: true, problems: [] });
  });

  it("takes a function value, through Function.prototype.toString", () => {
    const shape = {
      area(width: number, height: number) {
        return width * height;
      },
    };
    expect(check((a: number) => a * 2)).toMatchObject({ form: "function", hermetic: true });
    expect(check(shape.area)).toMatchObject({ form: "method", hermetic: true });
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

  it.each([
    ["an empty class", "class Shape {}"],
    ["an anonymous class", "class { area() { return 0 } }"],
    ["a class extending an allowed global", "class NotFound extends Error { constructor(m) { super(m) } }"],
  ])("reads %s as a class", (_label, source) => {
    expect(check(source)).toEqual({ form: "class", marked: false, hermetic: true, problems: [] });
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
    expect(check("m() { return 1 } // done")).toMatchObject({ form: "method", hermetic: true });
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
    expect(check('m() { "use hermetic"; return 1 }').marked).toBe(true);
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
});

describe("check: names", () => {
  it("reports free variables and nothing else", () => {
    expect(problems("(a) => a + b + Math.max(c, JSON.stringify(d))")).toEqual([
      "freeVariable:b",
      "freeVariable:c",
      "freeVariable:d",
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
    expect(problems("() => [typeof a, { b }, ...c]")).toEqual([
      "freeVariable:a",
      "freeVariable:b",
      "freeVariable:c",
    ]);
  });

  it("reports a method's own name, which methods don't bind", () => {
    expect(problems("walk(n) { return n && walk(n - 1) }")).toEqual(["freeVariable:walk"]);
  });

  it("reports assignments to allowed globals", () => {
    expect(problems("() => { Math = 1; undefined++; [JSON] = []; for (Object of []) ; }")).toEqual([
      "groundWrite:Math",
      "groundWrite:undefined",
      "groundWrite:JSON",
      "groundWrite:Object",
    ]);
  });

  it("allows writes to locals that shadow allowed globals", () => {
    expect(problems("() => { let Math = 1; Math++; return Math }")).toEqual([]);
  });
});

describe("check: denied members", () => {
  it.each([
    ["a call", "() => Math.random()"],
    ["a string key", '() => Math["random"]()'],
    ["a template key", "() => Math[`random`]()"],
    ["an optional chain", "() => Math?.random()"],
    ["a destructuring declaration", "() => { const { random } = Math; return random() }"],
    ["a destructuring default parameter", "({ random } = Math) => random()"],
    ["a destructuring assignment", "() => { let random; ({ random } = Math); return random() }"],
  ])("reports Math.random through %s", (_label, source) => {
    expect(problems(source)).toEqual(["deniedPath:Math.random"]);
  });

  it("reports a read once, at the denied member", () => {
    const source = "() => Math.random.call(null) + Math.random.name";
    expect(check(source).problems.map((problem) => source.slice(problem.start, problem.end))).toEqual([
      "Math.random",
      "Math.random",
    ]);
    expect(problems("() => { const { random: { name } } = Math; return name }")).toEqual(["deniedPath:Math.random"]);
  });

  it("follows member paths into destructuring", () => {
    const ground = { allow: { Date }, deny: ["Date.prototype.getTime"] };
    expect(problems("() => { const { getTime } = Date.prototype; return getTime }", ground)).toEqual([
      "deniedPath:Date.prototype.getTime",
    ]);
    expect(problems("() => { const { prototype: { getTime } } = Date; return getTime }", ground)).toEqual([
      "deniedPath:Date.prototype.getTime",
    ]);
  });

  it("leaves other members and locals named like a global alone", () => {
    expect(problems("() => Math.max(Math.PI, Math.floor(1.5))")).toEqual([]);
    expect(problems("(Math) => Math.random()")).toEqual([]);
  });

  it("does not follow dynamic keys or aliases", () => {
    expect(problems('(key) => Math[key]() + Math["ran" + "dom"]()')).toEqual([]);
    expect(problems("() => { const m = Math; return m.random() }")).toEqual([]);
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

  it("reports super in a method, whose home object lies outside it", () => {
    expect(problems("m() { return super.m() }")).toEqual(["superReference:super"]);
    expect(problems("m() { return () => super.m() }")).toEqual(["superReference:super"]);
  });

  it("reads a function using super as a method named function, the only way it parses", () => {
    expect(check("function () { return super.m() }")).toMatchObject({
      form: "method",
      problems: [{ kind: "superReference" }],
    });
  });

  it("reports super in an arrow function taken from a method", () => {
    expect(check("() => super.m()")).toMatchObject({ form: "function", problems: [{ kind: "superReference" }] });
  });

  it("allows super in a class or object defined inside the function", () => {
    expect(problems("() => [{ m() { return super.m } }, class extends Array { n() { return super.n } }]")).toEqual(
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

describe("check: classes", () => {
  it("marks a class by its constructor's directive", () => {
    expect(check('class { constructor(x) { "use hermetic"; this.x = x } }').marked).toBe(true);
    expect(check('class { m() { "use hermetic" } }').marked).toBe(false);
  });

  it("checks every part of the class", () => {
    const source = `class Counter extends Base {
      static zero = start;
      [key] = 0;
      static { log(this) }
      count() { return helper(this) }
    }`;
    expect(problems(source)).toEqual([
      "freeVariable:Base",
      "freeVariable:start",
      "freeVariable:key",
      "freeVariable:log",
      "freeVariable:helper",
    ]);
  });

  it("binds the class's own name, private names and super inside it", () => {
    const source = `class Stack extends Array {
      #size = 0;
      static of(...items) { return new Stack().push(...items) }
      push(...items) { this.#size += items.length; return super.push(...items) }
      get size() { return this.#size }
    }`;
    expect(problems(source)).toEqual([]);
  });

  it("reports this in computed keys, which run outside the class", () => {
    expect(problems("class { [this.key]() {} }")).toEqual(["lexicalThis:this"]);
  });

  it("takes a class value", () => {
    class Point {
      x = 0;
      y = 0;
      norm() {
        return Math.hypot(this.x, this.y);
      }
    }
    expect(check(Point)).toMatchObject({ form: "class", hermetic: true });
  });
});

describe("check: grounds", () => {
  it("uses the allowed names of a bootstrap's result", () => {
    const ground = { allow: { Date, Temporal: {} }, deny: ["Date.now"] };
    expect(problems("() => [new Date(0), Temporal, Date.now()]", ground)).toEqual(["deniedPath:Date.now"]);
    expect(problems("() => Math.max(1, 2)", ground)).toEqual(["freeVariable:Math"]);
  });

  it("drops a name denied whole", () => {
    expect(problems("() => JSON", { allow: { JSON }, deny: ["JSON"] })).toEqual(["freeVariable:JSON"]);
  });

  it("rejects a malformed deny path", () => {
    expect(() => check("() => 1", { allow: {}, deny: ["Math. random"] })).toThrow(TypeError);
  });
});

describe("check: offsets", () => {
  it.each([
    ["a function", "(a) => a + missing"],
    ["a method", "m() { return missing }"],
    ["a constructor-named method", "constructor() { return missing }"],
  ])("point into the source of %s", (_label, source) => {
    const [problem] = check(source).problems;
    expect(problem && source.slice(problem.start, problem.end)).toBe("missing");
  });
});

describe("checkHermetic", () => {
  const context: CheckContext = {
    parse: (source, sourceType) => parse(source, { ecmaVersion: "latest", sourceType, checkPrivateFields: false }),
    ground: DEFAULT_GROUND,
  };

  it("is itself marked and hermetic", () => {
    expect(check(checkHermetic)).toEqual({ form: "function", marked: true, hermetic: true, problems: [] });
  });

  it("works when evaluated from its source alone and bound to a parser", () => {
    const relocated = new Function(`return ${Function.prototype.toString.call(checkHermetic)}`)() as typeof checkHermetic;
    const sources = ["() => Math.random() + y", "m() { return super.m(this) }", "x => x), (y => y"];
    for (const source of sources) expect(relocated.call(context, source)).toEqual(check(source));
  });

  it("uses whatever parser it is given", () => {
    const seen: string[] = [];
    const tracing: CheckContext = {
      parse: (source, sourceType) => {
        seen.push(sourceType);
        return context.parse(source, sourceType);
      },
      ground: createGround(["Math"]),
    };
    expect(checkHermetic.call(tracing, "function () { with (Math) {} }")).toMatchObject({ hermetic: false });
    expect(seen).toEqual(["module", "module", "module", "script"]);
  });
});
