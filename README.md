# hermetic

**A hermetic function depends only on what it is handed: its arguments, `this`, and a small, explicitly configured *ground* of harmless globals.** The name comes from hermetic builds, which depend only on their declared inputs, and that is what makes them cacheable and runnable anywhere. A hermetic function is not a pure function. It may mutate and cause effects, but only through what it was handed. This plugin enforces the idea with `hermetic/sealed`, and `hermetic/prefer-hermetic` finds the functions to mark, or splits them so that they can be.

```ts
function applyDiscount(this: PricingCtx, invoice: Invoice): Invoice {
  "use hermetic";
  return { ...invoice, total: this.clamp(invoice.total * (1 - this.rate)) };
}
```

Purity is unenforceable in JavaScript: any argument can be a Proxy, or carry a getter that does I/O. Hermeticity is decidable. "No free variables" is a syntactic check that ESLint's scope analysis already computes. So a codebase can put as much logic as possible into hermetic functions, and grant authority in a thin binding layer where `this` and arguments are applied.

A hermetic function's whole world arrives through two doors, so anything standing at those doors sees everything:

- **Relocation.** A hermetic function can move to another file, worker or realm unchanged. The acid test: `new Function("return " + fn.toString())()` behaves identically to `fn`. This repository's tests run that test on the examples.
- **Mocking, tracing, record/replay.** Wrap `this` in a Proxy and you have a complete log of every effect the function can have, with no instrumentation inside it.
- **Authority audits.** Every grant lives in the binding layer, so "what can touch Stripe?" is answered by reading the wiring.
- **Context-complete units.** Arguments, `this` type and body are everything an agent or reviewer needs to edit the function. The rule guards generated code as well as handwritten code.

## Install

```sh
npm install --save-dev @bombadil/hermetic
```

Requires Node 22.13+ or 24+. Peer dependencies: `eslint` 9 or 10, and `@typescript-eslint/parser` 8.

```js
// eslint.config.js
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import hermetic from "@bombadil/hermetic";

export default defineConfig(
  ...tseslint.configs.recommended,
  hermetic.configs.recommended,
);
```

`hermetic/sealed` checks only functions marked hermetic, so enabling it everywhere is safe. Both rules also work on plain JavaScript through ESLint's default parser.

| Rule | What it does | Fix |
| --- | --- | --- |
| [`hermetic/sealed`](docs/rules/sealed.md) | Reports everything a marked function reaches outside itself. In the recommended config. | |
| [`hermetic/prefer-hermetic`](docs/rules/prefer-hermetic.md) | Reports functions that are already hermetic, and with `lift`, functions that can be split into a hermetic core and a binding. | Marks, or splits in place |

## Marking a function

Put a `"use hermetic"` directive at the top of the body:

```ts
function total(invoices: Invoice[]) {
  "use hermetic";
  return invoices.reduce((sum, invoice) => sum + invoice.total, 0);
}
```

The directive survives TypeScript and esbuild, and appears in `fn.toString()`, so runtime tools can recognize hermetic functions without a registry. **terser strips unknown directives by default.** Set `compress: { directives: false }` if production code needs to keep them.

A JSDoc `@hermetic` tag at the start of a line also marks a function. It works on expression-bodied arrows, which cannot hold a directive, but it does not reach runtime:

```ts
/** @hermetic */
export const cents = (n: number) => Math.round(n * 100);
```

Both forms apply to function declarations, function expressions, arrow functions, and object and class methods.

## What the rule reports

`hermetic/sealed` reports every reference that escapes a marked function and is not in the ground, plus the syntactic escapes that scope analysis cannot see:

| Reported | Example | Why |
| --- | --- | --- |
| Free variables | `return a * RATE;` | A hidden input. Includes imports, other hermetic functions, and `typeof window`. |
| Ground names bound locally | `import { JSON } from "./json"` | The name refers to your binding, not the global. |
| Assignments to ground names | `Math = …` | The ground is readable, not reassignable. |
| Denied member paths | `Math.random()`, `const { random } = Math` | Denied by the ground. See [the ground](#the-ground). |
| `this` or `new.target` in a hermetic arrow | `() => { "use hermetic"; return this.x; }` | Arrow `this` is lexical, so it comes from outside. |
| `super` | `super.method()` | It reaches the enclosing home object. |
| `import.meta`, `import()` | `import.meta.url` | Module scope, and code loading. |
| JSX | `return <div />;` | Compiles to a call to the JSX factory, which is a free variable. |

The diagnostic says what to do:

```
'taxRate' is a free variable in hermetic function 'applyDiscount'. Pass it through 'this' or an argument.
```

**Allowed:** parameters, locals, `arguments`, `this` in non-arrow functions, literals, ground names and member access on them, calling a callback passed in as an argument (the authority was handed over), and a function declaration calling itself by name. The last one survives relocation because the round trip turns the declaration into a named function expression, which binds its own name. Reassign the binding and it is reported again.

Nested functions may close over the hermetic function's own locals. Only references that escape the marked function are checked.

**Hermeticity is not transitive.** A call to another hermetic function is still a free variable. Compose through `this`:

```ts
export function checkout(this: { price: (invoice: Invoice) => Invoice }, invoices: Invoice[]) {
  "use hermetic";
  return invoices.reduce((sum, invoice) => sum + this.price(invoice).total, 0);
}
```

## The ground

The ground is the set of global names a hermetic function may assume, plus denied member paths inside them. The default:

| Category | Included | Excluded, and why |
| --- | --- | --- |
| Value globals | `undefined`, `NaN`, `Infinity` | |
| Data structures | `Array`, `Object`, `Map`, `Set`, `WeakMap`, `WeakSet`, `Symbol` | |
| Primitives | `Number`, `String`, `Boolean`, `BigInt`, `parseInt`, `parseFloat`, `isNaN`, `isFinite` | |
| Structured data | `JSON`, `RegExp`, `Promise`, the error constructors | |
| Math | `Math` | `Math.random` (nondeterministic) |
| Time | | `Date` (reads the clock) |
| Ambient authority | | `fetch`, `crypto`, `console`, timers, `process`, `globalThis`, `window`, `document` |
| Code loading | | `eval`, `Function` |
| Locale | | `Intl` (depends on host locale) |

Anything not listed is excluded, including deterministic intrinsics such as `Reflect`, typed arrays and `encodeURIComponent`. Add what you need in a bootstrap.

### Configuring the ground with a bootstrap

The ground is defined in code by a hermetic function that receives a realm and returns `{ allow, deny }`:

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

1. It lints the bootstrap with the rule itself, on the default ground, and refuses to load it unless it is marked hermetic and passes. Suppression comments are ignored here.
2. It erases the function's TypeScript syntax and evaluates its source text alone, in a fresh `node:vm` context with string compilation disabled and a one-second timeout. The lint is what makes this reasonable: the function touches nothing but the realm it is handed. A vm context is not a security boundary.
3. It reads the keys of `allow` and the paths in `deny`. Only keys matter to the linter.

The bootstrap is found as the export named `ground`, or else the default export. It may use TypeScript syntax that erases cleanly: annotations, `as`, `satisfies`, `!`, generics and local type declarations. Erasure keeps every line and column in place, so errors point into your file. Syntax that needs a compiler, such as enums and namespaces, is refused. [`examples/hermetic.ground.ts`](examples/hermetic.ground.ts) spells out the default ground, as a starting point to copy.

The same file can serve at runtime. The entry point calls `ground(globalThis)`, for example to build Compartment globals, so lint time and runtime share one definition of the ground. **Keep it a literal list.** At lint time, `realm` is a bare JavaScript realm, so a bootstrap that enumerates `realm` would see different names than it sees at runtime.

ESLint's `--cache` does not know about the bootstrap. Clear the cache after changing it.

### Denied paths and aliasing

Denied paths are checked through static member access (`Math.random`, `Math["random"]`, `Math?.random`, `(Math as any).random`) and destructuring (`const { random } = Math`, including nested patterns and parameter defaults).

Statically, they are best effort. `const m = Math; m.random()` evades the check. There are two ways to close the gap:

- Set `aliasing: "forbid"`. A ground object with denied members may then only be used in place: static member access, destructuring, `typeof`, calling or constructing it, and comparisons. Anything that could hand it elsewhere, such as `const m = Math`, `Math[key]` or `f(Math)`, is reported.
- Leave the whole object out of the ground, and inject what you need through `this`.

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
- **`ground`**. See [the ground](#the-ground).
- **`aliasing`**. See [denied paths and aliasing](#denied-paths-and-aliasing).

## The binding layer

TypeScript already types the binding. A `this` parameter is checked at every `.call`, `.apply` and `.bind`:

```ts
// binding layer: ordinary code, and the only place authority is granted
const pricing: PricingCtx = { rate: config.discountRate, clamp: clampToCents };
export const applyPricing = applyDiscount.bind(pricing); // (invoice: Invoice) => Invoice
```

`ThisParameterType<F>` extracts a context type, and `OmitThisParameter<F>` gives the bound signature. With `types: "structural-only"`, write the context type inline on the function and name it in the binding layer with `ThisParameterType<typeof applyDiscount>`. The function stays the source of truth for the authority it needs.

See [`examples/pricing.ts`](examples/pricing.ts) for a complete example.

## Making a codebase hermetic

`hermetic/prefer-hermetic` finds the functions that are hermetic already and marks them. With `lift`, it also splits functions whose only outside inputs are module bindings and globals: the body moves into a hermetic core, and the original name becomes a binding that hands the core those inputs.

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

The generated binding is the degenerate binding layer: it grants exactly what the function used to take from its surroundings. Callers do not change, and from there you can narrow the grants by hand. One command does the whole codebase:

```sh
npx eslint --fix --rule '{"hermetic/prefer-hermetic": ["warn", {"lift": true}]}' src/
```

The fix applies only where the split preserves behavior and types, and leaves the rest for a person. On Effect, RxJS and TanStack Query, it marked 22.8% of 5,315 candidate functions and lifted 46.1%, the fixed code type-checks with no new errors, and Effect's own 6,233 tests pass on its lifted source. The [rule's documentation](docs/rules/prefer-hermetic.md) lists what it skips, what changes (a stack frame, `toString`, a per-call cost), and how it decides.

The lift also has an exact inverse, `unlift`, which folds each binding back into the function it came from. Hermeticity can then work like types: checked in the source, erased in the build. On the corpus, unlifting the lifted code gives back the original program in every file, and Effect's benchmarks return from 24–68% slower to within noise of the original. A bundler plugin that applies it to production builds is next; see [unlifting at build time](docs/rules/prefer-hermetic.md#unlifting-at-build-time).

## What hermeticity does not give you

- **Purity.** A hermetic function can still do anything its arguments and `this` allow, and any of them can be a Proxy.
- **Confinement.** Intrinsics are reachable from literals: `[].constructor.constructor("return globalThis")()` reaches `Function`, and through it the global object, without a single free variable. Built-in prototypes are shared and mutable. The rule guards authors against accidental ambient dependencies. It does not sandbox code you did not write. That takes runtime enforcement, such as Hardened JS (`lockdown()`) with Compartments built from the same bootstrap.
- **Determinism by itself.** A hermetic function sees only its arguments, `this` and the ground, so, like a hermetic build, it behaves the same whenever those do. Hand it a clock or a random source through `this` and its results vary, but visibly, through a door you can watch. That is what makes record and replay possible.
- **Complete deny paths**, unless `aliasing: "forbid"` is set. See above.

## Status

| Milestone | Scope | State |
| --- | --- | --- |
| M1 | Core rule, static default ground, directive and JSDoc marking | Done |
| M2 | Bootstrap-configured ground via `node:vm`, self-linted before evaluation | Done |
| M3 | Denied member paths | Done |
| M4 | Doctest harness with the `toString` round trip | Next |
| M5 | Recording Proxy for `this`, replaying a captured call as a test | Next |
| | `hermetic/prefer-hermetic`: marking and lift fixes, validated on a corpus | Done |
| | `unlift`: the lift's exact inverse, validated by a round trip on the corpus | Done |
| | Bundler plugin that unlifts production builds | Next |

## Development

```sh
npm install
npm run check    # typecheck, lint, test
npm run build    # emit dist/
npm run corpus   # census, stress, fix and round trip on pinned open-source packages
```

`npm run corpus -- effect` also lifts Effect's own source in a checkout of its repository and runs its test suite on the result; add `--unlift` to lift and then unlift it first. `npm run corpus -- bench` times Effect workloads on its original, lifted and unlifted source. Both need git and pnpm.

Releases are published to npm from GitHub releases. [RELEASING.md](RELEASING.md) covers the one-time setup and each release.

Development needs Node 22.18 or later, because `eslint.config.js` loads the plugin's TypeScript source directly. The repository lints itself with the rule. The plugin's own pure helpers, such as the ground functions in [`src/ground/ground.ts`](src/ground/ground.ts), are marked `"use hermetic"`.

## License

[MIT](LICENSE)
