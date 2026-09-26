import { DoctestError, doctests } from "@bombadil/hermetic/doctest";
import { describe, expect, it } from "vitest";
import { HermeticError } from "../src/index.ts";

/** Evaluates a module written in JavaScript, and returns its exports as a namespace would hold them. */
function load(source: string): Record<string, unknown> {
  const names = [...source.matchAll(/export (?:async )?(?:function\*? ?|const )([\w$]+)/g)].map((match) => match[1]);
  return new Function(`"use strict";\n${source.replace(/^export /gm, "")}\nreturn { ${names.join(", ")} };`)() as Record<string, unknown>;
}

async function results(source: string, scope?: Record<string, unknown>): Promise<Record<string, string>> {
  const outcomes: Record<string, string> = {};
  for (const test of doctests(load(source), source, scope ? { scope } : {})) {
    try {
      await test.run();
      outcomes[test.name] = "passed";
    } catch (error) {
      outcomes[test.name] = `${(error as Error).name}: ${(error as Error).message}`;
    }
  }
  return outcomes;
}

describe("doctests", () => {
  it("runs each example of a hermetic function, as exported and rebuilt from its source", async () => {
    const source = [
      `/**`,
      ` * Rounds to whole cents.`,
      ` * @example`,
      ` * const env = { Math };`,
      ` * toCents.call(env, 1.005) // => 1`,
      ` * toCents.call(env, 2.5) // => 2.5`,
      ` * @example <caption>Negative amounts</caption>`,
      ` * toCents.call({ Math }, -1.234) // => -1.23`,
      ` */`,
      `export function toCents(n) {`,
      `  "use hermetic";`,
      `  return this.Math.round(n * 100) / 100;`,
      `}`,
    ].join("\n");
    expect(await results(source)).toEqual({ "toCents: example 1": "passed", "toCents: Negative amounts": "passed" });
  });

  it("compares values by structure, awaits, and checks what an example throws", async () => {
    const source = [
      `/**`,
      ` * @hermetic`,
      ` * @example`,
      ` * const env = { sep: ",", RangeError };`,
      ` * await split.call(env, "a,b") // => { parts: ["a", "b"], count: 2 }`,
      ` * await split.call(env, 1) // throws TypeError`,
      ` * await split.call(env, "") // throws RangeError: nothing to split`,
      ` */`,
      `export const split = async function (text) {`,
      `  if (text === "") throw new this.RangeError("nothing to split");`,
      `  const parts = text.split(this.sep);`,
      `  return { parts, count: parts.length };`,
      `};`,
    ].join("\n");
    expect(await results(source)).toEqual({ "split: example": "passed" });
  });

  it("reports an example that doesn't hold, with the line", async () => {
    const source = [
      `/**`,
      ` * @example`,
      ` * double(2) // => 4`,
      ` * double(3) // => 7`,
      ` */`,
      `export function double(n) {`,
      `  "use hermetic";`,
      `  return n * 2;`,
      `}`,
    ].join("\n");
    expect(await results(source)).toEqual({
      "double: example": "DoctestError: double, as exported, line 2 of the example: double(3) // => 7\n  gave 6, not 7",
    });
  });

  it("fails a function marked hermetic that isn't, before running its examples", async () => {
    const source = [
      `const RATE = 2;`,
      `/**`,
      ` * @example`,
      ` * scale(2) // => 4`,
      ` */`,
      `export function scale(n) {`,
      `  "use hermetic";`,
      `  return n * RATE;`,
      `}`,
    ].join("\n");
    const [test] = doctests(load(source), source);
    await expect(test?.run()).rejects.toThrow(HermeticError);
  });

  it("skips functions that aren't marked hermetic, and names that aren't exported functions", async () => {
    const source = [
      `/** @example plain(1) // => 2 */`,
      `export function plain(n) { return n + 1; }`,
      `/** @hermetic @example hidden(1) // => 1 */`,
      `function hidden(n) { return n; }`,
      `/** @example LIMIT // => 3 */`,
      `export const LIMIT = 3;`,
    ].join("\n");
    expect(doctests(load(source), source)).toEqual([]);
  });

  it("passes the scope's names to the examples", async () => {
    const source = [
      `/**`,
      ` * @example`,
      ` * clamp.call(limits, 120) // => 100`,
      ` */`,
      `export function clamp(n) {`,
      `  "use hermetic";`,
      `  return n > this.max ? this.max : n;`,
      `}`,
    ].join("\n");
    expect(await results(source, { limits: { max: 100 } })).toEqual({ "clamp: example": "passed" });
  });

  it("reports an example that isn't JavaScript", async () => {
    const source = [`/**`, ` * @example`, ` * id(1 as number) // => 1`, ` */`, `export function id(n) {`, `  "use hermetic";`, `  return n;`, `}`].join("\n");
    const [test] = doctests(load(source), source);
    await expect(test?.run()).rejects.toThrow(DoctestError);
  });
});
