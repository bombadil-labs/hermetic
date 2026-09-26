# @bombadil/hermetic

**A hermetic function reads nothing but its inputs: its arguments, including `this`.** It reads no globals, not even built-ins such as `Math`; the code that binds it passes in what it needs. This package works with hermetic functions at runtime, from their source, with no ESLint:

- `check` reads a function's source and reports everything it reads besides its inputs, and the names it reads from `this`.
- `confine` runs a hermetic function in a [Hardened JS](https://hardenedjs.org/) compartment whose global object is empty.
- `intrinsics` picks the deterministic built-ins out of a realm, for bindings to pass in.
- `inject`, which is optional and has its own entry point, binds a hermetic function to exactly the names it reads.
- `record` and `replay`, with their own entry point, capture everything a call does with its inputs and play it back as a test.

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
| `lexicalThis`, `lexicalNewTarget` | `() => this.total` | An arrow function's `this` and `new.target` come from the enclosing scope, not from its inputs. |
| `superReference` | `() => super.save()` | It refers to the enclosing class or object. |
| `importMeta`, `dynamicImport` | `import.meta.url` | They refer to the enclosing module, or load code. |
| `withStatement` | `with (options) { … }` | It can turn any name inside it into a member of its object. |
| `method` | `area() { … }` | Methods, accessors and classes can't be hermetic yet: a method's `this` is its object, not its inputs. `name` says which it is. |
| `syntax` | | The source doesn't parse. `name` holds the parser's message. |
| `notAFunction` | | The source isn't a single function, method, accessor or class. |

The result:

- **`form`**: `"function"` for a function or arrow function, including async functions and generators; `"method"` for a method or accessor, whose source looks like `area() { … }`; `"class"` for a class. Only functions can be hermetic. Anything else is refused, including source that holds a function followed by more code, so nothing can get past the check alongside a function.
- **`marked`**: the function's body starts with a `"use hermetic"` directive. A JSDoc `@hermetic` tag comes before a function, not inside it, so it isn't part of the source and doesn't count here.
- **`hermetic`**: it is a function, and `check` found no problems. `marked` and `hermetic` are separate: the directive says the function should be hermetic, and `check` tests whether it is.
- **`problems`**: in source order, with offsets into the source.
- **`needs`**: the names the function reads from `this`, whether as `this.clamp` or as `const { clamp } = this`, in the order it first reads them. For a hermetic function, that's everything it needs from the code that binds it. It's undefined when the function uses `this` in a way that doesn't name what it reads, as in `this[key]` or `helper(this)`, and for anything but a function. An arrow function needs nothing, since its `this` isn't one of its inputs.

`check` reports what `hermetic/sealed` reports. On the 14,416 functions and methods in the published JavaScript of Effect 3.22.2, RxJS 7.8.2 and TanStack Query 5.103.2, the two report the same problems at the same places, every one. (Class constructors aren't counted: a constructor's source is its whole class.) `npm run corpus -- crosscheck` in the repository reproduces this.

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

- **Freeze every environment**, or under Hardened JS, `harden` it. A hermetic function may change its inputs, so an environment that several bindings share would otherwise let one function change what another gets. Replacing a value always makes a new environment.
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

`confine` checks a function, then evaluates its source in a new Hardened JS compartment whose global object is empty, and returns the function the compartment made, hardened. If the function isn't hermetic, it throws a `HermeticError` with the problems `check` found. Its generic parameter types the result when you pass source text.

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
function checkHermetic(this: CheckContext, source: string): CheckResult;
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
interface CheckContext {
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
