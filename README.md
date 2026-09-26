# hermetic

> [!NOTE]
> **Under development.** This README describes hermetic 0.3.0, which isn't released yet.

**A hermetic function reads nothing but its inputs: its arguments, including `this`.** It doesn't use imports, module-level variables or globals, not even built-ins such as `Math`; anything it needs has to be passed in. An ESLint plugin checks the functions you mark as hermetic, and rewrites existing functions so they can be. A runtime package checks a function from its source alone, and runs it confined. The name comes from hermetic builds, which likewise depend only on their declared inputs.

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

Every value a function reads is one of its inputs, whether or not it appears in the parameter list. A function that reads a module-level variable has an input its signature doesn't show. In a hermetic function, every input is an argument. `this` counts as an argument: an implicit first one, which `.call` passes explicitly and `.bind` fixes in advance. Binding `this` is partial application, which makes `this` a convenient place for dependencies. The essay [Thinking Like a Function](https://myk.pub/thinking-like-a-function-16) explains this way of looking at functions.

Built-ins are inputs too. `Math` and `JSON` are globals like `fetch` and `Date`: which ones exist, and what they do, depends on the runtime and on any code that replaced them. So a hermetic function doesn't name them either. The code that binds it passes in the ones it needs, and [`intrinsics`](packages/hermetic/README.md#intrinsics) picks the deterministic ones out of the runtime. `undefined`, `NaN` and `Infinity` can't be changed, so they read like keywords.

Hermetic doesn't mean pure. A hermetic function can change its inputs, or call methods on them that do I/O. Purity can't be checked in JavaScript, because any input can be a Proxy. Whether a function reads anything besides its inputs can be checked, with the same scope analysis ESLint uses to find undefined variables.

What you get:

- **Portable code.** The function's source is all of its behavior, so it runs the same in another file, a worker or a sandbox: `new Function("return " + fn.toString())()` behaves exactly like `fn`. This repository's tests check that on the examples, and `confine` runs a function's source in a Hardened JS compartment.
- **Tests without module mocks.** Pass test values as inputs. Wrap `this` in a Proxy to record every use of the dependencies the function was given.
- **Dependencies you can find.** To find out which functions can call Stripe, look at the code that passes the Stripe client in.
- **Self-contained changes.** A function's inputs, the type of `this` and its body are everything a person or an agent needs to read before changing it. The rule checks generated code the same way as handwritten code.

## Terms

- **Inputs**: a function's arguments, including `this`. `this` is an implicit first argument: `.call` passes it explicitly, and `.bind` fixes it in advance.
- **Hidden input**: a value a function reads that isn't one of its inputs, such as an import, a module-level variable or a global, built-ins included. `hermetic/sealed` reports hidden inputs in hermetic functions.
- **Environment**: an object that the code binding hermetic functions passes in as `this`. Only the root environment is built from the runtime's globals; the others are built from it, adding and replacing values. Each is frozen, so no function can change what another gets. [Passing things in](packages/hermetic/README.md#passing-things-in) covers the pattern.
- **Lift**: the `lift` fix of `hermetic/prefer-hermetic`. It moves a function's body into a new hermetic function that receives the function's hidden inputs through `this`, and turns the original function into a wrapper.
- **Wrapper**: the original function after a lift. It keeps its name, signature and export, and calls the hermetic function with the values it needs.
- **Settled**: a module-level name that is initialized before a wrapper can run, and never reassigned. A wrapper passes settled values directly, and everything else through a shared context object.
- **Unlift**: the exact inverse of the lift. It turns each wrapper back into the original function. `unliftPlugin` does it in production builds.

## Two packages

| Package | What it does |
| --- | --- |
| [`@bombadil/eslint-plugin-hermetic`](packages/eslint-plugin-hermetic) | ESLint rules. `hermetic/sealed` checks the functions you mark as hermetic, and `hermetic/prefer-hermetic` finds functions that already are, and rewrites others so they can be. |
| [`@bombadil/hermetic`](packages/hermetic) | The same check at runtime, with no ESLint. `check` reads a function's source and reports what it reads besides its inputs, `confine` runs a hermetic function in a [Hardened JS](https://hardenedjs.org/) compartment, and `intrinsics` picks the deterministic built-ins out of the runtime, to pass in. `inject`, if you want it, binds a function to exactly the names it reads. |

The plugin lints in your editor and CI:

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

Where a function arrives as source, from storage, another process or another person, check it, or run it confined:

```ts
import { check, confine, intrinsics } from "@bombadil/hermetic";

check(source); // { form, marked, hermetic, problems: [{ kind, name, start, end }] }

// After the application imports ses and calls lockdown():
const fn = confine(source); // throws a HermeticError unless it is hermetic
fn.call(harden(intrinsics(globalThis)), input); // the built-ins it uses come in through this
```

`check` reports what `hermetic/sealed` reports. On the 14,416 functions and methods in the published JavaScript of Effect, RxJS and TanStack Query, the two report the same problems at the same places, every one.

Up to 0.2.0, `@bombadil/hermetic` was the ESLint plugin. From 0.3.0, its rules are in `@bombadil/eslint-plugin-hermetic`, hermetic functions read no globals, so the `ground` and `aliasing` settings are gone, and methods can't be hermetic yet.

The rules are documented in [the plugin's README](packages/eslint-plugin-hermetic): [marking a function](packages/eslint-plugin-hermetic/README.md#marking-a-function), [what the rule reports](packages/eslint-plugin-hermetic/README.md#what-the-rule-reports), [built-ins](packages/eslint-plugin-hermetic/README.md#built-ins-come-in-through-this), [options](packages/eslint-plugin-hermetic/README.md#options), [binding `this`](packages/eslint-plugin-hermetic/README.md#binding-this) and [making a codebase hermetic](packages/eslint-plugin-hermetic/README.md#making-a-codebase-hermetic).

## What hermetic functions don't give you

- **Purity.** A hermetic function can do anything its inputs allow, and any input can be a Proxy.
- **A sandbox, by itself.** Every value, even a literal, is connected to the program's shared built-ins through its prototype chain. A hermetic function can change them, as in `({}).__proto__.hasOwnProperty = () => true`, which changes `hasOwnProperty` for every object in the program, or reach the global object with `[].constructor.constructor("return globalThis")()`. The rule and `check` look at names, and these reach the built-ins through values. ESLint's own `no-proto` and `no-extend-native` rules catch the direct spellings, but not computed keys or `Object.getPrototypeOf`. For code you don't trust, use [`confine`](packages/hermetic/README.md#confine): it runs a function in a [Hardened JS](https://hardenedjs.org/) compartment, where the shared built-ins are frozen, so writes like these throw, and the global object is empty.
- **Determinism by itself.** A hermetic function sees only its inputs, so, like a hermetic build, it behaves the same whenever they are the same. Pass it a clock or a random source and its results vary, but through an input you can see and replace. That is what makes record and replay possible.
- **Hermetic methods, yet.** A method's `this` is its object, not its inputs, so methods, accessors and classes can't be hermetic for now. A function stored in an object's property can.

## Status

| Milestone | Scope | State |
| --- | --- | --- |
| M1 | Core rule, directive and JSDoc marking | Done |
| M2 | Allowed globals chosen by a bootstrap, run in `node:vm` after the rule lints it | Replaced in 0.3.0: no globals |
| M3 | Denied members | Replaced in 0.3.0: no globals |
| M4 | Doctest harness with the `toString` round trip | Next |
| M5 | Recording Proxy for `this`, replaying a captured call as a test | Next |
| | `hermetic/prefer-hermetic`: marking and lift fixes, validated on a corpus | Done |
| | `unlift`: the lift's exact inverse, validated by a round trip on the corpus | Done |
| | `check`: the same check at runtime, from a function's source, validated against the rule on the corpus | Done |
| | `confine`: running a hermetic function in a Hardened JS compartment | Done |
| | No globals: built-ins come in through `this`, and `intrinsics` picks them out of a runtime | Done |
| | Hermetic methods | Later |
| | `unliftPlugin`: unlifts Vite builds, with source maps into the lifted source | Done |

## Development

```sh
npm install
npm run check    # typecheck, lint, test
npm run build    # emit each package's dist/
npm run corpus   # census, stress, fix, round trip and crosscheck on pinned open-source packages
```

The repository is an npm workspace with the two packages under [`packages/`](packages). The plugin depends on `@bombadil/hermetic`; in development, TypeScript, ESLint, Vitest and the corpus read its source directly, through the `@bombadil/source` export condition, so nothing needs building first.

`npm run corpus -- effect` also lifts Effect's own source in a checkout of its repository and runs its test suite on the result; add `--unlift` to lift and then unlift it first. `npm run corpus -- bench` times Effect workloads on its original, lifted and unlifted source, and on a second copy of the original that shows the noise. Both need git and pnpm.

`npm run corpus -- crosscheck` checks every function in the packages' published JavaScript with both `hermetic/sealed` and `check`, and compares what they report. `npm run corpus -- report` gathers all of it into `site/data/corpus.json`, and `npm run site` builds the [site](https://bombadil-labs.github.io/hermetic/) from that into `_site/`; every number on its pages comes from the report. `npm run corpus -- records` writes what happened to every function in the corpus to `.corpus/results/records.json`, for looking one up.

Both packages are released together, at one version, from GitHub releases. [RELEASING.md](RELEASING.md) covers the one-time setup and each release.

Development needs Node 22.18 or later, because `eslint.config.js` loads the plugin's TypeScript source directly. The repository lints itself with the rule: its own hermetic functions are marked `"use hermetic"`, such as `intrinsics` in [`packages/hermetic/src/intrinsics.ts`](packages/hermetic/src/intrinsics.ts), and `checkHermetic` in [`packages/hermetic/src/check.ts`](packages/hermetic/src/check.ts), which also passes its own check.

## License

[MIT](LICENSE)
