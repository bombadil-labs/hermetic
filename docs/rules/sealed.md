# hermetic/sealed

Require hermetic functions to touch the world only through their arguments, `this`, and the ground.

A hermetic function depends only on what it is handed: its arguments, `this`, and the ground. It is not a pure function: it may mutate and cause effects, but only through what it was handed. This rule checks that a function marked hermetic has no free variables except names in the ground, and none of the syntactic escapes listed below.

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
  return Math.random(); // denied by the default ground
}

function now() {
  "use hermetic";
  return Date.now(); // Date is not in the default ground
}

const rate = () => {
  "use hermetic";
  return this.rate; // arrow `this` is lexical
};

class Pricing extends Base {
  apply() {
    "use hermetic";
    return super.apply(); // reaches the enclosing home object
  }
}

function url() {
  "use hermetic";
  return import.meta.url; // reaches the enclosing module
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
  const round = (x: number) => Math.round(x * k); // inner closures may use locals
  return xs.map(round);
}

function apply(cb: (n: number) => number) {
  "use hermetic";
  return cb(1); // calling a callback you were handed
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
| `freeVariable` | A value reference escapes the function and its name is not in the ground. |
| `shadowedGround` | A ground name resolves to a binding declared in an enclosing scope, such as an import or a local. Ambient `declare` statements do not count. |
| `groundWrite` | The function assigns to a ground name. |
| `deniedPath` | A static member chain or destructuring pattern reaches a denied path, such as `Math.random`. |
| `aliasedGround` | With `aliasing: "forbid"`: a ground object that has denied members is used in a way that could hand it elsewhere. |
| `typeReference` | With `types: "structural-only"`: a type reference resolves to a declaration outside the function. |
| `lexicalThis`, `lexicalNewTarget` | `this` or `new.target` inside a hermetic arrow function, or inside an arrow nested in one, before any function that rebinds it. |
| `superReference` | `super` whose home object lies outside the hermetic function. |
| `importMeta`, `dynamicImport` | `import.meta` or `import()` anywhere inside the hermetic function. |
| `jsx` | The root of a JSX tree inside the hermetic function. |

When hermetic functions nest, an escape is reported once, for the innermost one it escapes.

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

- `"allow"` (default): type-only references may escape. This includes `typeof x` in a type position, which the scope manager records as a value reference even though it never runs.
- `"structural-only"`: type references that resolve to a declaration outside the function are reported, including imports, module-level interfaces and type aliases, enclosing type parameters, and `typeof` a module value. TypeScript lib types and undeclared global types are allowed. Write context types inline, and name them in the binding layer with `ThisParameterType<typeof fn>`.

### `ground`

A path to a ground bootstrap module, absolute or relative to ESLint's working directory, or a `file:` URL. Without it, the default ground applies. The bootstrap is the export named `ground`, or else the default export. It must itself be marked hermetic. It is linted with this rule, on the default ground, before it runs, and it may only use TypeScript syntax that erases cleanly. See the [README](../../README.md#the-ground).

### `aliasing`

- `"best-effort"` (default): denied paths are reported where they are statically visible. `const m = Math; m.random()` is not caught.
- `"forbid"`: a ground object with denied members may only be used in place: static member access (`Math.max`), destructuring (`const { max } = Math`), `typeof`, calling or constructing it (`new Date(0)`), comparisons, and `instanceof` or `in` tests. Aliases (`const m = Math`), dynamic keys (`Math[key]`), rest elements and passing the object along (`f(Math)`) are reported.

## When not to use it

The rule has no effect on code that does not mark functions hermetic. Hermetic functions suit business logic. It does not suit code whose job is to reach ambient authority, such as a binding layer or an entry point.
