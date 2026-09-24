---
title: RxJS: why the lift leaves the operators alone
description: What prefer-hermetic did to RxJS {{rxjs.version}}, and what it refused to do: hoisted operators, import cycles, and the cost of being exact.
---

# RxJS: why the lift leaves the operators alone

<p class="lede">RxJS is the reference implementation of observables for JavaScript. The lift split {{rxjs.lifted}} of its {{rxjs.candidates}} functions and left {{rxjs.skipped}} alone. This case study is about those refusals: what the lift will not do to a function it cannot prove safe to split, and what that costs.</p>

This covers the TypeScript source RxJS {{rxjs.version}} ships on npm: {{rxjs.files}} files and {{rxjs.candidates}} candidate functions.

<!-- outcomes rxjs -->

| Outcome | Functions | Share |
| --- | ---: | ---: |
| Already hermetic, marked | {{rxjs.hermetic}} | {{rxjs.hermeticPct}} |
| Lifted | {{rxjs.lifted}} | {{rxjs.liftedPct}} |
| Left alone | {{rxjs.skipped}} | {{rxjs.skippedPct}} |

## Already hermetic: methods that stay home

{{rxjs.hermeticMembers}} of the {{rxjs.hermetic}} functions that were already hermetic are methods of RxJS's classes. `Subscriber._next` forwards to `this.destination`, and methods like `Observable._subscribe` and `ReplaySubject._trimBuffer` reach nothing but their own `this`. A method's `this` is its declared environment, so the rule allows it. Most of the rest are small utilities:

<!-- example rxjs/src/internal/util/isFunction.ts#isFunction -->

## Lifted

All {{rxjs.lifted}} lifted functions pass their values directly. They include `pipe`, the notification factories, helpers in `ajax`, and `operate`, the helper that `map`, `filter` and many other operators are built on.

<!-- example rxjs/src/internal/util/pipe.ts#pipe -->

## The operators

`map`, `filter`, `switchMap` and most other operators are function declarations built the same way:

<!-- example rxjs/src/internal/operators/map.ts#map -->

`map` reads two names, `operate` and `createOperatorSubscriber`, and both are imported. The lift could pass them in. It does not, for a reason that has nothing to do with `map` itself: a function declaration is hoisted. It exists before any statement of its module runs, so another module can call it while its own module is still being set up, which is what an import cycle does. At that moment, the names it imports may not be initialized yet.

The original `map` would fail then only if it actually reached an uninitialized name. A lifted `map` would read every lifted name as soon as it was called: sooner, and always. A shared context of getters keeps the reads lazy, but a shared context is a module-level constant, and at that moment it would not exist yet either. There is no exact and fast way to split a hoisted function that reads a named import, so the lift leaves it to a person. {{rxjs.hoistedSkipped}} RxJS functions are left alone for this reason, more than for any other.

### What one opt-in would change

{{rxjs.hoistedOnlyImports}} of those {{rxjs.hoistedSkipped}} read nothing unsettled except imports. (A namespace import, `import * as ns`, already counts as settled: the namespace object exists before any module code runs.) Treating every import as settled would lift them: {{rxjs.liftedWithImports}} of RxJS's {{rxjs.candidates}} candidates, {{rxjs.liftedWithImportsPct}}, instead of {{rxjs.lifted}}. It would be exact everywhere except two places: an import cycle that calls the function while its imports are still uninitialized, and an exported `let` that is reassigned while the function runs.

The plugin does not offer that option yet. RxJS is the clearest case for it.

## Everything left alone

<!-- reasons rxjs -->

After the operators, the largest group is **methods and object members**: the lift splits only functions declared at the top of a module, because a method's receiver is part of how it is called.

## Checked

The fixed source adds {{rxjs.typeErrorsIntroduced}} type errors. Unlifting it folds all {{rxjs.folded}} bindings back, and {{rxjs.roundTripDiffering}} files differ from the original program.

## Reproduce it

```sh
npm run corpus -- report
```
