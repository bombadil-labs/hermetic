# hermetic/prefer-hermetic

Mark functions that are already hermetic, and optionally split the rest into a hermetic core and a binding.

`hermetic/sealed` keeps marked functions hermetic. This rule finds the functions to mark. Its fixes are meant to run once over a whole codebase, with `--fix`, and to preserve behavior.

## Rule details

The rule considers the outermost functions bound to a name: function declarations, variable initializers, and object and class members. Callbacks passed as arguments and IIFEs are left alone. Functions that are already marked are skipped.

- **`alreadyHermetic`**: the function would pass `hermetic/sealed` as it stands. The fix marks it. A block body gets `"use hermetic"` straight after its opening brace, so comments such as `// @ts-expect-error` stay with the statements they precede. An expression-bodied arrow gets an `@hermetic` tag, added to its JSDoc block if it has one.
- **`liftable`**, with `lift: true`: the function reaches outside itself only for module bindings and globals. The fix lifts them into a context: the body moves into a hermetic core that reads them from `this`, and the original name becomes a binding that calls the core with them.

With `lift: true`, this module:

```ts
import * as units from "./units";
import { audit } from "./audit";

let discounts = 0;

export function round(amount: number) {
  return Math.round(amount);
}

/** Converts dollars to whole cents. */
export function toCents(dollars: number) {
  return round(units.centsPerDollar * dollars);
}

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

export function round(amount: number) {
  "use hermetic";
  return Math.round(amount);
}

/** Converts dollars to whole cents. */
export function toCents(dollars: number) {
  return toCentsHermetic.call({ round, units }, dollars);
}

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

`round` was already hermetic, so it is marked. `toCents` and `discount` are lifted. `report` is left alone for the reason given under [what the lift leaves alone](#what-the-lift-leaves-alone).

### The binding and the core

The binding keeps the function's name, type parameters, parameters, defaults, return type, export and JSDoc, so callers do not change. The core follows it: a function declaration named after it, with the same body and the lifted names read from `this`, typed by a `this` parameter.

The binding passes the context in one of two forms:

- **Directly**, as in `toCents`, when every lifted value is *settled*: initialized, and never reassigned, whenever the binding can run. Function declarations and namespace imports are always settled. So are constants and classes declared above a binding that does not hoist.
- **Through a shared context**, as in `discount`, otherwise. The context is one object, created right after the binding, whose getters read each binding when the core does, and whose setters write assignments back. A binding that does not hoist cannot run before its own statement, and the context statement comes next, so the context always exists when the binding runs.

A function declaration hoists. It can run before any statement of its module, and in an import cycle before its imports are initialized. So a declaration is lifted only when its context can be passed directly.

### What the lift leaves alone

The fix only applies when the split cannot change behavior or types. It skips:

- Functions that use their own `this`, `arguments`, `new.target` or `super`, or use `import.meta`, `import()` or JSX.
- Functions that reach a lifted name from a nested `function` or class, where `this` is rebound.
- Writes to constants, imports and globals.
- Function declarations that read anything unsettled: named imports, module constants, globals or mutable state, like `report` above.
- Named function expressions, declarations with several declarators, and variables with a type annotation, such as `const f: Handler = ...`, whose function is typed from the annotation.
- Functions inside other functions, blocks or classes.
- `this` parameters, `asserts` return types, and `@ts-expect-error`, `@ts-ignore` or `@ts-nocheck` comments, whose target lines would move.
- Signatures TypeScript cannot repeat faithfully: a rest parameter in a generic function typed as anything but a type parameter, an array or a tuple, and a mapped type with an `as` clause written into the signature.
- Functions that read the stack, through `.stack`, `Error.captureStackTrace`, `Error.prepareStackTrace` or `Error.stackTraceLimit`. The split adds a frame.
- Defaults that read a destructured parameter, and defaults that call a function. The binding and the core both keep each default, and the core's runs again whenever the binding's produced `undefined`.
- Everything, under `types: "structural-only"`: the generated `this` type refers to module declarations.

### What changes

- **The stack has one more frame.** Code that finds its caller by counting frames, in the function or anything it calls, sees the binding.
- **`toString()`** of the public function returns the binding. The body is in the core.
- **Lifted functions receive the context as `this`.** The core calls `this.round(...)` where the original called `round(...)`, so `round` runs with the context as `this` instead of `undefined`. Functions that ignore `this`, which is nearly all module functions, are unaffected.
- **Host functions called bare are bound to `globalThis`**, so that calls such as `this.fetch(url)` keep their receiver. Each read returns a new bound function.
- **Async functions and generators** become plain functions that return the core's promise or iterator.
- **Each call costs one more call and some property reads.** In microbenchmarks of Effect's hottest paths (collections, the fiber runtime, Schema decoding), the lifted library ran 15 to 70 percent slower. The cost is per call, so it matters where calls are cheap and frequent. [Unlifting](#unlifting-at-build-time) removes it from builds.
- **Formatting and ordering.** The fix emits plain formatting, so run your formatter afterwards. The binding refers to its context and core, which are declared after it, and `no-use-before-define` reports that unless its `functions` and `variables` options are off.

### Unlifting at build time

The lift has an exact inverse. `unlift` turns each binding back into the function it came from: the core's parameters and body return to the binding, each `this.name` reads `name` again, and the core and its context are removed. The result carries no directive, since it is no longer hermetic. Source stays hermetic, checked and testable, while a build ships the original code and none of the costs above.

It folds a binding back only where that is exact: the core is used by its binding alone, reads `this` only through the names its context provides, and none of those names is shadowed where the core reads it. A core that tests import, or that someone has edited out of the lift's shape, stays as it is and is reported.

On the corpus, unlifting the lifted code gives back the marked original in every file: the same syntax tree once types are erased, with every comment in place, apart from the equivalences the lift cannot record (`=> { return x; }` and `=> x`, `{ x: x }` and `{ x }`, and parenthesization). The round trip adds no type errors. Effect's 6,233 tests pass on its unlifted source, and its benchmarks run within noise of the original:

| Workload | Lifted | Unlifted |
| --- | --- | --- |
| `Effect.gen` with `map` and `flatMap` | +24% | −1% |
| `Chunk`, `HashMap`, `Option` | +68% | +1% |
| `Schema` decoding | +51% | +3% |

`npm run corpus -- roundtrip`, `npm run corpus -- effect --unlift` and `npm run corpus -- bench` reproduce these. `unlift` lives in [`src/unlift.ts`](../../src/unlift.ts) and is not exported yet: a bundler plugin that applies it to production builds comes next.

## Options

```ts
type Options = {
  lift?: boolean; // default false
  types?: "allow" | "structural-only"; // default "allow"
  ground?: string;
  aliasing?: "best-effort" | "forbid"; // default "best-effort"
};
```

- **`lift`**: also fix functions whose only outside inputs are module bindings and globals, as described above.
- **`types`**, **`ground`**, **`aliasing`**: the same as for [`hermetic/sealed`](sealed.md#options), so that "already hermetic" means what `sealed` will enforce. Both rules also read these from `settings.hermetic`, which is the simplest way to keep them in step.

## Making a codebase hermetic

```sh
npx eslint --fix --rule '{"hermetic/prefer-hermetic": ["warn", {"lift": true}]}' src/
```

Then turn on `hermetic/sealed`, which the recommended config does, so the marked functions stay hermetic.

On a corpus of 5,315 candidate functions from Effect, RxJS and TanStack Query, 22.8% were already hermetic and 46.1% were lifted. The remaining 31.1% were left for a person, among them methods that use `this`, React components, and RxJS operators declared as functions that read named imports. The fixed code parses, passes `hermetic/sealed`, is unchanged by a second `--fix`, and type-checks with no new errors. Effect's own 6,233 tests pass on its lifted source. `npm run corpus` in this repository reproduces these numbers.

## When not to use it

Leave `lift` off where every call counts, and in code whose job is to reach ambient authority, such as a binding layer or an entry point. Marking alone never changes behavior.
