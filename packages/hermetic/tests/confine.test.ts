// lockdown() freezes the built-ins of the whole process, and can't be undone.
// Vitest runs each test file in a process of its own, so only this file runs
// under Hardened JS.
import "ses";
import { parse } from "acorn";
import { beforeAll, describe, expect, it } from "vitest";
import { type CheckContext, checkHermetic, confine, DEFAULT_GROUND, type GroundBootstrap, HermeticError } from "../src/index.ts";

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

  it("confines methods and accessors", () => {
    const area = confine<(this: { w: number; h: number }) => number>("area() { return this.w * this.h }");
    const size = confine<(this: { items: unknown[] }) => number>("get size() { return this.items.length }");
    const iterate = confine("[Symbol.iterator]() { return [][Symbol.iterator]() }");
    expect(area.call({ w: 2, h: 3 })).toBe(6);
    expect(size.call({ items: [1, 2] })).toBe(2);
    expect(iterate.name).toBe("[Symbol.iterator]");
  });

  it("confines classes, and hardens their prototypes", () => {
    const Point = confine<new (x: number, y: number) => { norm(): number }>(
      "class Point { constructor(x, y) { this.x = x; this.y = y } norm() { return Math.hypot(this.x, this.y) } }",
    );
    expect(new Point(3, 4).norm()).toBe(5);
    expect(() => Object.assign(Point.prototype, { norm: () => 0 })).toThrow(TypeError);
  });

  it("confines the checker itself, which gets nothing but the parser it is handed", () => {
    const confined = confine(checkHermetic);
    const context: CheckContext = {
      parse: (source, sourceType) => parse(source, { ecmaVersion: "latest", sourceType, checkPrivateFields: false }),
      ground: DEFAULT_GROUND,
    };
    expect(confined.call(context, "(a) => a + b")).toMatchObject({
      hermetic: false,
      problems: [{ kind: "freeVariable", name: "b" }],
    });
  });

  it("refuses a function that isn't hermetic, and says why", () => {
    const error = thrown(() => confine("(a) => a + b + Math.random()"));
    expect(error.message).toBe("Not hermetic: 'b' is a free variable (at 11); 'Math.random' is not allowed (at 15).");
    expect(error.problems.map((problem) => problem.kind)).toEqual(["freeVariable", "deniedPath"]);
    expect(error.source).toBe("(a) => a + b + Math.random()");
  });

  it("refuses a bound function, whose source isn't available", () => {
    const add = (a: number, b: number) => a + b;
    expect(thrown(() => confine(add.bind(null, 1))).problems).toMatchObject([{ kind: "syntax" }]);
  });

  describe("stops what reading names can't show", () => {
    // Each of these reads nothing but its inputs by name, so check passes it.
    it("a write to the built-ins every object shares", () => {
      const pollute = confine(() => {
        Object.getPrototypeOf({}).hasOwnProperty = () => true;
      });
      expect(pollute).toThrow(TypeError);
      expect(Object.prototype.hasOwnProperty.call({}, "x")).toBe(false);
    });

    it("the global object, reached through a constructor", () => {
      const escape = confine(() => [].constructor.constructor("return globalThis")());
      expect(escape).toThrow(TypeError);
    });

    it("a denied member, reached through an alias", () => {
      const random = confine(() => {
        const m = Math;
        return m.random();
      });
      expect(random).toThrow("secure mode");
    });
  });

  it("leaves the compartment only the allowed globals", () => {
    // A method's computed key runs once, inside the compartment, when it is confined.
    expect(confine("[typeof Date]() {}").name).toBe("undefined");
    expect(confine("[typeof globalThis]() {}").name).toBe("undefined");
    expect(confine("[typeof Math]() {}").name).toBe("object");
  });

  it("freezes the compartment's global object, so nothing can be kept there", () => {
    // Evaluated code sees the compartment's global object as its top-level this.
    const error = thrown(() => confine("[(this.kept = 1, 'm')]() {}"));
    expect(error.message).toBe("The compartment could not evaluate it: Cannot add property kept, object is not extensible");
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  describe("with a ground bootstrap", () => {
    const ground: GroundBootstrap = (realm) => ({
      allow: { Math: realm.Math, Date: realm.Date },
      deny: ["Math.random", "Date.now"],
    });

    it("allows the globals it picks, from the compartment", () => {
      expect(confine(() => new Date(0).getTime(), { ground })()).toBe(0);
      expect(thrown(() => confine(() => JSON.stringify(1), { ground })).message).toBe(
        "Not hermetic: 'JSON' is a free variable (at 6).",
      );
    });

    it("denies what it denies, by name and through an alias", () => {
      expect(thrown(() => confine(() => Date.now(), { ground })).problems).toMatchObject([{ kind: "deniedPath" }]);
      const clock = confine(
        () => {
          const D = Date;
          return D.now();
        },
        { ground },
      );
      expect(clock).toThrow("secure mode");
    });

    it("hardens the values it adds", () => {
      const rates = { tax: 2 };
      const withRates: GroundBootstrap = () => ({ allow: { rates } });
      const tax = confine<(n: number) => number>("(n) => n * rates.tax", { ground: withRates });
      expect(tax(3)).toBe(6);
      expect(Object.isFrozen(rates)).toBe(true);
    });

    it("removes a name denied whole", () => {
      const noMath: GroundBootstrap = (realm) => ({ allow: { Math: realm.Math }, deny: ["Math"] });
      expect(confine("[typeof Math]() {}", { ground: noMath }).name).toBe("undefined");
    });
  });

  describe("reports source the compartment refuses", () => {
    it("text Hardened JS rejects, even inside a string", () => {
      const error = thrown(() => confine(() => "<!-- a comment? -->"));
      expect(error.message).toMatch(/^The compartment could not evaluate it: Possible HTML comment rejected/);
      expect(error.problems).toEqual([]);
    });

    it("a method that uses its class's private names", () => {
      const error = thrown(() => confine("total() { return this.#items.length }"));
      expect(error.message).toBe(
        "The compartment could not evaluate it: Private field '#items' must be declared in an enclosing class",
      );
    });
  });
});
