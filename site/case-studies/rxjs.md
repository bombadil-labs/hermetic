---
title: RxJS: why the lift skips the operators
description: What prefer-hermetic did to RxJS {{rxjs.version}}, and why it skipped most of it: hoisted operators and import cycles.
---

# RxJS: why the lift skips the operators

<p class="lede">RxJS is a library for reactive programming with observables. The lift rewrote {{rxjs.lifted}} of its {{rxjs.candidates}} functions and skipped {{rxjs.skipped}}. This case study is mostly about the skipped ones: why the lift won't rewrite a function unless it can prove the rewrite is safe, and what that costs.</p>

It covers the TypeScript source that RxJS {{rxjs.version}} publishes to npm: {{rxjs.files}} files and {{rxjs.candidates}} candidate functions.

## Results

<!-- outcomes rxjs -->

| Outcome | Functions | Share |
| --- | ---: | ---: |
| Already hermetic, marked | {{rxjs.hermetic}} | {{rxjs.hermeticPct}} |
| Lifted | {{rxjs.lifted}} | {{rxjs.liftedPct}} |
| Skipped | {{rxjs.skipped}} | {{rxjs.skippedPct}} |

## Already hermetic

{{rxjs.hermeticMembers}} of the {{rxjs.hermetic}} functions that were already hermetic are methods of RxJS's classes. `Subscriber._next` forwards to `this.destination`, and methods like `Observable._subscribe` and `ReplaySubject._trimBuffer` read nothing but `this` and their arguments. For a method, `this` is an input like any other, so the rule allows it. Most of the rest are small utilities:

<!-- example rxjs/src/internal/util/isFunction.ts#isFunction -->

## Lifted

All {{rxjs.lifted}} lifted functions pass their values directly. They include `pipe`, the notification factories, helpers in `ajax`, and `operate`, the helper that `map`, `filter` and many other operators are built on.

<!-- example rxjs/src/internal/util/pipe.ts#pipe -->

## The operators

`map`, `filter`, `switchMap` and most other operators are function declarations written like this:

<!-- example rxjs/src/internal/operators/map.ts#map -->

`map` reads two names, `operate` and `createOperatorSubscriber`, and both are imported. The lift could pass them in, but it doesn't, because `map` is a function declaration, and function declarations are hoisted. A hoisted function exists before any line of its module runs, so another module can call it while its own module is still loading. That happens in import cycles, and at that point the names it imports may not be initialized yet.

The original `map` would only fail in that case if it actually used an uninitialized name. A lifted `map` would read every name it needs as soon as it was called, so it could fail where the original didn't. A shared context object with getters would delay those reads, but that object is itself a module-level constant, so it wouldn't exist yet either. There's no way to rewrite a hoisted function that reads a named import without changing its behavior or slowing it down, so the lift skips it. {{rxjs.hoistedSkipped}} RxJS functions are skipped for this reason, more than for any other.

### What treating imports as initialized would change

{{rxjs.hoistedOnlyImports}} of those {{rxjs.hoistedSkipped}} functions read nothing that could be uninitialized except imports. (Namespace imports, `import * as ns`, are never a problem: the namespace object exists before any module code runs.) If the lift assumed imports are always initialized, it would lift those functions too: {{rxjs.liftedWithImports}} of RxJS's {{rxjs.candidates}} candidates, {{rxjs.liftedWithImportsPct}}, instead of {{rxjs.lifted}}. The rewrite would then behave differently in only two cases: an import cycle that calls the function before its imports are initialized, and an exported `let` that is reassigned while the function runs.

The plugin doesn't offer that option yet. RxJS is the clearest case for adding it.

## Everything skipped

<!-- reasons rxjs -->

After the operators, the largest group is **methods and object members**. The lift only rewrites functions declared at the top level of a module, because a method already uses `this` for the object it's called on.

## Verification

The fixed source adds {{rxjs.typeErrorsIntroduced}} type errors. `unlift` turns all {{rxjs.folded}} lifted functions back into their original form, and {{rxjs.roundTripDiffering}} files differ from the original program.

## Reproduce it

```sh
npm run corpus -- report
```
