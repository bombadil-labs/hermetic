import * as tsParser from "@typescript-eslint/parser";
import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import { analyze, createAnalysis } from "../src/analysis.ts";
import { type LiftAssumptions, tryLift } from "../src/lift.ts";
import { type FunctionNode, functionName } from "../src/marking.ts";
import { isCandidate } from "../src/rules/prefer-hermetic.ts";
import { createRule } from "../src/rules/create-rule.ts";

/** What `tryLift` decides for each candidate in `code` that is not hermetic already: how it lifts, or why not. */
function decisions(code: string, assumptions?: LiftAssumptions, filename = "module.ts"): Record<string, string> {
  const found: Record<string, string> = {};
  const probe = createRule<[], never>({
    name: "probe",
    meta: { type: "suggestion", docs: { description: "Records what tryLift decides" }, schema: [], messages: {} },
    defaultOptions: [],
    create(context) {
      const analysis = createAnalysis(context, {});
      return {
        ":function"(node: FunctionNode) {
          if (!isCandidate(node)) return;
          const problems = analyze(node, functionName(node), analysis);
          if (problems.length === 0) return;
          const result = tryLift(node, problems, analysis, assumptions);
          found[functionName(node)] = typeof result === "string" ? result : result.contextName ? "shared context" : "direct";
        },
      };
    },
  });
  const messages = new Linter({ configType: "flat" }).verify(
    code,
    [
      {
        files: ["**/*.ts", "**/*.tsx"],
        languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: filename.endsWith(".tsx") } } },
        plugins: { probe: { rules: { decide: probe as never } } },
        rules: { "probe/decide": "error" },
      },
    ],
    filename,
  );
  expect(messages.filter((message) => message.fatal)).toEqual([]);
  return found;
}

describe("tryLift", () => {
  it("says why it leaves a function alone", () => {
    expect(
      decisions(`
        import { clamp } from "./clamp";
        const R = 1;
        class A { #x = 1; m() { return this.#x + R; } }
        export const o = { member: (x: number) => x * R };
        export const typed: (x: number) => number = (x) => x * R;
        export function hoisted(x: number) { return clamp(x); }
        export function stack() { return new Error().stack + R; }
        export const own = () => this.x + R;
      `),
    ).toEqual({
      m: "a private name",
      member: "an object member",
      typed: "a typed variable",
      hoisted: "a declaration that reads unsettled names",
      stack: "reads the stack",
      own: "lexical this or new.target",
    });
  });

  it("says why it leaves a method alone", () => {
    expect(
      decisions(`
        declare const dec: any;
        declare class Base { m(): number }
        const R = 1;
        class Field { field = () => R; }
        class Decorated { @dec decorated() { return R; } }
        export default { anonymous() { return R; } };
        export const typed: { untyped(x: number): number } = { untyped(x) { return x + R; } };
        class ThisType { thisType(this: ThisType): this { return R ? this : this; } }
        class Shadows<T> { shadows<T>(x: T) { return [x, R]; } }
        class Hidden { private p = 1; hidden() { return this.p + R; } }
        class Early { static { Early.early(); } static early() { return LATER; } }
        export const Expression = class Own { ownName() { return Own.name + R; } };
        class Target { target() { return new.target ?? R; } }
        class Sub extends Base { sup() { return super.m() + R; } }
        { class Blocked { blocked() { return R; } } }
        class Asserts { asserts(x: unknown): asserts x { if (!R) throw x; } }
        const LATER = 2;
      `),
    ).toEqual({
      field: "a class field",
      decorated: "a decorated method",
      anonymous: "its object's type has no name",
      untyped: "a parameter typed by its object",
      thisType: "the this type",
      shadows: "a type parameter shadows its class's",
      hidden: "reads a private or protected member",
      early: "a method its statement may call before its context exists",
      ownName: "a class expression's own name",
      target: "new.target in a method",
      sup: "super",
      blocked: "not declared at module level",
      asserts: "a this parameter or asserts",
    });
  });

  it("says how it lifts a method", () => {
    expect(
      decisions(`
        const R = 1;
        export class A {
          direct() { return R; }
          static own() { return new A(); }
          later() { return A.name + LATER; }
        }
        export const o = { size(this: { n: number }) { return this.n * LATER; } };
        const LATER = 2;
      `),
    ).toEqual({ direct: "direct", own: "direct", later: "shared context", size: "shared context" });
  });

  it("names JSX", () => {
    expect(decisions(`const R = 1; export function F() { return <b>{R}</b>; }`, {}, "component.tsx")).toEqual({ F: "JSX" });
  });

  it("says how it lifts the rest", () => {
    expect(
      decisions(`
        import { clamp } from "./clamp";
        const R = 1;
        export const before = (x: number) => x * R;
        export const reads = (x: number) => clamp(x);
      `),
    ).toEqual({ before: "direct", reads: "shared context" });
  });

  describe("assuming imports are settled", () => {
    it("lifts a declaration that reads only imports and settled names, directly", () => {
      const code = `
        import { clamp } from "./clamp";
        import * as units from "./units";
        function helper(x: number) { return x; }
        export function hoisted(x: number) { return units.cents(clamp(helper(x))); }
      `;
      expect(decisions(code)).toEqual({ hoisted: "a declaration that reads unsettled names" });
      expect(decisions(code, { importsSettled: true })).toEqual({ hoisted: "direct" });
    });

    it("still leaves a declaration that reads anything else unsettled", () => {
      const code = `
        import { clamp } from "./clamp";
        let helper = (x: number) => x;
        function swapped(x: number) { return x; }
        swapped = (x: number) => -x;
        export function readsLet(x: number) { return clamp(helper(x)); }
        export function readsSwapped(x: number) { return clamp(swapped(x)); }
        export function readsGlobal() { return clamp(Date.now()); }
      `;
      const reason = "a declaration that reads unsettled names";
      expect(decisions(code, { importsSettled: true })).toMatchObject({ readsLet: reason, readsSwapped: reason, readsGlobal: reason });
    });
  });
});
