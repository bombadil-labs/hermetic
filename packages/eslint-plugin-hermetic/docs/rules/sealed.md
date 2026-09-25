# hermetic/sealed

Require hermetic functions to read nothing but their inputs and the allowed globals.

A hermetic function reads nothing but its inputs, meaning its arguments including `this`, and the allowed globals. It isn't necessarily pure: it can change its inputs, or call methods on them that do I/O. This rule checks that a function marked hermetic uses no names from outside itself other than the allowed globals, and none of the other forms listed below.

## Marking

A function is hermetic when its body starts with a `"use hermetic"` directive, or when a JSDoc block before it (or before the declaration that introduces it) has an `@hermetic` tag at the start of a line. Unmarked functions are not checked.

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
  return Math.random(); // not allowed by default
}

function now() {
  "use hermetic";
  return Date.now(); // Date is not an allowed global by default
}

const rate = () => {
  "use hermetic";
  return this.rate; // an arrow function's this comes from the enclosing scope
};

class Pricing extends Base {
  apply() {
    "use hermetic";
    return super.apply(); // refers to the enclosing class
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

function scale(xs: number[], k: number) {
  "use hermetic";
  const round = (x: number) => Math.round(x * k); // inner functions may use locals
  return xs.map(round);
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
| `freeVariable` | A value reference comes from outside the function, and its name is not an allowed global. |
| `shadowedGround` | The name of an allowed global refers to a variable declared in an enclosing scope, such as an import or a local. Ambient `declare` statements don't count. |
| `groundWrite` | The function assigns to an allowed global. |
| `deniedPath` | A static member chain or destructuring pattern reaches a denied member, such as `Math.random`. |
| `aliasedGround` | With `aliasing: "forbid"`: an allowed global that has denied members is used in a way that could pass it elsewhere. |
| `typeReference` | With `types: "structural-only"`: a type reference resolves to a declaration outside the function. |
| `lexicalThis`, `lexicalNewTarget` | `this` or `new.target` inside a hermetic arrow function, or inside an arrow function nested in one, before any function that sets its own `this`. |
| `superReference` | `super` that refers to a class or object outside the hermetic function. |
| `importMeta`, `dynamicImport` | `import.meta` or `import()` anywhere inside the hermetic function. |
| `jsx` | The root of a JSX tree inside the hermetic function. |

When hermetic functions are nested, a problem is reported once, for the innermost of them.

This rule checks names. It can't follow values, so it doesn't stop a hermetic function from reaching the program's shared built-ins through a prototype chain, as in `({}).__proto__.hasOwnProperty = () => true`. To run a function you don't trust, use [`confine`](../../../hermetic/README.md#confine) from `@bombadil/hermetic`, which runs it in a Hardened JS compartment where the shared built-ins are frozen. See [what hermetic functions don't give you](../../../../README.md#what-hermetic-functions-dont-give-you).

## Options

```ts
type Options = {
  types?: "allow" | "structural-only"; // default "allow"
  ground?: string;
  aliasing?: "best-effort" | "forbid"; // default "best-effort"
};
```

Each option can also be set once for both rules, in `settings.hermetic`. Options given to the rule take precedence.

### `types`

- `"allow"` (default): type-only references may come from outside the function. This includes `typeof x` in a type position, which the scope manager records as a value reference even though it never runs.
- `"structural-only"`: type references that resolve to a declaration outside the function are reported, including imports, module-level interfaces and type aliases, enclosing type parameters, and `typeof` a module value. TypeScript lib types and undeclared global types are allowed. Write the type of `this` inline, and name it where the function is bound with `ThisParameterType<typeof fn>`.

### `ground`

A path to the bootstrap that chooses the allowed globals: absolute, relative to ESLint's working directory, or a `file:` URL. Without it, the default list applies. The bootstrap is the export named `ground`, or else the default export. It must itself be marked hermetic. It is linted with this rule, using the default allowed globals, before it runs, and it may only use TypeScript syntax that erases cleanly. See the [README](../../README.md#allowed-globals).

### `aliasing`

- `"best-effort"` (default): denied members are reported where they are statically visible. `const m = Math; m.random()` is not caught.
- `"forbid"`: an allowed global with denied members may only be used in place: static member access (`Math.max`), destructuring (`const { max } = Math`), `typeof`, calling or constructing it (`new Date(0)`), comparisons, and `instanceof` or `in` tests. Aliases (`const m = Math`), dynamic keys (`Math[key]`), rest elements and passing the object along (`f(Math)`) are reported.

## When not to use it

The rule has no effect on code that doesn't mark functions hermetic. Hermetic functions suit business logic. They don't suit code whose job is to reach the outside world, such as an entry point, or the code that binds dependencies to hermetic functions.
