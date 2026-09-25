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

const roundContext = {
  get Math(): typeof Math { return Math; },
};

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

const discountContext = {
  get discounts(): typeof discounts { return discounts; },
  set discounts(value: typeof discounts) { discounts = value; },
  get toCents(): typeof toCents { return toCents; },
};

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

- **Directly**, as in `toCents`, when every lifted value is *settled*: initialized whenever the wrapper can run, and never reassigned. Function declarations and namespace imports are always settled, and so are constants and classes declared above a wrapper that isn't hoisted.
- **Through a shared context object**, as in `round` and `discount`, otherwise. Globals always go this way, since other code can replace or remove them. The object is created once, right after the wrapper. Its getters read each value when the hermetic function does, and its setters write assignments back. A wrapper that isn't hoisted can't run before its own statement, and the context object's statement comes right after it, so the object always exists when the wrapper runs.

A function declaration is hoisted. It can run before any statement of its module, and in an import cycle, before its imports are initialized. So a declaration is only lifted when its values can be passed directly.

### What the lift skips

The fix only applies when the rewrite can't change behavior or types. It skips:

- Functions that use their own `this`, `arguments`, `new.target` or `super`, or use `import.meta`, `import()` or JSX.
- Functions that use a lifted name inside a nested `function` or class, where `this` means something else.
- Writes to constants, imports and globals.
- A direct call to `eval`, which sees the caller's scope. Called through `this`, it wouldn't.
- A host function, such as `fetch`, called without a receiver and also read as a value, as in `fetch.name`. The call needs a bound function, which has none of the original's own properties, and isn't the same value.
- Function declarations that read anything unsettled: named imports, module constants, globals or mutable state, like `report` above.
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
- **Functions called through `this` receive it as their `this`.** The hermetic function calls `this.round(...)` where the original called `round(...)`, so `round` runs with the context object as `this` instead of `undefined`. Functions that ignore `this`, which is nearly all module functions, are unaffected.
- **Host functions called without a receiver are bound to `globalThis`**, so that calls such as `this.fetch(url)` keep working. Each read returns a new bound function. ECMAScript's own functions, such as `Number` and `parseInt`, ignore their receiver, so they're passed as they are.
- **Async functions and generators** become plain functions that return the hermetic function's promise or iterator.
- **Each call costs one more call and some property reads.** In microbenchmarks of Effect's hottest paths (collections, the fiber runtime, Schema decoding), the lifted library ran 25 to 73 percent slower. The cost is per call, so it matters where calls are cheap and frequent. [Unlifting](#unlifting-at-build-time) removes it from builds.
- **Formatting and ordering.** The fix emits plain formatting, so run your formatter afterwards. The wrapper refers to its context object and hermetic function, which are declared after it, and `no-use-before-define` reports that unless its `functions` and `variables` options are off.

### Unlifting at build time

The lift has an exact inverse. `unlift` turns each wrapper back into the original function: the hermetic function's parameters and body return to the wrapper, each `this.name` reads `name` again, and the hermetic function and its context object are removed. The result carries no directive, since it is no longer hermetic. The source can stay hermetic, checked and testable, while a build runs the original code, without the costs above.

It only turns a wrapper back where that is exact: the hermetic function is used by its wrapper alone, reads `this` only through the names its context provides, and none of those names is shadowed where the hermetic function reads it. A hermetic function that tests import, or that someone has edited out of the lift's shape, stays as it is and is reported.

On the corpus, unlifting the lifted code gives back the marked original in every file: the same syntax tree once types are erased, with every comment in place, apart from the equivalences the lift cannot record (`=> { return x; }` and `=> x`, `{ x: x }` and `{ x }`, and parenthesization). The round trip adds no type errors. Effect's 6,233 tests pass on its unlifted source, and its benchmarks run within noise of the original. Times are relative to Effect's own source; the last column is a second, untouched copy of it, timed the same way, so it shows the noise:

| Workload | Lifted | Unlifted | Original again |
| --- | --- | --- | --- |
| `Effect.gen` with `map` and `flatMap` | +24% | +2% | −2% |
| `Chunk`, `HashMap`, `Option` | +71% | −1% | +6% |
| `Schema` decoding | +51% | −1% | 0% |

`npm run corpus -- roundtrip`, `npm run corpus -- effect --unlift` and `npm run corpus -- bench` reproduce these, and the [Effect case study](https://bombadil-labs.github.io/hermetic/case-studies/effect.html) has the full story. `unlift` lives in [`src/unlift.ts`](../../src/unlift.ts) and is not exported yet: a bundler plugin that applies it to production builds comes next.

## Options

```ts
type Options = {
  lift?: boolean; // default false
  types?: "allow" | "structural-only"; // default "allow"
};
```

- **`lift`**: also rewrite functions whose only hidden inputs are module-level values and globals, as described above.
- **`types`**: the same as for [`hermetic/sealed`](sealed.md#options), so that "already hermetic" means what `sealed` will enforce. Both rules also read it from `settings.hermetic`, which is the simplest way to keep them in step.

## Making a codebase hermetic

```sh
npx eslint --fix --rule '{"hermetic/prefer-hermetic": ["warn", {"lift": true}]}' src/
```

Then turn on `hermetic/sealed`, which the recommended config does, so the marked functions stay hermetic.

On a corpus of 5,315 candidate functions from Effect, RxJS and TanStack Query, 22.8% were already hermetic and 46.1% were lifted. The remaining 31.1% were skipped, among them methods that use `this`, React components, and RxJS operators declared as functions that read named imports. The fixed code parses, passes `hermetic/sealed`, is unchanged by a second `--fix`, and type-checks with no new errors. Effect's own 6,233 tests pass on its lifted source. `npm run corpus` in this repository reproduces these numbers.

## When not to use it

Leave `lift` off where every call counts, and in code whose job is to reach the outside world, such as an entry point, or the code that binds dependencies to hermetic functions. Marking alone never changes behavior.
