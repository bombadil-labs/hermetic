// lockdown() freezes the built-ins of the whole process, and can't be undone.
// Vitest runs each test file in a process of its own, so only this file runs
// under Hardened JS.
import "ses";
import { parse } from "acorn";
import { beforeAll, describe, expect, it } from "vitest";
import { type CheckEnvironment, checkHermetic, confine, HermeticError, intrinsics } from "../src/index.ts";

function thrown(run: () => unknown): HermeticError {
  try {
    run();
  } catch (error) {
    if (error instanceof HermeticError) return error;
    throw error;
  }
  throw new Error("Expected a HermeticError.");
}

it("refuses to run before lockdown()", () => {
  expect(() => confine((a: number) => a)).toThrow(
    "confine needs Hardened JS: install ses, import it, and call lockdown() before confining a function.",
  );
});

describe("after lockdown()", () => {
  beforeAll(() => {
    lockdown();
  });

  it("returns a working function, hardened", () => {
    const add = confine((a: number, b: number) => a + b);
    expect(add(2, 3)).toBe(5);
    expect(Object.isFrozen(add)).toBe(true);
  });

  it("confines source text, with this as an input", () => {
    const area = confine<(this: { w: number; h: number }) => number>(
      'function () { "use hermetic"; return this.w * this.h }',
    );
    expect(area.call({ w: 2, h: 3 })).toBe(6);
  });

  it("gets the built-ins it needs through this, from intrinsics", () => {
    const round = confine<(this: { Math: Omit<Math, "random"> }, n: number) => number>(
      'function (n) { "use hermetic"; return this.Math.round(n) }',
    );
    expect(round.call(harden(intrinsics(globalThis)), 2.6)).toBe(3);
  });

  it("doesn't reach the compartment's global object through this", () => {
    expect(confine(function (this: unknown) {
      return this;
    })()).toBeUndefined();
  });

  it("confines the checker itself, which gets nothing but the parser it is handed", () => {
    const confined = confine(checkHermetic);
    const env: CheckEnvironment = {
      parse: (source, sourceType) => parse(source, { ecmaVersion: "latest", sourceType, checkPrivateFields: false }),
    };
    expect(confined.call(env, "(a) => a + b")).toMatchObject({
      hermetic: false,
      problems: [{ kind: "freeVariable", name: "b" }],
    });
  });

  it("refuses a function that isn't hermetic, and says why", () => {
    const error = thrown(() => confine("(a) => a + b + Math.max(a)"));
    expect(error.message).toBe("Not hermetic: 'b' is a free variable (at 11); 'Math' is a free variable (at 15).");
    expect(error.problems.map((problem) => problem.kind)).toEqual(["freeVariable", "freeVariable"]);
    expect(error.source).toBe("(a) => a + b + Math.max(a)");
  });

  it("confines a method, rebuilt from its source as the only member of an object", () => {
    const area = confine<(this: { w: number; h: number }) => number>("area() { return this.w * this.h }");
    expect(area.call({ w: 2, h: 3 })).toBe(6);
    const size = confine<(this: { items: unknown[] }) => number>("get size() { return this.items.length }");
    expect(size.call({ items: [1, 2] })).toBe(2);
  });

  it("confines a class", () => {
    const Point = confine<new (x: number) => { x: number }>("class Point { constructor(x) { this.x = x } }");
    expect(new Point(3).x).toBe(3);
  });

  it("refuses a method that reads a private name of its class", () => {
    expect(thrown(() => confine("total() { return this.#items.length }")).message).toBe(
      "Not hermetic: '#items' is a private name of a class around it, so it works only inside that class (at 22).",
    );
  });

  it("can't rebuild a private method, whose name only its class can hold", () => {
    expect(thrown(() => confine("#secret() { return 1 }")).message).toMatch(/^The compartment could not evaluate it/);
  });

  it("can't rebuild a method whose computed key reads a global, which the compartment doesn't have", () => {
    const error = thrown(() => confine("*[Symbol.iterator]() { yield* this.items }"));
    expect(error.message).toMatch(/^The compartment could not evaluate it/);
    expect(error.problems).toEqual([]);
  });

  it("refuses a bound function, whose source isn't available", () => {
    const add = (a: number, b: number) => a + b;
    expect(thrown(() => confine(add.bind(null, 1))).problems).toMatchObject([{ kind: "syntax" }]);
  });

  describe("stops what reading names can't show", () => {
    // Each of these names nothing outside itself, so check passes it.
    it("a write to the built-ins every object shares, as in ({}).__proto__", () => {
      const pollute = confine(() => {
        ({} as { __proto__: { hasOwnProperty: unknown } }).__proto__.hasOwnProperty = () => true;
      });
      expect(pollute).toThrow(TypeError);
      expect(Object.prototype.hasOwnProperty.call({}, "x")).toBe(false);
    });

    it("the global object, reached through a constructor", () => {
      const escape = confine(() => [].constructor.constructor("return globalThis")());
      expect(escape).toThrow(TypeError);
    });
  });

  it("leaves a member out when the environment leaves it out", () => {
    const random = confine<(this: { Math: Omit<Math, "random"> }) => number>(
      'function () { "use hermetic"; return this.Math.random() }',
    );
    expect(() => random.call(intrinsics(globalThis))).toThrow(TypeError);
  });

  describe("reports source the compartment refuses", () => {
    it("text Hardened JS rejects, even inside a string", () => {
      const error = thrown(() => confine(() => "<!-- a comment? -->"));
      expect(error.message).toMatch(/^The compartment could not evaluate it: Possible HTML comment rejected/);
      expect(error.problems).toEqual([]);
    });

    it("a function that only works in sloppy mode", () => {
      expect(thrown(() => confine("function () { return 010 }")).message).toBe(
        "The compartment could not evaluate it: Octal literals are not allowed in strict mode.",
      );
    });
  });
});
