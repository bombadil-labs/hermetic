# @bombadil/hermetic

**A hermetic function reads nothing but its inputs: its arguments, including `this`, and a short list of allowed globals.** This package checks that at runtime, from a function's source, with no ESLint:

- `check` reads a function's source and reports everything it reads besides its inputs and the allowed globals.
- `confine` runs a hermetic function in a [Hardened JS](https://hardenedjs.org/) compartment, where it can't reach anything else either.

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
  return { ...invoice, total: invoice.total * (1 - rate) };
}`);
// {
//   form: "function",
//   marked: true,
//   hermetic: false,
//   problems: [{ kind: "freeVariable", name: "rate", start: 103, end: 107 }],
// }
```

`check` takes a function, or its source as `Function.prototype.toString` returns it, so it works on functions that were stored or sent from somewhere else. It parses the source on its own and reports what the function reads besides its inputs and the allowed globals:

| Kind | Example | Why |
| --- | --- | --- |
| `freeVariable` | `rate` | A name that is neither declared in the function nor an allowed global: an import, a module-level variable, a global like `fetch`. |
| `groundWrite` | `Math = …` | Allowed globals can be read, not reassigned. |
| `deniedPath` | `Math.random()`, `const { random } = Math` | A denied member of an allowed global. |
| `lexicalThis`, `lexicalNewTarget` | `() => this.total` | An arrow function's `this` and `new.target` come from the enclosing scope, not from its inputs. |
| `superReference` | `super.save()` | It refers to the enclosing class or object. |
| `importMeta`, `dynamicImport` | `import.meta.url` | They refer to the enclosing module, or load code. |
| `withStatement` | `with (options) { … }` | It can turn any name inside it into a member of its object. |
| `syntax` | | The source doesn't parse. `name` holds the parser's message. |
| `notAFunction` | | The source isn't a single function, method, accessor or class. |

The result:

- **`form`**: `"function"` for a function or arrow function, including async functions and generators; `"method"` for a method or accessor, whose source looks like `area() { … }`; `"class"` for a class, which is checked whole: its heritage, computed keys, field initializers, static blocks and methods. Anything else is refused, including source that holds a function followed by more code, so nothing can get past the check alongside a function.
- **`marked`**: the function's body starts with a `"use hermetic"` directive, or for a class, its constructor's body. A JSDoc `@hermetic` tag comes before a function, not inside it, so it isn't part of the source and doesn't count here.
- **`hermetic`**: `check` found no problems. `marked` and `hermetic` are separate: the directive says the function should be hermetic, and `check` tests whether it is.
- **`problems`**: in source order, with offsets into the source.

A method's computed key, as in `[Symbol.iterator]() { … }`, isn't part of the function, so it isn't checked. The ESLint rule doesn't check it either.

`check` reports what `hermetic/sealed` reports, as far as a function's source can show it. On the 14,416 functions and methods in the published JavaScript of Effect 3.22.2, RxJS 7.8.2 and TanStack Query 5.103.2, the two report the same problems at the same places, apart from the 9 functions described next. (Class constructors aren't counted: a constructor's source is its whole class.) `npm run corpus -- crosscheck` in the repository reproduces this.

### What a function's source can't show

The source of a function doesn't include the module around it. When the module declares or imports a name that is also an allowed global, such as Effect's `import * as Array from "../Array.js"`, then `Array` in the function means the module's `Array`, and its source can't say so. `check` passes the function, but wherever else the function runs, its `Array` is the global one. Those 9 functions in Effect read its `String`, `Array` and `Boolean` modules, the `Error` classes of its `Data` and `Micro` modules, `LogLevel.Error` and `Duration.isFinite` this way. `Data.TaggedError`, for one, would extend the global `Error` instead of Effect's. The ESLint rule sees the module and reports each one, so lint functions where they are written, and check them where they arrive.

Build tools can also change what `check` sees:

- esbuild's `keepNames` option, which tsx turns on, adds a call to a `__name` helper for each named function nested inside a function. The helper is a hidden input, and `check` reports it as a free variable.
- terser removes directives it doesn't know by default, including `"use hermetic"`, so `marked` comes back false. Set `compress: { directives: false }` to keep them.

## Allowed globals

By default, a hermetic function may read deterministic built-ins that don't depend on the host:

| Category | Allowed | Not allowed, and why |
| --- | --- | --- |
| Values | `undefined`, `NaN`, `Infinity` | |
| Data structures | `Array`, `Object`, `Map`, `Set`, `WeakMap`, `WeakSet`, `Symbol` | |
| Primitives | `Number`, `String`, `Boolean`, `BigInt`, `parseInt`, `parseFloat`, `isNaN`, `isFinite` | |
| Structured data | `JSON`, `RegExp`, `Promise`, the error constructors | |
| Math | `Math` | `Math.random` (nondeterministic) |
| Time | | `Date` (reads the clock) |
| I/O and host access | | `fetch`, `crypto`, `console`, timers, `process`, `globalThis`, `window`, `document` |
| Code loading | | `eval`, `Function` |
| Locale | | `Intl` (depends on the host's locale) |

Anything not listed isn't allowed, including deterministic built-ins such as `Reflect`, typed arrays and `encodeURIComponent`. `DEFAULT_GROUND_ALLOW` and `DEFAULT_GROUND_DENY` export the list.

To choose your own, write a bootstrap: a hermetic function that picks the allowed globals out of the realm it is given, and returns them with any denied members. The ESLint plugin loads the same function, so the linter and the runtime share one list:

```ts
// hermetic.ground.ts
export function ground(realm: typeof globalThis) {
  "use hermetic";
  return {
    allow: { Math: realm.Math, JSON: realm.JSON, Date: realm.Date },
    deny: ["Math.random", "Date.now"],
  };
}
```

```ts
import { check, confine } from "@bombadil/hermetic";
import { ground } from "./hermetic.ground.ts";

check(fn, ground(globalThis)); // check reads only the names in allow
confine(fn, { ground }); // confine calls it with the compartment's global object
```

A one-segment deny path, such as `"Date"`, removes the name entirely.

## confine

```ts
import "ses";
lockdown();

import { confine } from "@bombadil/hermetic";

const area = confine('function () { "use hermetic"; return this.width * this.height }');
area.call(harden({ width: 2, height: 3 })); // 6
```

`confine` checks a function, then evaluates its source in a new Hardened JS compartment and returns the function the compartment made, hardened. If the function isn't hermetic, it throws a `HermeticError` with the problems `check` found. Its generic parameter types the result when you pass source text: `confine<(n: number) => number>(source)`.

`check` looks at the names a function reads. A function can also reach things through values, which a check of names can't follow, and the compartment covers those:

- **The shared built-ins are frozen.** Every value leads through its prototype chain to built-ins the whole program shares. In a compartment, `Object.getPrototypeOf({}).hasOwnProperty = () => true` throws, instead of changing `hasOwnProperty` for every object in the program.
- **Code can't be loaded through a constructor.** `[].constructor.constructor("return globalThis")()` throws.
- **The clock and random numbers throw, even through an alias.** `const m = Math; m.random()` gets past a check of names, but the compartment's `Math.random`, `Date.now` and `new Date()` all throw.
- **The global object holds only the allowed globals, and is frozen,** so a function can't keep anything there between calls. Each `confine` makes a new compartment, which takes about 0.1 ms.

Whatever you pass to a confined function is still its to use and change. Harden the inputs it shouldn't change, as with `harden(...)` above.

### Setting up Hardened JS

`lockdown()` freezes the built-ins of the whole program, and can't be undone, so it is the application's decision. This package never calls it, and doesn't depend on `ses`. Install [`ses`](https://www.npmjs.com/package/ses), import it, and call `lockdown()` once at startup, after any polyfills. `confine` throws until you do. Code that changes built-ins after `lockdown()` throws too, so run your tests under it once to find any. MetaMask and Agoric run untrusted JavaScript this way in production.

With a bootstrap, `confine` calls it with the compartment's own global object, so `realm.Math` is the compartment's `Math`, whose `random` throws. Other values a bootstrap returns are added to the compartment, hardened.

### What confine can't evaluate

`confine` throws a `HermeticError` whose `problems` are empty, and whose `cause` is the compartment's error, when:

- **The source holds text Hardened JS rejects,** even inside a string or comment: `import(`, `<!--` or `-->`.
- **A method uses its class's private names,** such as `this.#items`. The method may be hermetic, but private names only exist inside their class.
- **The function only works in sloppy mode.** Compartments run strict-mode code.

A method's computed key runs once, inside the compartment, when the method is confined.

## checkHermetic

`check` binds acorn and the allowed globals to `checkHermetic`, which does the work. `checkHermetic` is itself hermetic: the parser and the allowed globals come in through `this`, and every helper is nested inside it. Its source is complete on its own, so it can be sent to another runtime and bound there. It passes its own check, and runs under `confine`:

```ts
import { checkHermetic, confine, createGround } from "@bombadil/hermetic";
import { parse } from "acorn";

// After lockdown(), as in confine above.
const checkConfined = confine(checkHermetic);
checkConfined.call(
  {
    parse: (source, sourceType) => parse(source, { ecmaVersion: "latest", sourceType, checkPrivateFields: false }),
    ground: createGround(["Math"], ["Math.random"]),
  },
  "(a) => Math.max(a, limit)",
); // problems: [{ kind: "freeVariable", name: "limit", start: 19, end: 24 }]
```

The parser is up to you. It must return an ESTree program whose nodes carry `start` and `end` offsets, throw on a syntax error, and accept private names that aren't declared, because a method's source doesn't include its class.

## API

```ts
function check(fn: string | FunctionLike, ground?: GroundConfig): CheckResult;
function checkHermetic(this: CheckContext, source: string): CheckResult;
function confine<F extends FunctionLike>(fn: string | F, options?: { ground?: GroundBootstrap }): F;
class HermeticError extends Error {
  readonly source: string;
  readonly problems: readonly Problem[];
}

interface CheckResult {
  form: "function" | "method" | "class" | undefined;
  marked: boolean;
  hermetic: boolean;
  problems: readonly Problem[];
}
interface Problem {
  kind: ProblemKind;
  name: string; // the name, dotted path or construct, or the parser's message
  start: number;
  end: number;
}
interface CheckContext {
  parse: (source: string, sourceType: "module" | "script") => unknown;
  ground: Ground;
}

type GroundBootstrap = (realm: typeof globalThis) => GroundConfig;
interface GroundConfig {
  allow: Record<string, unknown>;
  deny?: readonly string[];
}
function createGround(allow: Iterable<string>, deny?: Iterable<string>): Ground;
const DEFAULT_GROUND: Ground;
const DEFAULT_GROUND_ALLOW: readonly string[];
const DEFAULT_GROUND_DENY: readonly string[];
```

## License

[MIT](LICENSE)
