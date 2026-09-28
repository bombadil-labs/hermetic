import { describe, expect, expectTypeOf, it } from "vitest";
import { HermeticError } from "../src/index.ts";
import { methods } from "../src/methods.ts";
import { type Recording, record, replay } from "../src/record.ts";

function area(this: { width: number; height: number }) {
  "use hermetic";
  return this.width * this.height;
}

function scale(this: { width: number; height: number }, k: number) {
  "use hermetic";
  this.width *= k;
  this.height *= k;
}

function summary(this: { area(): number }) {
  "use hermetic";
  return `area ${this.area()}`;
}

/** A class of state alone, for methods to be installed on. */
function shape() {
  return class {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
  };
}

function thrown(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected it to throw.");
}

describe("methods", () => {
  it("installs hermetic functions as methods, whose this is the instance", () => {
    const Rect = methods(shape(), { area, scale, summary });
    const rect = new Rect(2, 3);
    expect(rect.area()).toBe(6);
    rect.scale(2);
    expect(rect.summary()).toBe("area 24");
  });

  it("leaves each function testable alone, with any object that has what it reads", () => {
    methods(shape(), { area, summary });
    expect(area.call({ width: 2, height: 3 })).toBe(6);
    expect(summary.call({ area: () => 7 })).toBe("area 7");
  });

  it("returns the class itself, with the methods as a class's own: not enumerable", () => {
    const Base = shape();
    const Rect = methods(Base, { area });
    expect(Rect).toBe(Base);
    expect(Object.getOwnPropertyDescriptor(Rect.prototype, "area")).toEqual({ value: area, writable: true, enumerable: false, configurable: true });
    expect(Object.keys(new Rect(1, 1))).toEqual(["width", "height"]);
  });

  it("overrides what the class inherits", () => {
    const Rect = methods(shape(), { area });
    class Square extends Rect {}
    function side(this: { width: number }) {
      "use hermetic";
      return this.width;
    }
    const Squared = methods(Square, { area: side });
    expect(new Squared(3, 3).area()).toBe(3);
  });

  it("refuses a function that isn't hermetic, and installs none of the others", () => {
    const Base = shape();
    const clamped = function (this: { width: number }) {
      return Math.min(this.width, 10);
    };
    const error = thrown(() => methods(Base, { area, clamped }));
    expect(error).toBeInstanceOf(HermeticError);
    const at = Function.prototype.toString.call(clamped).indexOf("Math");
    expect(error.message).toBe(`Can't install 'clamped': Not hermetic: 'Math' is a free variable (at ${at}).`);
    expect(Object.hasOwn(Base.prototype, "area")).toBe(false);
  });

  it("refuses a class, a value that isn't a function, a name the class has, and a base that isn't a class", () => {
    const Base = methods(shape(), { area });
    expect(thrown(() => methods(shape(), { Point: class {} } as never)).message).toBe("Can't install 'Point': it is a class, not a function or method.");
    expect(thrown(() => methods(shape(), { size: 3 } as never)).message).toBe("'size' is not a function.");
    expect(thrown(() => methods(Base, { area })).message).toBe("The class already has 'area' of its own.");
    expect(thrown(() => methods((() => 1) as never, { area })).message).toBe("methods() installs functions on a class, and takes the class first.");
  });

  it("records a method called on an instance, and replays it", () => {
    const Rect = methods(shape(), { area });
    const recordings: Recording[] = [];
    const recorded = record(Rect.prototype.area, new Rect(2, 5), (recording) => recordings.push(recording));
    expect(recorded()).toBe(10);
    expect(replay(area, recordings[0] as Recording)).toBe(10);
  });

  it("types each method without its this parameter, and checks this against the instance", () => {
    const Rect = methods(shape(), { area, scale, summary });
    expectTypeOf(new Rect(1, 1).area).toEqualTypeOf<() => number>();
    expectTypeOf(new Rect(1, 1).scale).toEqualTypeOf<(k: number) => void>();
    expectTypeOf<ConstructorParameters<typeof Rect>>().toEqualTypeOf<[width: number, height: number]>();
    function depth(this: { depth: number }) {
      "use hermetic";
      return this.depth;
    }
    // @ts-expect-error: an instance has no depth.
    methods(shape(), { depth });
  });
});
