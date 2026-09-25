# hermetic/sealed

Require hermetic functions to read nothing but their inputs.

A hermetic function reads nothing but its inputs: its arguments, including `this`. It reads no globals, not even built-ins such as `Math`; the code that binds it passes in what it needs. It isn't necessarily pure: it can change its inputs, or call methods on them that do I/O. This rule checks that a function marked hermetic uses no names from outside itself, and none of the other forms listed below.

## Marking

A function is hermetic when its body starts with a `"use hermetic"` directive, or when a JSDoc block before it (or before the declaration that introduces it) has an `@hermetic` tag at the start of a line. Unmarked functions are not checked.

Methods can't be hermetic yet. A method's `this` is its object, not its inputs, so a marked method, accessor or class field is reported. A function stored in an object's property, as in `{ area: function () {} }`, is a function, and can be.

## Rule details

Examples of **incorrect** code:

```ts
const RATE = 0.1;
function discount(total: number) {
  "use hermetic";
  return total * (1 - RATE); // 'RATE' is a free variable
}

import { clamp } from "./clamp";
function price(total: number) {
  "use hermetic";
  return clamp(total); // imports are free variables, even hermetic ones
}

function roll() {
  "use hermetic";
  return Math.random(); // globals are free variables, built-ins included
}

function now() {
  "use hermetic";
  return Date.now(); // pass a clock in instead
}

const rate = () => {
  "use hermetic";
  return this.rate; // an arrow function's this comes from the enclosing scope
};

class Pricing {
  apply() {
    "use hermetic"; // methods can't be hermetic yet
    return this.rate;
  }
}

function url() {
  "use hermetic";
  return import.meta.url; // refers to the enclosing module
}

function Badge() {
  "use hermetic";
  return <span />; // the JSX factory is a free variable
}
```

Examples of **correct** code:

```ts
function discount(this: { rate: number }, total: number) {
  "use hermetic";
  return total * (1 - this.rate);
}

function scale(this: { Math: Pick<Math, "round"> }, xs: number[], k: number) {
  "use hermetic";
  const round = (x: number) => this.Math.round(x * k); // inner functions may use locals, and this
  return xs.map(round);
}

function orNothing(n: number | undefined) {
  "use hermetic";
  return n === undefined ? NaN : n; // undefined, NaN and Infinity read like keywords
}

function apply(cb: (n: number) => number) {
  "use hermetic";
  return cb(1); // calling a callback passed in as an argument
}

function fact(n: number): number {
  "use hermetic";
  return n <= 1 ? 1 : n * fact(n - 1); // a declaration may call itself by name
}

import type { Invoice } from "./invoice";
function total(invoice: Invoice) {
  "use hermetic";
  return invoice.total; // types are erased (with types: "allow")
}
```

### Every check

| Message | Reported when |
| --- | --- |
| `freeVariable` | A value reference comes from outside the function: an import, a module-level variable, or a global, built-ins such as `Math` and `Array` included. `undefined`, `NaN` and `Infinity` read like keywords, unless something outside the function declares the name. |
| `method` | A method, accessor or class field is marked. Methods can't be hermetic yet. |
| `typeReference` | With `types: "structural-only"`: a type reference resolves to a declaration outside the function. |
| `lexicalThis`, `lexicalNewTarget` | `this` or `new.target` inside a hermetic arrow function, or inside an arrow function nested in one, before any function that sets its own `this`. |
| `superReference` | `super` that refers to a class or object outside the hermetic function, as in an arrow function defined in a method. |
| `importMeta`, `dynamicImport` | `import.meta` or `import()` anywhere inside the hermetic function. |
| `jsx` | The root of a JSX tree inside the hermetic function. |

When hermetic functions are nested, a problem is reported once, for the innermost of them.

This rule checks names. It can't follow values, so it doesn't stop a hermetic function from reaching the program's shared built-ins through a prototype chain, as in `({}).__proto__.hasOwnProperty = () => true`. To run a function you don't trust, use [`confine`](../../../hermetic/README.md#confine) from `@bombadil/hermetic`, which runs it in a Hardened JS compartment where the shared built-ins are frozen. See [what hermetic functions don't give you](../../../../README.md#what-hermetic-functions-dont-give-you).

## Options

```ts
type Options = {
  types?: "allow" | "structural-only"; // default "allow"
};
```

The option can also be set once for both rules, in `settings.hermetic`. Options given to the rule take precedence.

### `types`

- `"allow"` (default): type-only references may come from outside the function. This includes `typeof x` in a type position, which the scope manager records as a value reference even though it never runs.
- `"structural-only"`: type references that resolve to a declaration outside the function are reported, including imports, module-level interfaces and type aliases, enclosing type parameters, and `typeof` a module value. TypeScript lib types and undeclared global types are allowed. Write the type of `this` inline, and name it where the function is bound with `ThisParameterType<typeof fn>`.

### Removed in 0.3.0

`ground` and `aliasing` chose which globals a hermetic function could read, and how strictly. Hermetic functions now read no globals, so there is nothing to choose, and setting either throws with an explanation. Build the values instead, in the code that binds hermetic functions. [`intrinsics(realm)`](../../../hermetic/README.md#intrinsics) in `@bombadil/hermetic` picks the deterministic built-ins out of a realm.

## When not to use it

The rule has no effect on code that doesn't mark functions hermetic. Hermetic functions suit business logic. They don't suit code whose job is to reach the outside world, such as an entry point, or the code that binds dependencies to hermetic functions.
