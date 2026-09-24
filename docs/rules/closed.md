# isolated/closed

Require isolated functions to touch the world only through their arguments, `this`, and the ground.

An isolated function is not a pure function. It may mutate and cause effects, but only through what it is handed. This rule checks that a function marked isolated has no free variables except names in the ground, and none of the syntactic escapes listed below.

## Marking

A function is isolated when its body starts with a `"use isolated"` directive, or when a JSDoc block before it (or before the declaration that introduces it) has an `@isolated` tag at the start of a line. Unmarked functions are not checked.

## Rule details

Examples of **incorrect** code:

```ts
const RATE = 0.1;
function discount(total: number) {
  "use isolated";
  return total * (1 - RATE); // 'RATE' is a free variable
}

import { clamp } from "./clamp";
function price(total: number) {
  "use isolated";
  return clamp(total); // imports are free variables, even isolated ones
}

function roll() {
  "use isolated";
  return Math.random(); // denied by the default ground
}

function now() {
  "use isolated";
  return Date.now(); // Date is not in the default ground
}

const rate = () => {
  "use isolated";
  return this.rate; // arrow `this` is lexical
};

class Pricing extends Base {
  apply() {
    "use isolated";
    return super.apply(); // reaches the enclosing home object
  }
}

function url() {
  "use isolated";
  return import.meta.url; // reaches the enclosing module
}

function Badge() {
  "use isolated";
  return <span />; // the JSX factory is a free variable
}
```

Examples of **correct** code:

```ts
function discount(this: { rate: number }, total: number) {
  "use isolated";
  return total * (1 - this.rate);
}

function scale(xs: number[], k: number) {
  "use isolated";
  const round = (x: number) => Math.round(x * k); // inner closures may use locals
  return xs.map(round);
}

function apply(cb: (n: number) => number) {
  "use isolated";
  return cb(1); // calling a callback you were handed
}

function fact(n: number): number {
  "use isolated";
  return n <= 1 ? 1 : n * fact(n - 1); // a declaration may call itself by name
}

import type { Invoice } from "./invoice";
function total(invoice: Invoice) {
  "use isolated";
  return invoice.total; // types are erased (with types: "allow")
}
```

### Every check

| Message | Reported when |
| --- | --- |
| `freeVariable` | A value reference escapes the function and its name is not in the ground. |
| `shadowedGround` | A ground name resolves to a binding declared in an enclosing scope, such as an import or a local. Ambient `declare` statements do not count. |
| `groundWrite` | The function assigns to a ground name. |
| `deniedPath` | A static member chain or destructuring pattern reaches a denied path, such as `Math.random`. |
| `aliasedGround` | With `aliasing: "forbid"`: a ground object that has denied members is used in a way that could hand it elsewhere. |
| `typeReference` | With `types: "structural-only"`: a type reference resolves to a declaration outside the function. |
| `lexicalThis`, `lexicalNewTarget` | `this` or `new.target` inside an isolated arrow function, or inside an arrow nested in one, before any function that rebinds it. |
| `superReference` | `super` whose home object lies outside the isolated function. |
| `importMeta`, `dynamicImport` | `import.meta` or `import()` anywhere inside the isolated function. |
| `jsx` | The root of a JSX tree inside the isolated function. |

When isolated functions nest, an escape is reported once, for the innermost one it escapes.

## Options

```ts
type Options = {
  types?: "allow" | "structural-only"; // default "allow"
  ground?: string;
  aliasing?: "best-effort" | "forbid"; // default "best-effort"
};
```

### `types`

- `"allow"` (default): type-only references may escape. This includes `typeof x` in a type position, which the scope manager records as a value reference even though it never runs.
- `"structural-only"`: type references that resolve to a declaration outside the function are reported, including imports, module-level interfaces and type aliases, enclosing type parameters, and `typeof` a module value. TypeScript lib types and undeclared global types are allowed. Write context types inline, and name them in the binding layer with `ThisParameterType<typeof fn>`.

### `ground`

A path to a ground bootstrap module, absolute or relative to ESLint's working directory, or a `file:` URL. Without it, the default ground applies. The bootstrap is the export named `ground`, or else the default export. It must itself be marked isolated. It is linted with this rule, on the default ground, before it runs, and it may only use TypeScript syntax that erases cleanly. See the [README](../../README.md#the-ground).

### `aliasing`

- `"best-effort"` (default): denied paths are reported where they are statically visible. `const m = Math; m.random()` is not caught.
- `"forbid"`: a ground object with denied members may only be used in place: static member access (`Math.max`), destructuring (`const { max } = Math`), `typeof`, calling or constructing it (`new Date(0)`), comparisons, and `instanceof` or `in` tests. Aliases (`const m = Math`), dynamic keys (`Math[key]`), rest elements and passing the object along (`f(Math)`) are reported.

## When not to use it

The rule has no effect on code that does not mark functions isolated. Isolation suits business logic. It does not suit code whose job is to reach ambient authority, such as a binding layer or an entry point.
