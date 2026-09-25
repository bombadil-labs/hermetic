import { describe, expect, it } from "vitest";
import { check, intrinsics } from "../src/index.ts";

describe("intrinsics", () => {
  const picked = intrinsics(globalThis);

  it("picks the deterministic built-ins out of the realm", () => {
    expect(Object.keys(picked)).toEqual([
      "Array",
      "Object",
      "Map",
      "Set",
      "WeakMap",
      "WeakSet",
      "Symbol",
      "Number",
      "String",
      "Boolean",
      "BigInt",
      "parseInt",
      "parseFloat",
      "isNaN",
      "isFinite",
      "JSON",
      "RegExp",
      "Promise",
      "Error",
      "AggregateError",
      "EvalError",
      "RangeError",
      "ReferenceError",
      "SyntaxError",
      "TypeError",
      "URIError",
      "Math",
    ]);
    expect(picked.Array).toBe(Array);
    expect(picked.JSON).toBe(JSON);
  });

  it("leaves out the clock, the locale, the host and code loading", () => {
    for (const name of ["Date", "Intl", "fetch", "console", "setTimeout", "globalThis", "eval", "Function"]) {
      expect(picked).not.toHaveProperty(name);
    }
  });

  it("gives Math without random, and everything else it has", () => {
    expect("random" in picked.Math).toBe(false);
    expect(picked.Math.max(1, 3)).toBe(3);
    expect(picked.Math.PI).toBe(Math.PI);
    expect(Object.prototype.toString.call(picked.Math)).toBe("[object Math]");
    expect(Reflect.ownKeys(picked.Math).length).toBe(Reflect.ownKeys(Math).length - 1);
  });

  it("freezes what it returns", () => {
    expect(Object.isFrozen(picked)).toBe(true);
    expect(Object.isFrozen(picked.Math)).toBe(true);
  });

  it("is itself hermetic: it reads nothing but the realm it is given", () => {
    expect(check(intrinsics)).toMatchObject({ marked: true, hermetic: true });
  });
});
