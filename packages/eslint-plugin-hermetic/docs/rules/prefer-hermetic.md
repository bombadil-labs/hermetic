# hermetic/prefer-hermetic

Mark functions that are already hermetic, and optionally rewrite others so they are.

`hermetic/sealed` keeps marked functions hermetic. This rule finds the functions to mark. Its fixes are meant to run once over a whole codebase, with `--fix`, and to preserve behavior.

## Rule details

The rule considers the outermost functions bound to a name: function declarations, variable initializers, and functions stored in object properties. Methods can't be hermetic yet, so they aren't considered. Callbacks passed as arguments and IIFEs are ignored, and so are functions that are already marked.

- **`alreadyHermetic`**: the function would pass `hermetic/sealed` as it stands. The fix marks it. A block body gets `"use hermetic"` straight after its opening brace, so comments such as `// @ts-expect-error` stay with the statements they precede. An expression-bodied arrow gets an `@hermetic` tag, added to its JSDoc block if it has one.
- **`liftable`**, with `lift: true`: the function's only hidden inputs are module-level values and globals, built-ins such as `Math` included. The fix moves the body into a new hermetic function that reads them from `this`, and turns the original function into a wrapper that calls it with them.

With `lift: true`, this module:

```ts
import * as units from "./units";
import { audit } from "./audit";

let discounts = 0;

export function half(amount: number) {
  return amount / 2;
}

export const round = (amount: number) => Math.round(amount);

/** Converts dollars to whole cents. */
export const toCents = (dollars: number) => round(units.centsPerDollar * dollars);

export const discount = (dollars: number, rate = 0.2) => {
  discounts++;
  return toCents(dollars * (1 - rate));
};

export function report(dollars: number) {
  audit(dollars);
}
```

becomes:

```ts
import * as units from "./units";
import { audit } from "./audit";

let discounts = 0;

export function half(amount: number) {
  "use hermetic";
  return amount / 2;
}

export const round = (amount: number) => roundHermetic.call(roundContext, amount);

const roundContext = new (class {
  get Math(): typeof Math { return Math; }
})();

function roundHermetic(this: { Math: typeof Math }, amount: number) {
  "use hermetic";
  return this.Math.round(amount);
}

/** Converts dollars to whole cents. */
export const toCents = (dollars: number) => toCentsHermetic.call({ round, units }, dollars);

function toCentsHermetic(this: { round: typeof round; units: typeof units }, dollars: number) {
  "use hermetic";
  return this.round(this.units.centsPerDollar * dollars);
}

export const discount = (dollars: number, rate = 0.2) => discountHermetic.call(discountContext, dollars, rate);

const discountContext = new (class {
  get discounts(): typeof discounts { return discounts; }
  set discounts(value: typeof discounts) { discounts = value; }
  get toCents(): typeof toCents { return toCents; }
})();

function discountHermetic(this: { discounts: typeof discounts; toCents: typeof toCents }, dollars: number, rate = 0.2) {
  "use hermetic";
  this.discounts++;
  return this.toCents(dollars * (1 - rate));
}

export function report(dollars: number) {
  audit(dollars);
}
```

`half` was already hermetic, so it is marked. `round`, `toCents` and `discount` are lifted. `round` reads the global `Math`, and a hermetic function reads no globals, so `Math` is passed in like any other hidden input. `report` is skipped, for the reason given under [what the lift skips](#what-the-lift-skips).

### The wrapper and the hermetic function

The wrapper keeps the function's name, type parameters, parameters, defaults, return type, export and JSDoc, so callers don't change. The new hermetic function follows it: a function declaration named after it, such as `toCentsHermetic`, with the same body, reading the lifted names from `this`, which a `this` parameter types.

The wrapper passes `this` in one of two forms:

- **Directly**, as in `toCents`, when every lifted value is *settled*: initialized whenever the wrapper can run, and never reassigned. Function declarations and namespace imports are always settled, and so are constants and classes declared above a wrapper that isn't hoisted. With the [`importsSettled`](#options) option, named imports count as settled too.
- **Through a shared context object**, as in `round` and `discount`, otherwise. Globals always go this way, since other code can replace or remove them. The object is created once, right after the wrapper. Its getters read each value when the hermetic function does, and its setters write assignments back. A wrapper that isn't hoisted can't run before its own statement, and the context object's statement comes right after it, so the object always exists when the wrapper runs. The object is an instance of a class, because V8 keeps an object literal with getters in dictionary mode, where each read costs several times as much.

A function declaration is hoisted. It can run before any statement of its module, and in an import cycle, before its imports are initialized. So a declaration is only lifted when its values can be passed directly, which for a declaration that reads named imports takes `importsSettled`.

### What the lift skips

The fix only applies when the rewrite can't change behavior or types. It skips:

- Functions that use their own `this`, `arguments`, `new.target` or `super`, or use `import.meta`, `import()` or JSX.
- Functions that use a lifted name inside a nested `function` or class, where `this` means something else.
- Writes to constants, imports and globals.
- A direct call to `eval`, which sees the caller's scope. Called through `this`, it wouldn't.
- Function declarations that read anything unsettled: named imports unless `importsSettled` is on, module constants, globals or mutable state, like `report` above.
- Named function expressions, declarations with several declarators, and variables with a type annotation, such as `const f: Handler = ...`, whose function takes its type from the annotation.
- Functions inside other functions, blocks or classes.
- `this` parameters, `asserts` return types, and `@ts-expect-error`, `@ts-ignore` or `@ts-nocheck` comments, whose target lines would move.
- Signatures TypeScript can't repeat faithfully: a rest parameter in a generic function typed as anything but a type parameter, an array or a tuple, and a mapped type with an `as` clause written into the signature.
- Functions that read the stack, through `.stack`, `Error.captureStackTrace`, `Error.prepareStackTrace` or `Error.stackTraceLimit`. The rewrite adds a stack frame.
- Defaults that read a destructured parameter, and defaults that call a function. The wrapper and the hermetic function both keep each default, and the hermetic function's default runs again whenever the wrapper's produced `undefined`.
- Everything, under `types: "structural-only"`: the generated `this` type refers to module declarations.

### What changes

- **The stack has one more frame.** Code that finds its caller by counting frames, in the function or anything it calls, sees the wrapper.
- **`toString()`** of the public function returns the wrapper. The body is in the hermetic function.
- **The wrapper calls the hermetic function with `.call`**, so the lifted code depends on `Function.prototype.call`, which the original didn't. The lift assumes nothing replaces it. Replacing it would break most JavaScript anyway.
- **Functions called through `this` receive it as their `this`.** The hermetic function calls `this.round(...)` where the original called `round(...)`, so `round` runs with the context object as `this` instead of `undefined`. Functions that ignore `this`, which is nearly all module functions, are unaffected.
- **A global function called without a receiver is still called without one.** The hermetic function calls `fetch(url)` as `(0, this.fetch)(url)`, so `fetch` still gets `undefined` as its `this`. ECMAScript's own functions ignore their receiver, so `Number(x)` becomes `this.Number(x)`.
- **Async functions and generators** become plain functions that return the hermetic function's promise or iterator.
- **Each call costs one more call and some property reads.** In microbenchmarks of Effect's hottest paths (collections, the fiber runtime, Schema decoding), the lifted library ran 13 to 54 percent slower. The cost is per call, so it matters where calls are cheap and frequent. [Unlifting](#unlifting-at-build-time) removes it from builds.
- **Formatting and ordering.** The fix emits plain formatting, so run your formatter afterwards. The wrapper refers to its context object and hermetic function, which are declared after it, and `no-use-before-define` reports that unless its `functions` and `variables` options are off.

### Why a wrapper, not a bound function

Binding the hermetic function to its context, as `fn.bind({ ... })`, would drop the wrapper's extra call, and needs no restated signature. `npm run corpus -- bind` tries it on the corpus: it rebinds 2,450 of the 2,498 lifted functions. Function declarations keep their wrapper, since a `const` can't run before its own line. Effect's 6,233 tests still pass, but binding recovers little of the cost, and the types don't survive:

| Workload | Lifted | Bound | Original again |
| --- | --- | --- | --- |
| `Effect.gen` with `map` and `flatMap` | +6% | −8% | −4% |
| `Chunk`, `HashMap`, `Option` | +42% | +24% | −9% |
| `Schema` decoding | +47% | +51% | −5% |

The bound corpus has 904 new type errors: generics that collapse to `unknown`, types inferred in a circle between bindings and the functions they bind, and type predicates and overloads, which TypeScript can't carry through a bound function. So the lift writes a wrapper that restates the signature, and [unlifting](#unlifting-at-build-time) removes the cost instead.

### Unlifting at build time

The lift has an exact inverse. `unlift` turns each wrapper back into the original function: the hermetic function's parameters and body return to the wrapper, each `this.name` reads `name` again, and the hermetic function and its context object are removed. The result carries no directive, since it is no longer hermetic. The source can stay hermetic, checked and testable, while a build runs the original code, without the costs above.

It only turns a wrapper back where that is exact: the hermetic function is used by its wrapper alone, reads `this` only through the names its context provides, and none of those names is shadowed where the hermetic function reads it. A hermetic function that tests import, or that someone has edited out of the lift's shape, stays as it is and is reported.

On the corpus, unlifting the lifted code gives back the marked original in every file: the same syntax tree once types are erased, with every comment in place, apart from the equivalences the lift cannot record (`=> { return x; }` and `=> x`, `{ x: x }` and `{ x }`, and parenthesization). The round trip adds no type errors. Effect's 6,233 tests pass on its unlifted source, and its benchmarks run within noise of the original. Times are relative to Effect's own source; the last column is a second, untouched copy of it, timed the same way, so it shows the noise:

| Workload | Lifted | Unlifted | Original again |
| --- | --- | --- | --- |
| `Effect.gen` with `map` and `flatMap` | +13% | 0% | +1% |
| `Chunk`, `HashMap`, `Option` | +54% | +1% | 0% |
| `Schema` decoding | +17% | −2% | −3% |

`npm run corpus -- roundtrip`, `npm run corpus -- effect --unlift` and `npm run corpus -- bench` reproduce these, and the [Effect case study](https://bombadil-labs.github.io/hermetic/case-studies/effect.html) has the full story.

In a Vite build, `unliftPlugin` unlifts each module as the build reads it:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { unliftPlugin } from "@bombadil/eslint-plugin-hermetic/unlift";

export default defineConfig({
  plugins: [unliftPlugin()],
});
```

It runs before Vite's other transforms, on the source as written, and only in builds, so the dev server and tests run the lifted source. It returns a source map, so an error in an unlifted function points to its line in the lifted source. A wrapper it can't turn back stays lifted, and the build prints a warning that says why. By default it unlifts JavaScript and TypeScript modules outside `node_modules`; its `include` and `exclude` options take regular expressions that match module ids. The plugin uses only the part of Vite's plugin interface that Rolldown and Rollup share, so it can go in their `plugins` too.

This repository's tests build a small library for production twice: once from its source, and once from its lifted source with the plugin. The two bundles are identical, byte for byte.

For another build tool, call `unlift` on each module's source:

```ts
import { unlift } from "@bombadil/eslint-plugin-hermetic/unlift";

const { code, map, unlifted, skipped } = unlift(source, "src/pricing.ts", { sourceMap: true });
```

The file name is the source's name in the map, and decides how the module is parsed: as TypeScript, with JSX unless the name ends in `.ts`, `.mts` or `.cts`. `unlifted` lists the wrappers turned back, and `skipped` the ones left lifted, each with a reason.

## Options

```ts
type Options = {
  lift?: boolean; // default false
  importsSettled?: boolean; // default false
  types?: "allow" | "structural-only"; // default "allow"
};
```

- **`lift`**: also rewrite functions whose only hidden inputs are module-level values and globals, as described above.
- **`importsSettled`**: with `lift`, treat named imports as settled: initialized before any function that reads them runs, and unchanged while it runs. Wrappers then pass imports directly, and function declarations that read imports, such as RxJS's operators, can be lifted. Turn it on only if no import cycle can call a function before its imports are initialized, and no exported `let` is reassigned while a function that reads it runs; in those two cases the lifted function reads a value the original wouldn't have. The [RxJS case study](https://bombadil-labs.github.io/hermetic/case-studies/rxjs.html#what-treating-imports-as-initialized-would-change) counts what it changes.
- **`types`**: the same as for [`hermetic/sealed`](sealed.md#options), so that "already hermetic" means what `sealed` will enforce. Both rules also read it from `settings.hermetic`, which is the simplest way to keep them in step.

## Making a codebase hermetic

```sh
npx eslint --fix --rule '{"hermetic/prefer-hermetic": ["warn", {"lift": true}]}' src/
```

Then turn on `hermetic/sealed`, which the recommended config does, so the marked functions stay hermetic.

On a corpus of 3,703 candidate functions from Effect, RxJS and TanStack Query, 15.0% were already hermetic and 67.5% were lifted. The remaining 17.5% were skipped, among them function declarations that read named imports or globals, such as RxJS's operators, and React components. Methods aren't candidates, since they can't be hermetic yet. The fixed code parses, passes `hermetic/sealed`, is unchanged by a second `--fix`, and type-checks with no new errors. Effect's own 6,233 tests pass on its lifted source. `npm run corpus` in this repository reproduces these numbers.

## When not to use it

Leave `lift` off where every call counts, and in code whose job is to reach the outside world, such as an entry point, or the code that binds dependencies to hermetic functions. Marking alone never changes behavior.
