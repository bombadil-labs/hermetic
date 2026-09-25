# @bombadil/eslint-plugin-hermetic

**A hermetic function reads nothing but its inputs: its arguments, including `this`.** It doesn't use imports, module-level variables or globals, not even built-ins such as `Math`; anything it needs is passed in. `hermetic/sealed` checks the functions you mark as hermetic, and `hermetic/prefer-hermetic` finds functions that already are, and rewrites others so they can be.

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

**Moving from `@bombadil/hermetic` 0.2.** Up to 0.2.0, the rules were published as `@bombadil/hermetic`. Install `@bombadil/eslint-plugin-hermetic` instead, and change the import in `eslint.config.js`. Two things changed with it. Hermetic functions read no globals now, not even built-ins, so the `ground` and `aliasing` settings are gone. And methods can't be hermetic yet.

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
export const cents = (dollars: number) => dollars * 100;
```

Both forms apply to function declarations, function expressions and arrow functions, including a function stored in an object's property. Methods can't be hermetic yet: a method's `this` is its object, not its inputs, so `hermetic/sealed` reports a marked method, accessor or class field.

## What the rule reports

`hermetic/sealed` reports every hidden input of a marked function: each name it uses that isn't declared inside it. It also reports the forms that scope analysis can't see:

| Reported | Example | Why |
| --- | --- | --- |
| Free variables | `return a * RATE;`, `Math.max(a, b)` | A hidden input. This includes imports, other hermetic functions, globals, built-ins such as `Math`, and `typeof window`. |
| A marked method | `class C { area() { "use hermetic"; … } }` | Methods can't be hermetic yet. |
| `this` or `new.target` in a hermetic arrow function | `() => { "use hermetic"; return this.x; }` | An arrow function's `this` comes from the enclosing scope, not from its inputs. |
| `super` | `() => super.method()` | It refers to the enclosing class or object. |
| `import.meta`, `import()` | `import.meta.url` | They refer to the enclosing module, or load code. |
| JSX | `return <div />;` | It compiles to a call to the JSX factory, which is a free variable. |

The message says what to do:

```
'taxRate' is a free variable in hermetic function 'applyDiscount'. Pass it through 'this' or an argument.
```

**Allowed:** parameters, local variables, `arguments`, `this` in functions other than arrow functions, literals, `undefined`, `NaN` and `Infinity`, which read like keywords, calling a callback passed in as an argument, and a function declaration calling itself by name. The last one still works after the function is moved, because re-evaluating its source turns the declaration into a named function expression, which binds its own name. If the name is reassigned, the call is reported again.

Nested functions may use the hermetic function's own local variables. Only names from outside the marked function are checked.

**Calling another hermetic function by name is still a hidden input.** Pass it in, usually through `this`:

```ts
export function checkout(this: { price: (invoice: Invoice) => Invoice }, invoices: Invoice[]) {
  "use hermetic";
  return invoices.reduce((sum, invoice) => sum + this.price(invoice).total, 0);
}
```

## Built-ins come in through `this`

A hermetic function reads no globals, so it gets built-ins the way it gets everything else. [`intrinsics(realm)`](https://github.com/bombadil-labs/hermetic/tree/main/packages/hermetic#intrinsics) in `@bombadil/hermetic` picks the deterministic ones out of a realm: `Array`, `Object`, `JSON`, `Math` without `random`, and the rest, but not `Date`, `fetch`, `console`, timers, `eval` or `Intl`:

```ts
import { intrinsics } from "@bombadil/hermetic";

function cents(this: { Math: Pick<Math, "round"> }, dollars: number) {
  "use hermetic";
  return this.Math.round(dollars * 100);
}

export const toCents = cents.bind(intrinsics(globalThis));
```

The code that binds hermetic functions builds these environments: a root one that reads the realm, and anything derived from it, frozen so that no function can change what another gets. [Passing things in](https://github.com/bombadil-labs/hermetic/tree/main/packages/hermetic#passing-things-in) covers the pattern. A clock, randomness or configuration comes in the same way, as an input you can see and replace.

`undefined`, `NaN` and `Infinity` are the exceptions. They are immutable, so a hermetic function may read them as if they were keywords, unless something outside it declares the name.

## Options

```ts
type Options = {
  types?: "allow" | "structural-only"; // default "allow"
};
```

Both rules take this option, and both read it from `settings.hermetic` as well, so one setting configures both. An option given to a rule takes precedence.

```js
// eslint.config.js
{ settings: { hermetic: { types: "structural-only" } } },
```

- **`types`**. Type-only references are erased at runtime, so `"allow"` permits them, including `typeof x` in type positions. `"structural-only"` reports type references that resolve to a declaration outside the function, such as imports and module-level interfaces and aliases, so the function can move across files unchanged. TypeScript's lib types and other global types stay allowed.

`ground` and `aliasing` were removed in 0.3.0. They chose which globals hermetic functions could read, and now there are none to choose, so setting either throws with that explanation.

## Binding `this`

TypeScript type-checks the value of `this` in every `.call`, `.apply` and `.bind`:

```ts
const pricing: Pricing = { rate: config.discountRate, clamp: clampToCents };
export const applyPricing = applyDiscount.bind(pricing); // (invoice: Invoice) => Invoice
```

`ThisParameterType<F>` extracts the type of `this`, and `OmitThisParameter<F>` gives the signature after binding. With `types: "structural-only"`, write the type of `this` inline on the function, and name it where you bind it with `ThisParameterType<typeof applyDiscount>`. That way the function stays the source of truth for what it needs.

See [`examples/pricing.ts`](https://github.com/bombadil-labs/hermetic/blob/main/packages/eslint-plugin-hermetic/examples/pricing.ts) for a complete example.

## Making a codebase hermetic

`hermetic/prefer-hermetic` finds functions that are already hermetic and marks them. With `lift`, it also rewrites functions whose hidden inputs are all module-level values or globals, built-ins such as `Math` included: the body moves into a new hermetic function that receives them through `this`, and the original function becomes a wrapper that passes them in.

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

The fix only rewrites a function when the rewrite can't change its behavior or types, and leaves every other function as it was. On Effect, RxJS and TanStack Query, it marked 15.0% of 3,703 candidate functions and lifted 67.5%; the fixed code type-checks with no new errors, and Effect's own 6,233 tests pass on its lifted source. The [case studies](https://bombadil-labs.github.io/hermetic/) go through each library: what was marked, lifted and skipped, and why. The [rule's documentation](https://github.com/bombadil-labs/hermetic/blob/main/packages/eslint-plugin-hermetic/docs/rules/prefer-hermetic.md) lists what it skips, what changes (a stack frame, `toString`, a per-call cost), and how it decides.

The lift has an exact inverse, `unlift`, which turns each wrapper back into the original function, so the source can stay hermetic while a build runs the original code. On the corpus, unlifting the lifted code gives back the original program in every file, and Effect's benchmarks go from 14–55% slower when lifted to within noise of the original when unlifted. `unlift` isn't part of the published package yet; a bundler plugin that runs it on production builds is next. See [unlifting at build time](https://github.com/bombadil-labs/hermetic/blob/main/packages/eslint-plugin-hermetic/docs/rules/prefer-hermetic.md#unlifting-at-build-time).

## What hermetic functions don't give you

The rules check names. They don't make a function pure, and they don't make it a sandbox: a function can still reach the program's shared built-ins through the prototype chain of any value, as in `({}).__proto__.hasOwnProperty = () => true`. To run a function you don't trust, use `confine` from [`@bombadil/hermetic`](https://github.com/bombadil-labs/hermetic/tree/main/packages/hermetic#confine). The [repository's README](https://github.com/bombadil-labs/hermetic#what-hermetic-functions-dont-give-you) covers these limits.

## License

[MIT](LICENSE)
