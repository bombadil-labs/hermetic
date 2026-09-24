import { type Rule, RuleTester } from "eslint";
import { sealed } from "../../src/rules/sealed.ts";

// Plain JavaScript through ESLint's default parser and eslint-scope.
const ruleTester = new RuleTester({ languageOptions: { ecmaVersion: "latest", sourceType: "module" } });

ruleTester.run("sealed with espree", sealed as unknown as Rule.RuleModule, {
  valid: [
    `function f(a) { "use hermetic"; return Math.max(a, 1); }`,
    `const g = function self(n) { "use hermetic"; return n ? self(n - 1) : 0; };`,
    `function fact(n) { "use hermetic"; return n <= 1 ? 1 : n * fact(n - 1); }`,
    {
      code: `function f(a) { "use hermetic"; return Math.max(a, 1); }`,
      languageOptions: { globals: { Math: "readonly" } },
    },
  ],
  invalid: [
    {
      code: `const R = 1; function f() { "use hermetic"; return R; }`,
      errors: [{ messageId: "freeVariable", data: { name: "R", fn: "f" } }],
    },
    {
      code: `function f() { "use hermetic"; return Math.random(); }`,
      errors: [{ messageId: "deniedPath", data: { path: "Math.random", fn: "f" } }],
    },
    {
      code: `const f = () => { "use hermetic"; return this; };`,
      errors: [{ messageId: "lexicalThis", data: { fn: "f" } }],
    },
    {
      code: `/** @hermetic */ const f = () => window;`,
      languageOptions: { globals: { window: "readonly" } },
      errors: [{ messageId: "freeVariable", data: { name: "window", fn: "f" } }],
    },
    {
      code: `var Math = {}; function f() { "use hermetic"; return Math.max(1, 2); }`,
      languageOptions: { sourceType: "script" },
      errors: [{ messageId: "shadowedGround", data: { name: "Math", fn: "f" } }],
    },
  ],
});
