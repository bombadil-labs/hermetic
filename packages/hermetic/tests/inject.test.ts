import { inject } from "@bombadil/hermetic/inject";
import { describe, expect, expectTypeOf, it } from "vitest";
import { HermeticError, type Intrinsics, intrinsics } from "../src/index.ts";

function price(this: { rate: number; clamp: (n: number) => number }, total: number): number {
  "use hermetic";
  return this.clamp(total * (1 - this.rate));
}

function round(this: Pick<Intrinsics, "Math">, n: number): number {
  "use hermetic";
  return this.Math.round(n);
}

function orElse<A>(this: { fallback: <B>(value: B) => B }, value: A | undefined, otherwise: A): A {
  "use hermetic";
  return value === undefined ? this.fallback(otherwise) : value;
}

describe("inject", () => {
  const env = { rate: 0.25, clamp: (n: number) => Math.min(n, 60), unrelated: "left out" };

  it("binds a hermetic function to the names it reads from this", () => {
    expect(inject(price, env)(100)).toBe(60);
    expect(inject(price, env)(40)).toBe(30);
  });

  it("reads only the names the function reads, each once, when it binds", () => {
    const read: (string | symbol)[] = [];
    const recording = new Proxy(env, { get: (target, name, receiver) => (read.push(name), Reflect.get(target, name, receiver)) });
    const bound = inject(price, recording);
    bound(10);
    bound(20);
    expect(read).toEqual(["clamp", "rate"]);
  });

  it("gives the function a frozen environment, so it can't change what another binding gets", () => {
    function bump(this: { count: number }): number {
      "use hermetic";
      this.count = this.count + 1;
      return this.count;
    }
    expect(() => inject(bump, { count: 0 })()).toThrow(TypeError);
  });

  it("takes built-ins from intrinsics like any other environment", () => {
    expect(inject(round, intrinsics(globalThis))(2.6)).toBe(3);
  });

  it("accepts a container that reports its names as own properties, and doesn't answer in", () => {
    // Like Awilix's cradle: every read resolves a registration, and there is no has trap.
    const registry: Record<string, unknown> = { rate: 0.5, clamp: (n: number) => n };
    const cradle = new Proxy({} as typeof env, {
      get: (_target, name) => registry[name as string],
      getOwnPropertyDescriptor: (_target, name) => (name in registry ? { enumerable: true, configurable: true } : undefined),
    });
    expect("rate" in cradle).toBe(false);
    expect(inject(price, cradle)(10)).toBe(5);
  });

  it("keeps the function's type parameters, and checks the environment against its this type", () => {
    const bound = inject(orElse, { fallback: <B>(value: B) => value });
    expectTypeOf(bound<string>).toEqualTypeOf<(value: string | undefined, otherwise: string) => string>();
    expectTypeOf(bound(undefined, 1)).toEqualTypeOf<number>();
    expect(bound(undefined, "default")).toBe("default");
    // @ts-expect-error: the environment lacks clamp
    expect(() => inject(price, { rate: 0.1 })).toThrow(HermeticError);
  });

  it("refuses a function that isn't hermetic, and says why", () => {
    const limit = 3;
    function capped(this: { base: number }): number {
      return Math.min(this.base, limit);
    }
    expect(() => inject(capped, { base: 1 })).toThrow(/Not hermetic: 'Math' is a free variable .*; 'limit' is a free variable/);
  });

  it("refuses a function when it can't list what it reads from this", () => {
    function lookup(this: Record<string, number>, key: string): number | undefined {
      "use hermetic";
      return this[key];
    }
    expect(() => inject(lookup, { a: 1 })).toThrow(/Can't list what it reads from 'this'/);
  });

  it("refuses an environment that lacks a name, and names it", () => {
    expect(() => inject(price, { rate: 0.1 } as never)).toThrow("The environment lacks 'clamp', which the function reads from 'this'.");
  });

  it("refuses an environment that isn't an object", () => {
    expect(() => inject(round, null as never)).toThrow(TypeError);
  });

  it("refuses a bound function, whose source isn't available", () => {
    expect(() => inject(price.bind(env), {})).toThrow(HermeticError);
  });
});
