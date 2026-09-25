# @bombadil/eslint-plugin-hermetic

**A hermetic function reads nothing but its inputs: its arguments, including `this`, and a short list of allowed globals.** It doesn't use imports, module-level variables, or globals like `fetch` and `Date`; anything else it needs has to be passed in. `hermetic/sealed` checks the functions you mark as hermetic, and `hermetic/prefer-hermetic` finds functions that already are, and rewrites others so they can be.

```ts
function applyDiscount(this: Pricing, invoice: Invoice) {
  "use hermetic";
  const discounted = invoice.total * (1 - this.rate);
  return { ...invoice, total: this.clamp(discounted) };
}

// Supply the dependencies once, by binding this.
const pricing = { rate: config.rate, clamp: toCents };
export const applyPricing = applyDiscount.bind(pricing);
```

The [repository's README](https://github.com/bombadil-labs/hermetic#readme) explains what hermetic functions are for. [`@bombadil/hermetic`](https://www.npmjs.com/package/@bombadil/hermetic) checks the same things at runtime, from a function's source, and runs hermetic functions confined.

## Install

```sh
npm install --save-dev @bombadil/eslint-plugin-hermetic
```

Requires Node 22.13+ or 24+. Peer dependencies: `eslint` 9 or 10, and `@typescript-eslint/parser` 8.

```js
// eslint.config.js
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import hermetic from "@bombadil/eslint-plugin-hermetic";

export default defineConfig(
  ...tseslint.configs.recommended,
  hermetic.configs.recommended,
);
```

`hermetic/sealed` only checks functions marked hermetic, so turning it on doesn't affect the rest of your code. Both rules also work on plain JavaScript through ESLint's default parser.

| Rule | What it does | Fix |
| --- | --- | --- |
| [`hermetic/sealed`](https://github.com/bombadil-labs/hermetic/blob/main/packages/eslint-plugin-hermetic/docs/rules/sealed.md) | Reports the hidden inputs of functions marked hermetic. In the recommended config. | |
| [`hermetic/prefer-hermetic`](https://github.com/bombadil-labs/hermetic/blob/main/packages/eslint-plugin-hermetic/docs/rules/prefer-hermetic.md) | Reports functions that are already hermetic, and with `lift`, functions it can rewrite to be hermetic. | Marks, or lifts |

**Moving from `@bombadil/hermetic` 0.2.** Up to 0.2.0, the rules were published as `@bombadil/hermetic`. Install `@bombadil/eslint-plugin-hermetic` instead, and change the import in `eslint.config.js`. The rules, options and settings are the same.

## Marking a function

Put a `"use hermetic"` directive at the top of the body:

```ts
function total(invoices: Invoice[]) {
  "use hermetic";
  return invoices.reduce((sum, invoice) => sum + invoice.total, 0);
}
```

The directive survives TypeScript and esbuild, and appears in `fn.toString()`, so tools can recognize hermetic functions at runtime without a registry. `check` in `@bombadil/hermetic` reads it. **terser strips unknown directives by default.** Set `compress: { directives: false }` if production code needs to keep them.

A JSDoc `@hermetic` tag at the start of a line also marks a function. It works on arrow functions with an expression body, which can't hold a directive, but it isn't visible at runtime:

```ts
/** @hermetic */
export const cents = (n: number) => Math.round(n * 100);
```

Both forms apply to function declarations, function expressions, arrow functions, and object and class methods.

## What the rule reports

`hermetic/sealed` reports every hidden input of a marked function: each name it uses that isn't declared inside it and isn't an allowed global. It also reports the forms that scope analysis can't see:

| Reported | Example | Why |
| --- | --- | --- |
| Free variables | `return a * RATE;` | A hidden input. This includes imports, other hermetic functions, and `typeof window`. |
| Allowed globals shadowed by a local | `import { JSON } from "./json"` | The name refers to your variable, not the global. |
| Assignments to allowed globals | `Math = …` | Allowed globals can be read, not reassigned. |
| Denied members | `Math.random()`, `const { random } = Math` | The member isn't allowed. See [allowed globals](#allowed-globals). |
| `this` or `new.target` in a hermetic arrow function | `() => { "use hermetic"; return this.x; }` | An arrow function's `this` comes from the enclosing scope, not from its inputs. |
| `super` | `super.method()` | It refers to the enclosing class or object. |
| `import.meta`, `import()` | `import.meta.url` | They refer to the enclosing module, or load code. |
| JSX | `return <div />;` | It compiles to a call to the JSX factory, which is a free variable. |

The message says what to do:

```
'taxRate' is a free variable in hermetic function 'applyDiscount'. Pass it through 'this' or an argument.
```

**Allowed:** parameters, local variables, `arguments`, `this` in functions other than arrow functions, literals, allowed globals and their members, calling a callback passed in as an argument, and a function declaration calling itself by name. The last one still works after the function is moved, because re-evaluating its source turns the declaration into a named function expression, which binds its own name. If the name is reassigned, the call is reported again.

Nested functions may use the hermetic function's own local variables. Only names from outside the marked function are checked.

**Calling another hermetic function by name is still a hidden input.** Pass it in, usually through `this`:

```ts
export function checkout(this: { price: (invoice: Invoice) => Invoice }, invoices: Invoice[]) {
  "use hermetic";
  return invoices.reduce((sum, invoice) => sum + this.price(invoice).total, 0);
}
```

## Allowed globals

The allowed globals are the global names a hermetic function may read, except for any denied members inside them. By default they are deterministic built-ins that don't depend on the host, such as `Math`, `JSON`, `Array` and `Object`, without `Math.random`. `Date`, `fetch`, `console`, timers, `globalThis`, `eval` and `Intl` aren't allowed. [`@bombadil/hermetic`'s README](https://github.com/bombadil-labs/hermetic/tree/main/packages/hermetic#allowed-globals) lists them all, with the reason each is left out.

### Choosing the allowed globals with a bootstrap

The allowed globals are defined in code, by a hermetic function that receives a realm and returns `{ allow, deny }`:

```ts
// hermetic.ground.ts
export function ground(realm: typeof globalThis) {
  "use hermetic";
  return {
    allow: { Math: realm.Math, JSON: realm.JSON, Array: realm.Array, Object: realm.Object },
    deny: ["Math.random"],
  };
}
```

```js
// eslint.config.js
hermetic.configs.recommended,
{ settings: { hermetic: { ground: "./hermetic.ground.ts" } } },
```

The plugin loads it in three steps:

1. It lints the bootstrap with `hermetic/sealed`, using the default allowed globals, and refuses to load it unless it is marked hermetic and passes. Suppression comments are ignored here.
2. It erases the function's TypeScript syntax and evaluates its source text on its own, in a fresh `node:vm` context with string compilation disabled and a one-second timeout. The lint is what makes this reasonable: the function reads nothing but the realm passed to it. A vm context is not a security boundary.
3. It reads the keys of `allow` and the paths in `deny`. Only the keys matter to the linter.

The bootstrap is the export named `ground`, or else the default export. It may use TypeScript syntax that erases cleanly: annotations, `as`, `satisfies`, `!`, generics and local type declarations. Erasure keeps every line and column in place, so errors point into your file. Syntax that needs a compiler, such as enums and namespaces, is refused. [`examples/hermetic.ground.ts`](https://github.com/bombadil-labs/hermetic/blob/main/packages/eslint-plugin-hermetic/examples/hermetic.ground.ts) spells out the default list, as a starting point to copy.

The same bootstrap works at runtime. `confine` in `@bombadil/hermetic` takes it, and calls it with the global object of the Hardened JS compartment it runs a function in, so the linter and the runtime share one list. **Keep it a literal list.** At lint time, `realm` is a bare JavaScript realm, so a bootstrap that enumerates `realm` would see different names than it sees at runtime.

ESLint's `--cache` doesn't know about the bootstrap. Clear the cache after changing it.

### Denied members and aliasing

Denied members are checked through static member access (`Math.random`, `Math["random"]`, `Math?.random`, `(Math as any).random`) and destructuring (`const { random } = Math`, including nested patterns and parameter defaults).

The check is best effort: `const m = Math; m.random()` gets past it. There are three ways to close the gap:

- Set `aliasing: "forbid"`. An allowed global with denied members may then only be used in place: static member access, destructuring, `typeof`, calling or constructing it, and comparisons. Anything that could pass it elsewhere, such as `const m = Math`, `Math[key]` or `f(Math)`, is reported.
- Leave the whole object out of the allowed globals, and pass what you need through `this`.
- Run the function with `confine`, where `Math.random` throws however it is reached.

## Options

```ts
type Options = {
  types?: "allow" | "structural-only"; // default "allow"
  ground?: string; // path to a bootstrap, absolute or relative to ESLint's cwd (or a file: URL)
  aliasing?: "best-effort" | "forbid"; // default "best-effort"
};
```

Both rules take these options, and both read them from `settings.hermetic` as well, so one setting configures both. Options given to a rule take precedence.

```js
// eslint.config.js
{ settings: { hermetic: { ground: "./hermetic.ground.ts", aliasing: "forbid" } } },
```

- **`types`**. Type-only references are erased at runtime, so `"allow"` permits them, including `typeof x` in type positions. `"structural-only"` reports type references that resolve to a declaration outside the function, such as imports and module-level interfaces and aliases, so the function can move across files unchanged. TypeScript's lib types and other global types stay allowed.
- **`ground`**. The bootstrap that chooses the allowed globals. See [allowed globals](#allowed-globals).
- **`aliasing`**. See [denied members and aliasing](#denied-members-and-aliasing).

## Binding `this`

TypeScript type-checks the value of `this` in every `.call`, `.apply` and `.bind`:

```ts
const pricing: Pricing = { rate: config.discountRate, clamp: clampToCents };
export const applyPricing = applyDiscount.bind(pricing); // (invoice: Invoice) => Invoice
```

`ThisParameterType<F>` extracts the type of `this`, and `OmitThisParameter<F>` gives the signature after binding. With `types: "structural-only"`, write the type of `this` inline on the function, and name it where you bind it with `ThisParameterType<typeof applyDiscount>`. That way the function stays the source of truth for what it needs.

See [`examples/pricing.ts`](https://github.com/bombadil-labs/hermetic/blob/main/packages/eslint-plugin-hermetic/examples/pricing.ts) for a complete example.

## Making a codebase hermetic

`hermetic/prefer-hermetic` finds functions that are already hermetic and marks them. With `lift`, it also rewrites functions whose hidden inputs are all module-level values or globals: the body moves into a new hermetic function that receives them through `this`, and the original function becomes a wrapper that passes them in.

```ts
// before
export const discount = (dollars: number, rate = 0.2) => toCents(dollars * (1 - rate));

// after --fix
export const discount = (dollars: number, rate = 0.2) => discountHermetic.call({ toCents }, dollars, rate);

function discountHermetic(this: { toCents: typeof toCents }, dollars: number, rate = 0.2) {
  "use hermetic";
  return this.toCents(dollars * (1 - rate));
}
```

The wrapper passes exactly what the function used to read from its surroundings. Callers don't change, and you can narrow what is passed in by hand afterwards. One command does the whole codebase:

```sh
npx eslint --fix --rule '{"hermetic/prefer-hermetic": ["warn", {"lift": true}]}' src/
```

The fix only rewrites a function when the rewrite can't change its behavior or types, and leaves every other function as it was. On Effect, RxJS and TanStack Query, it marked 22.8% of 5,315 candidate functions and lifted 46.1%; the fixed code type-checks with no new errors, and Effect's own 6,233 tests pass on its lifted source. The [case studies](https://bombadil-labs.github.io/hermetic/) go through each library: what was marked, lifted and skipped, and why. The [rule's documentation](https://github.com/bombadil-labs/hermetic/blob/main/packages/eslint-plugin-hermetic/docs/rules/prefer-hermetic.md) lists what it skips, what changes (a stack frame, `toString`, a per-call cost), and how it decides.

The lift has an exact inverse, `unlift`, which turns each wrapper back into the original function, so the source can stay hermetic while a build runs the original code. On the corpus, unlifting the lifted code gives back the original program in every file, and Effect's benchmarks go from 24–71% slower when lifted to within noise of the original when unlifted. `unlift` isn't part of the published package yet; a bundler plugin that runs it on production builds is next. See [unlifting at build time](https://github.com/bombadil-labs/hermetic/blob/main/packages/eslint-plugin-hermetic/docs/rules/prefer-hermetic.md#unlifting-at-build-time).

## What hermetic functions don't give you

The rules check names. They don't make a function pure, and they don't make it a sandbox: a function can still reach the program's shared built-ins through the prototype chain of any value, as in `({}).__proto__.hasOwnProperty = () => true`. To run a function you don't trust, use `confine` from [`@bombadil/hermetic`](https://github.com/bombadil-labs/hermetic/tree/main/packages/hermetic#confine). The [repository's README](https://github.com/bombadil-labs/hermetic#what-hermetic-functions-dont-give-you) covers these limits.

## License

[MIT](LICENSE)
