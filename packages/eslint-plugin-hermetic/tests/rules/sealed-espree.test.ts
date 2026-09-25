import { type Rule, RuleTester } from "eslint";
import { sealed } from "../../src/rules/sealed.ts";

// Plain JavaScript through ESLint's default parser and eslint-scope.
const ruleTester = new RuleTester({ languageOptions: { ecmaVersion: "latest", sourceType: "module" } });

ruleTester.run("sealed with espree", sealed as unknown as Rule.RuleModule, {
  valid: [
    `function f(a) { "use hermetic"; return this.Math.max(a, 1); }`,
    `const g = function self(n) { "use hermetic"; return n ? self(n - 1) : 0; };`,
    `function fact(n) { "use hermetic"; return n <= 1 ? 1 : n * fact(n - 1); }`,
    `function f(a) { "use hermetic"; return a === undefined ? NaN : Infinity; }`,
    {
      code: `function f(a) { "use hermetic"; return a === undefined ? NaN : Infinity; }`,
      languageOptions: { globals: { undefined: "readonly", NaN: "readonly", Infinity: "readonly" } },
    },
  ],
  invalid: [
    {
      code: `const R = 1; function f() { "use hermetic"; return R; }`,
      errors: [{ messageId: "freeVariable", data: { name: "R", fn: "f" } }],
    },
    {
      code: `function f() { "use hermetic"; return Math.random(); }`,
      errors: [{ messageId: "freeVariable", data: { name: "Math", fn: "f" } }],
    },
    {
      code: `function f(a) { "use hermetic"; return Math.max(a, 1); }`,
      languageOptions: { globals: { Math: "readonly" } },
      errors: [{ messageId: "freeVariable", data: { name: "Math", fn: "f" } }],
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
      code: `var NaN2 = 0; var undefined = 1; function f() { "use hermetic"; return [undefined, NaN2]; }`,
      languageOptions: { sourceType: "script" },
      errors: [
        { messageId: "freeVariable", data: { name: "undefined", fn: "f" } },
        { messageId: "freeVariable", data: { name: "NaN2", fn: "f" } },
      ],
    },
    {
      code: `const o = { m() { "use hermetic"; return this.x; } };`,
      errors: [{ messageId: "method", data: { fn: "m" } }],
    },
  ],
});
