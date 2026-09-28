# @bombadil/hermetic

**A hermetic function reads nothing but its inputs: its arguments, including `this`.** It reads no globals, not even built-ins such as `Math`; the code that binds it passes in what it needs. This package works with hermetic functions at runtime, from their source, with no ESLint:

- `check` reads a function's source and reports everything it reads besides its inputs, and the names it reads from `this`.
- `confine` runs a hermetic function in a [Hardened JS](https://hardenedjs.org/) compartment whose global object is empty.
- `intrinsics` picks the deterministic built-ins out of a realm, for binding code to pass in.
- `inject`, which is optional and has its own entry point, binds a hermetic function to exactly the names it reads.
- `methods`, with its own entry point, builds a class out of hermetic functions, installed as its methods.
- `record` and `replay`, with their own entry point, capture everything a call does with its inputs and play it back as a test.
- `doctests`, with its own entry point, runs the examples in a hermetic function's JSDoc, against the function and against a copy made from its source.

The ESLint rules, which check functions as you write them and rewrite existing ones to be hermetic, are in [`@bombadil/eslint-plugin-hermetic`](https://www.npmjs.com/package/@bombadil/eslint-plugin-hermetic). The [repository's README](https://github.com/bombadil-labs/hermetic#readme) explains what hermetic functions are for.

```sh
npm install @bombadil/hermetic
```

Its one dependency is [acorn](https://github.com/acornjs/acorn), the JavaScript parser that ESLint also uses. `confine` also needs Hardened JS, which the application sets up; see [confine](#confine).

Up to 0.2.0, `@bombadil/hermetic` was the ESLint plugin. The rules are now in `@bombadil/eslint-plugin-hermetic`.

## check

```ts
import { check } from "@bombadil/hermetic";

check(`function applyDiscount(invoice) {
  "use hermetic";
  return { ...invoice, total: this.clamp(invoice.total * (1 - rate)) };
}`);
// {
//   form: "function",
//   marked: true,
//   hermetic: false,
//   problems: [{ kind: "freeVariable", name: "rate", start: 114, end: 118 }],
//   needs: ["clamp"],
// }
```

`check` takes a function, or its source as `Function.prototype.toString` returns it, so it works on functions that were stored or sent from somewhere else. It parses the source on its own and reports what the function reads besides its inputs:

| Kind | Example | Why |
| --- | --- | --- |
| `freeVariable` | `rate`, `Math` | A name that isn't declared in the function: an import, a module-level variable, or a global, built-ins included. `undefined`, `NaN` and `Infinity` read like keywords. |
| `lexicalThis`, `lexicalNewTarget` | `() => this.total` | An arrow function's `this` and `new.target` come from the enclosing scope, not from its inputs. So do those in a class's heritage clause and computed keys. |
| `superReference` | `() => super.save()` | It refers to the enclosing class or object. |
| `importMeta`, `dynamicImport` | `import.meta.url` | They refer to the enclosing module, or load code. |
| `withStatement` | `with (options) { … }` | It can turn any name inside it into a member of its object. |
| `privateName` | `this.#count` | A private name that a class outside the source declares. Only that class can use it, so the source can't be rebuilt or moved without it. |
| `syntax` | | The source doesn't parse. `name` holds the parser's message. |
| `notAFunction` | | The source isn't a single function, method, accessor or class. |

The result:

- **`form`**: `"function"` for a function or arrow function, including async functions and generators; `"method"` for a method or accessor, whose source looks like `area() { … }`; `"class"` for a class, whose source is also its constructor's. Anything else is refused, including source that holds a function followed by more code, so nothing can get past the check alongside a function.
- **`marked`**: the function's body starts with a `"use hermetic"` directive; for a class, its constructor's body. A JSDoc `@hermetic` tag comes before a function, not inside it, so it isn't part of the source and doesn't count here.
- **`hermetic`**: `check` found no problems. A method's inputs are its arguments and its object, as `this`. A class is read as one function, so it is hermetic when nothing in it reads anything from outside the class. `marked` and `hermetic` are separate: the directive says the function should be hermetic, and `check` tests whether it is.
- **`problems`**: in source order, with offsets into the source.
- **`needs`**: the names a function or method reads from `this`, whether as `this.clamp` or as `const { clamp } = this`, in the order it first reads them. For a hermetic function, that's everything it needs from the code that binds it. It's undefined when the function uses `this` in a way that doesn't name what it reads, as in `this[key]` or `helper(this)`, and for a class. An arrow function needs nothing, since its `this` isn't one of its inputs.

`check` reports what `hermetic/no-hidden-inputs` reports. On the 14,416 functions and methods, and the 371 classes, in the published JavaScript of Effect 3.22.2, RxJS 7.8.2 and TanStack Query 5.103.2, the two report the same problems at the same places, every one. `npm run corpus -- crosscheck` in the repository reproduces this.

Build tools can change what `check` sees:

- esbuild's `keepNames` option, which tsx turns on, adds a call to a `__name` helper for each named function nested inside a function. The helper is a hidden input, and `check` reports it as a free variable.
- terser removes directives it doesn't know by default, including `"use hermetic"`, so `marked` comes back false. Set `compress: { directives: false }` to keep them.

## Passing things in

A hermetic function reads no globals, so everything it uses comes in through `this` or its arguments, built-ins included. The code that binds hermetic functions builds those values. Call them an environment:

```ts
import { intrinsics } from "@bombadil/hermetic";

// The root environment: the only code that reads the realm.
const root = intrinsics(globalThis);

function toCents(this: { Math: { round(n: number): number } }, dollars: number) {
  "use hermetic";
  return this.Math.round(dollars * 100);
}

export const cents = toCents.bind(root);
```

A module can build its own environment from the root, adding values and replacing others. A test replaces values the same way:

```ts
const local = Object.freeze({ ...root, now: () => Date.now() });
const fixed = Object.freeze({ ...local, now: () => 0 });
```

Two rules keep this sound:

- **Freeze every environment**, or under Hardened JS, `harden` it. A hermetic function may change its inputs, so an environment bound to several functions would otherwise let one change what another gets. Replacing a value always makes a new environment.
- **Only the root reads the realm.** Everything else is built from it, so every value a hermetic function gets traces back to one place.

A replaced value is visible where it's bound, and TypeScript checks it against the function's `this` type. Neither the ESLint rules nor `check` need to know what a name means anywhere else, because a hermetic function names nothing outside itself.

Binding by hand, as above, is all a hermetic function needs. [`inject`](#inject) is an optional helper for the same job.

### intrinsics

`intrinsics(realm)` picks the deterministic built-ins out of `realm`:

| Category | Included | Left out, and why |
| --- | --- | --- |
| Data structures | `Array`, `Object`, `Map`, `Set`, `WeakMap`, `WeakSet`, `Symbol` | |
| Primitives | `Number`, `String`, `Boolean`, `BigInt`, `parseInt`, `parseFloat`, `isNaN`, `isFinite` | |
| Structured data | `JSON`, `RegExp`, `Promise`, the error constructors | |
| Math | `Math` | `Math.random` (nondeterministic) |
| Time | | `Date` (reads the clock) |
| I/O and host access | | `fetch`, `crypto`, `console`, timers, `process`, `globalThis`, `window`, `document` |
| Code loading | | `eval`, `Function` |
| Locale | | `Intl` (depends on the host's locale) |

Pass it `globalThis`, or under Hardened JS a new compartment's global object, whose clock and `Math.random` already throw. It freezes the object it returns, but the built-ins in it are only frozen under Hardened JS. It is itself hermetic.

### inject

`inject` is one way to do the binding, and an optional one, so it has its own entry point. It binds a hermetic function to a frozen object that holds exactly the names the function reads from `this`, taken from an environment that may hold more:

```ts
import { inject } from "@bombadil/hermetic/inject";

export const cents = inject(toCents, root); // toCents gets a frozen { Math }, and nothing else
```

- It reads each name from the environment once, when it binds.
- It throws a `HermeticError` when the function isn't hermetic, when `check` can't list its `needs`, or when the environment lacks one of them.
- In TypeScript, the result keeps the function's type parameters, and the environment is checked against the function's `this` type. An overloaded function keeps only its last signature, as it does with `bind`.

Any object can be the environment, so a DI container can supply one. Awilix's `container.cradle` works as it is: it reports its registrations as own properties, and `inject` resolves only the names the function reads. With a container that resolves by token, such as tsyringe or InversifyJS, resolve what the function needs into an object first.

## methods

A method's `this` is the object it's called on, one of its inputs, so a method can be hermetic: it reads nothing but its arguments and its object. `methods`, which has its own entry point, builds a class out of hermetic functions, each of which can still be tested alone:

```ts
import { methods } from "@bombadil/hermetic/methods";

function area(this: { width: number; height: number }) {
  "use hermetic";
  return this.width * this.height;
}

function summary(this: { area(): number }) {
  "use hermetic";
  return `area ${this.area()}`;
}

class Shape {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
}

export const Rect = methods(Shape, { area, summary });
new Rect(2, 3).summary(); // "area 6"

// In a test, any object with what a function reads will do.
area.call({ width: 2, height: 3 }); // 6
summary.call({ area: () => 7 }); // "area 7"
```

- **The class binds them.** `methods` puts each function on the class's prototype, as a class's own methods are: writable, configurable and not enumerable. It returns the class itself, typed with the new methods, and a class can extend it.
- **TypeScript checks each `this`.** A function's `this` type must accept an instance of the class with all the functions installed, so one can call another through `this`, as `summary` calls `area`. A function that needs what an instance doesn't have is a type error at its name.
- **Nothing is installed unless everything can be.** `methods` throws a `HermeticError` when a function isn't hermetic, or is a class, and a `TypeError` when the class already has a member of its own by one of the names. It checks every function before it installs any.
- **Calls on an instance record and replay.** `record(Rect.prototype.area, new Rect(2, 5), save)` records a call with the instance as `this`, and `replay(area, recording)` plays it back without the class.

A hermetic method can't use what only its class can reach: `super`, the class's private names such as `#count`, or the class by name. A method that uses a private name works only inside the class that declares it, so `check` reports it as a `privateName`.

A whole class can be hermetic too. Mark its constructor, and `check` reads everything in the class as one function, fields, static blocks and methods included. Its `super` and private names are then its own, since they are part of its source.

## confine

```ts
import "ses";
lockdown();

import { confine, intrinsics, type Intrinsics } from "@bombadil/hermetic";

const round = confine<(this: Pick<Intrinsics, "Math">, n: number) => number>(
  'function (n) { "use hermetic"; return this.Math.round(n) }',
);
round.call(harden(intrinsics(globalThis)), 2.6); // 3
```

`confine` checks a function, then evaluates its source in a new Hardened JS compartment whose global object is empty, and returns the function the compartment made, hardened. If the function isn't hermetic, it throws a `HermeticError` with the problems `check` found. Its generic parameter types the result when you pass source text. A method's source, such as `area() { … }`, and a class's work the same way.

`check` looks at the names a function uses. A function can also reach things through values, which a check of names can't follow, and the compartment covers those:

- **The shared built-ins are frozen.** Every value leads through its prototype chain to built-ins the whole program shares. In a compartment, `({}).__proto__.hasOwnProperty = () => true` throws, instead of changing `hasOwnProperty` for every object in the program.
- **Code can't be loaded through a constructor.** `[].constructor.constructor("return globalThis")()` throws.
- **The global object is empty and frozen,** and `this` doesn't reach it: a confined function called without a receiver gets `undefined`. Each `confine` makes a new compartment, which takes about 0.1 ms.

Whatever you pass to a confined function is still its to use and change, so harden what it shouldn't change, as above. A member you leave out stays out: `intrinsics` gives `Math` without `random`, so `this.Math.random()` fails however the function reaches for it.

### Setting up Hardened JS

`lockdown()` freezes the built-ins of the whole program, and can't be undone, so it is the application's decision. This package never calls it, and doesn't depend on `ses`. Install [`ses`](https://www.npmjs.com/package/ses), import it, and call `lockdown()` once at startup, after any polyfills. `confine` throws until you do. Code that changes built-ins after `lockdown()` throws too, so run your tests under it once to find any. MetaMask and Agoric run untrusted JavaScript this way in production.

### What confine can't evaluate

`confine` throws a `HermeticError` whose `problems` are empty, and whose `cause` is the compartment's error, when:

- **The source holds text Hardened JS rejects,** even inside a string or comment: `import(`, `<!--` or `-->`.
- **The function only works in sloppy mode.** Compartments run strict-mode code.
- **A method's computed key reads a global,** as in `*[Symbol.iterator]() { … }`. The key isn't part of the method, so `check` doesn't read it, but rebuilding the method evaluates it, where the global object is empty.

## record and replay

A hermetic function reads nothing but its inputs, so a call is described completely by what it was given and what it did with it. `record` captures that where the function runs for real, and `replay` turns it into a test that needs no mocks and no environment:

```ts
import { record, replay, type Recording } from "@bombadil/hermetic/record";

function applyDiscount(this: { rate: number; clamp: (n: number) => number }, total: number) {
  "use hermetic";
  return this.clamp(total * (1 - this.rate));
}

// Where it runs for real, record its calls.
let saved = "";
const price = record(applyDiscount, { rate: 0.25, clamp: (n) => Math.min(n, 60) }, (recording) => {
  saved = JSON.stringify(recording);
});
price(100); // 60

// In a test, replay the recording. It needs nothing else.
replay(applyDiscount, JSON.parse(saved) as Recording); // 60
```

- **A recording is JSON.** It holds the call's `this` and arguments, every operation the function performed on them and on what it reached through them, in order: reads, writes, calls, constructions and key listings, each with its result. Then it holds how the call ended.
- **Data crosses as data.** Numbers, strings, arrays, plain objects and the standard errors are copied into the recording, and the function works on them as usual. `undefined`, `NaN`, `-0` and bigints survive the trip through JSON. Anything else, such as a function, a class instance or `this` itself, is referred to by an id, and what the function does with it is recorded.
- **Callbacks are recorded too.** When the other side calls a function it was given, such as a callback passed to `this.each`, the recording holds that call, and what the callback did during it.
- **Asynchronous calls replay in order.** For a call that returns a promise, the recording holds how each promise from its inputs settled, and when, and how the call's own promise settled. `replay` settles the promises in the recorded order, calls back what the function gave the other side when the recording says it was called, and returns a promise.

`replay` runs the function with stand-ins that do exactly what the recorded inputs did. At the first thing the function does differently, it throws a `ReplayError`, such as "The function called this.clamp(25), and the recorded call called this.clamp(75) there." Otherwise it returns what the function returns, or throws what it throws. The order counts: a change that reads `this.rate` before `this.clamp` fails a replay, even if it computes the same result.

Both throw a `HermeticError` for a function that isn't hermetic, since a recording would miss what it reads besides its inputs. Some things they don't follow:

- **Identity of data.** Data is copied each time it crosses, so two reads of the same array give the same array when recorded, and two equal copies in a replay.
- **What happens after the call.** The recording ends with the call, so it doesn't hold what a returned function or generator does later.
- **Reshaping an input.** Making an input non-extensible, changing its prototype, or defining a non-configurable property on it throws a `TypeError`.

## doctests

A hermetic function's source is all of its behavior, so `new Function("return " + fn.toString())()` makes a copy that behaves exactly like it, wherever it runs. `doctests` turns the examples in a module's JSDoc into tests that check both:

```ts
/**
 * Rounds to whole cents.
 * @example
 * toCents.call({ Math }, 1.005) // => 1
 * toCents.call({ Math }, -1.234) // => -1.23
 */
export function toCents(this: { Math: Pick<Math, "round"> }, n: number): number {
  "use hermetic";
  return this.Math.round(n * 100) / 100;
}
```

```ts
import fs from "node:fs";
import { doctests } from "@bombadil/hermetic/doctest";
import { describe, it } from "vitest";
import * as money from "../src/money.ts";

describe("money's examples", () => {
  const source = fs.readFileSync(new URL("../src/money.ts", import.meta.url), "utf8");
  for (const test of doctests(money, source)) it(test.name, test.run);
});
```

- **Which functions.** Each exported function marked hermetic, by its directive or an `@hermetic` tag, gets a test for each `@example`, named after its `<caption>` if it has one. A class counts, marked by its constructor's directive or the tag. A function marked hermetic that `check` finds isn't fails its tests with a `HermeticError`.
- **Two runs.** Each example runs with the function the module exports, then with a copy made from its source alone. The copy can't see anything the source doesn't hold, such as a helper the compiler added outside the function.
- **What an example checks.** An example is JavaScript. A line that ends in `// => value` checks that the code before the comment gives `value`, compared by structure; a line that ends in `// throws`, `// throws TypeError` or `// throws TypeError: message` checks that it throws such an error. Other lines run as they are, and any line may use `await`. A checked expression has to fit on its line.
- **What an example can use.** The function, by its name, and any global. To pass other values, give `doctests` a `scope`: `doctests(money, source, { scope: { env } })`.
- **Why the source text.** A function's JSDoc isn't part of its `toString()`, so `doctests` finds the examples in the module's source, and takes the functions from the module itself.

`test.run` returns a promise, and rejects with a `DoctestError` that names the function, which of the two runs, and the example's line.

## checkHermetic

`check` binds acorn to `checkHermetic`, which does the work. `checkHermetic` is itself hermetic: its parser comes in through `this`, every helper is nested inside it, and it reads no globals. Its source is complete on its own, so it can be sent to another runtime and bound there. It passes its own check, which lists its `needs` as `["parse"]`, and runs under `confine`:

```ts
import { checkHermetic, confine } from "@bombadil/hermetic";
import { parse } from "acorn";

// After lockdown(), as in confine above.
const checkConfined = confine(checkHermetic);
checkConfined.call(
  { parse: (source, sourceType) => parse(source, { ecmaVersion: "latest", sourceType, checkPrivateFields: false }) },
  "(a) => Math.max(a, limit)",
); // problems: freeVariable Math at 7, and freeVariable limit at 19
```

The parser is up to you. It must return an ESTree program whose nodes carry `start` and `end` offsets, throw on a syntax error, and accept private names that aren't declared, because a method's source doesn't include its class.

## API

```ts
function check(fn: string | FunctionLike): CheckResult;
function checkHermetic(this: CheckEnvironment, source: string): CheckResult;
function confine<F extends FunctionLike>(fn: string | F): F;
function intrinsics(realm: typeof globalThis): Intrinsics;
// From "@bombadil/hermetic/inject":
function inject<T, A extends unknown[], R>(fn: (this: T, ...args: A) => R, env: NoInfer<T>): (...args: A) => R;
// From "@bombadil/hermetic/record":
function record<T, A extends unknown[], R>(
  fn: (this: T, ...args: A) => R,
  env: NoInfer<T>,
  onRecording: (recording: Recording) => void,
): (...args: A) => R;
function replay<T, A extends unknown[], R>(fn: (this: T, ...args: A) => R, recording: Recording): R;
class ReplayError extends Error {}
// From "@bombadil/hermetic/doctest":
function doctests(module: Record<string, unknown>, source: string, options?: { scope?: Record<string, unknown> }): Doctest[];
interface Doctest {
  name: string;
  run: () => Promise<void>;
}
class DoctestError extends Error {}
// From "@bombadil/hermetic/methods":
function methods<C extends abstract new (...args: never[]) => object, M extends Record<string, (...args: never[]) => unknown>>(
  base: C,
  functions: M, // each one's this must accept an instance with all of them installed
): WithMethods<C, M>; // base itself, whose instances have the functions as methods
class HermeticError extends Error {
  readonly source: string;
  readonly problems: readonly Problem[];
}
const IMMUTABLE_GLOBALS: readonly string[]; // "undefined", "NaN" and "Infinity"

interface CheckResult {
  form: "function" | "method" | "class" | undefined;
  marked: boolean;
  hermetic: boolean;
  problems: readonly Problem[];
  needs: readonly string[] | undefined;
}
interface Problem {
  kind: ProblemKind;
  name: string; // the name or construct, or the parser's message
  start: number;
  end: number;
}
interface CheckEnvironment {
  parse: (source: string, sourceType: "module" | "script") => unknown;
}
interface Intrinsics {
  Array: ArrayConstructor;
  // …and the rest of the table above
  Math: Omit<Math, "random">;
}
```

## License

[MIT](LICENSE)
