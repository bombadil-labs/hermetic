import * as tsParser from "@typescript-eslint/parser";
import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import { analyze, createEnvironment } from "../src/analysis.ts";
import { type LiftAssumptions, tryLift } from "../src/lift.ts";
import { type FunctionNode, functionName } from "../src/marking.ts";
import { isCandidate } from "../src/rules/prefer-hermetic.ts";
import { createRule, sealed } from "../src/rules/sealed.ts";

/** What `tryLift` decides for each candidate in `code` that is not hermetic already: how it lifts, or why not. */
function decisions(code: string, assumptions?: LiftAssumptions, filename = "module.ts"): Record<string, string> {
  const found: Record<string, string> = {};
  const probe = createRule<[], never>({
    name: "probe",
    meta: { type: "suggestion", docs: { description: "Records what tryLift decides" }, schema: [], messages: {} },
    defaultOptions: [],
    create(context) {
      const env = createEnvironment(context, {}, sealed);
      return {
        ":function"(node: FunctionNode) {
          if (!isCandidate(node)) return;
          const problems = analyze(node, functionName(node), env);
          if (problems.length === 0) return;
          const result = tryLift(node, problems, env, assumptions);
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
        class A { m() { return R; } }
        export const typed: (x: number) => number = (x) => x * R;
        export function hoisted(x: number) { return clamp(x); }
        export function stack() { return new Error().stack + R; }
        export const own = () => this.x + R;
      `),
    ).toEqual({
      m: "a method or object member",
      typed: "a typed variable",
      hoisted: "a declaration that reads unsettled names",
      stack: "reads the stack",
      own: "lexical this or new.target",
    });
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
