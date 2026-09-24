---
title: Effect: {{effect.lifted}} functions lifted, every test still green
description: What prefer-hermetic did to Effect {{effect.version}}: the functions it marked, lifted and left alone, checked by Effect's own test suite and benchmarks.
---

# Effect: {{effect.lifted}} functions lifted, every test still green

<p class="lede">Effect is a functional runtime for TypeScript: effects, fibers, streams, schemas and a large library of data types. It is the biggest library in the corpus, and the one the lift was tested hardest against: Effect's own test suite ran on the lifted source, and again on the source lifted and then unlifted.</p>

This covers the TypeScript source Effect {{effect.version}} ships on npm: {{effect.files}} files and {{effect.candidates}} candidate functions, the outermost functions bound to a name.

That leaves out a large part of Effect. Much of its API is written as `export const map = dual(2, (self, f) => …)`, where the implementation is an argument to `dual`, bound to no name. The fix does not touch functions like that: {{effect.unnamed}} of them, {{effect.unnamedDual}} passed to `dual`.

<!-- outcomes effect -->

| Outcome | Functions | Share |
| --- | ---: | ---: |
| Already hermetic, marked | {{effect.hermetic}} | {{effect.hermeticPct}} |
| Lifted, values passed directly | {{effect.direct}} | {{effect.directPct}} |
| Lifted, through a shared context | {{effect.shared}} | {{effect.sharedPct}} |
| Left alone | {{effect.skipped}} | {{effect.skippedPct}} |

## Already hermetic

{{effect.hermetic}} of Effect's functions touch nothing but their arguments and `this`, so the fix only marks them: with a `"use hermetic"` directive, or, for an arrow with an expression body, an `@hermetic` tag in its JSDoc.

<!-- example effect/src/Arbitrary.ts#absurd -->

## Lifted

Most of the candidates are module functions that call other module functions: `Array.ts` reads its own helpers and the `Option` module, and the internals read each other. The lift moves each body into a hermetic core that reads those names from `this`, and leaves a binding with the original name, signature and export that hands them over. {{effect.direct}} bindings pass the values directly:

<!-- example effect/src/internal/schedule/interval.ts#after -->

That is exact when every name is *settled*: initialized before the binding can run, and never reassigned. `make` is declared above `after`, and `after` is a `const`, so it cannot run before its own line.

A name declared further down the file is different. If the function ran before that line, the original would fail only on a path that reaches the name. So the binding hands over one shared context instead, created right after it, whose getters read each name when the core does. {{effect.shared}} lifts in Effect look like `tail`, which reads `tailNonEmpty`, declared twenty lines below it:

<!-- example effect/src/Array.ts#tail -->

## Left alone, and why

<!-- reasons effect -->

- **Methods and object members** are {{effect.membersPctOfSkipped}} of what was left. Effect builds its data types from prototype objects and classes, and the lift splits only functions declared at the top of a module, because a method's receiver is part of how it is called.
- **Typed variables**, such as `export const isChunk: { … } = …`, take their type from the annotation rather than from the function. A core declared on its own would lose it.
- **Lifted names inside nested functions or classes.** `makePrimitive` returns a `function () { … }` that reads the module's `args` symbol. Inside a `function`, `this` is that function's own, so the core's context is out of reach there.
- **Hoisted declarations** can run before any statement of their module, so they are lifted only when everything they read is always there. In Effect, these mostly read module constants.
- **Functions that read the stack** would gain a frame. That rule came from Effect's test suite, as the next section explains:

<!-- example effect/src/internal/context.ts#makeGenericTag -->

## What the test suite caught

The lift went through the type checker first. Once the lifted corpus type-checked with no new errors, Effect's own test suite ran on it, and 30 of its tests failed.

One failure was the stack. `makeGenericTag` records where a tag was defined by lowering `Error.stackTraceLimit` to 2 and keeping the frame above it. Split into a binding and a core, it recorded the binding instead of the caller, and a test that checks the recorded location failed. The lift now leaves alone any function that reads `.stack`, `Error.captureStackTrace`, `Error.prepareStackTrace` or `Error.stackTraceLimit`.

The rest failed because everything ran slower: timeouts, and tests that race a timer. The first binding built its context on every call, as an object literal of getters. V8 keeps an object literal with accessors in dictionary mode, so building one per call was about 790 times slower than the original call in a microbenchmark, and the suite took 2.7 times as long. That is where the two shapes above come from. Settled values go in a plain object literal, which is cheap for V8 to build, and everything else goes through a single context, created once.

The type checker had caught other things. In the first type check of the lifted corpus, generic functions lost their type arguments through `.call`, unique symbols widened to `symbol`, and functions typed by their variable lost that type. The binding now passes type arguments explicitly and types the shared context, and typed variables are left alone, as are mapped types with `as` clauses and certain generic rest parameters, found in later rounds. Each check found what the others could not, which is why the corpus runs all of them.

## Checked, then checked again

- **Types:** the fixed source adds {{effect.typeErrorsIntroduced}} type errors.
- **Round trip:** `unlift` folds all {{effect.folded}} bindings back, and {{effect.roundTripDiffering}} files differ from the original program.
- **Tests:** Effect's suite passes on the lifted source, {{effect.suite.lifted.passed}} tests with {{effect.suite.lifted.failed}} failures, and on the source lifted and then unlifted, {{effect.suite.unlifted.passed}} tests with {{effect.suite.unlifted.failed}} failures.

## The cost, and taking it back

A lifted function costs one more call and a few property reads each time it runs. On Effect's hottest paths that shows:

<!-- bench -->

That cost is why the lift has an exact inverse. `unlift` folds each binding back into the function it came from, so the source stays hermetic and the build ships the original code, which runs within noise of Effect as published.

## Reproduce it

```sh
npm run corpus -- report            # census, fix, round trip and type checks
npm run corpus -- effect            # Effect's suite on the lifted source
npm run corpus -- effect --unlift   # and on the source lifted, then unlifted
npm run corpus -- bench             # the benchmark above
```
