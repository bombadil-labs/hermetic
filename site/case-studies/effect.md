---
title: Effect: {{effect.lifted}} functions lifted, every test still passing
description: What prefer-hermetic did to the source of Effect {{effect.version}}, checked against Effect's own test suite and benchmarks, and how hermetic compares with Effect.
---

# Effect: {{effect.lifted}} functions lifted, every test still passing

<p class="lede">Effect is a TypeScript library for writing programs as values, with typed errors, dependency injection, concurrency and streams. This case study runs hermetic on Effect's own source code. Effect is the largest library in the corpus, and the one the lift was tested hardest against: Effect's test suite ran on the lifted source, and again after unlifting it.</p>

The study covers the TypeScript source that Effect {{effect.version}} publishes to npm: {{effect.files}} files and {{effect.candidates}} candidate functions. A candidate is an outermost function that is bound to a name, and isn't a method.

That leaves out a large part of Effect. Much of its API is written as `export const map = dual(2, (self, f) => …)`, where the implementation is an unnamed function passed to `dual`. The plugin doesn't consider unnamed functions, so this study leaves out {{effect.unnamed}} of them, {{effect.unnamedDual}} of which are passed to `dual`. It also leaves out Effect's {{effect.methods}} methods, many of them on the prototype objects and classes that Effect builds its data types from. A method's `this` is its object, not its inputs, so methods can't be hermetic yet.

## How hermetic compares with Effect

Both make a function's dependencies explicit, in different ways. This case study only uses hermetic: it checks Effect's implementation, which is ordinary TypeScript, like any other code.

In Effect, a program is a value of type `Effect<A, E, R>`: `A` is the result, `E` is the error, and `R` lists the services the program needs. Code asks for a service with `yield* Database`, the type checker adds `Database` to `R`, and the program can only run once every service in `R` has been provided, usually by a `Layer`. Effect also handles concurrency, retries, resources, streams and schemas.

Hermetic is a lint rule for plain functions. It checks that a function reads nothing but its inputs, meaning its arguments, including `this`: no imports, no module-level variables and no globals, not even built-ins such as `Math`. It has no runtime and adds no types.

| | Effect | hermetic |
| --- | --- | --- |
| What it is | A library and runtime for writing programs as values | An ESLint rule for plain functions |
| How a function gets its dependencies | As services, listed in the `R` type and provided by layers | As inputs, usually by binding `this` |
| What is checked | Every service the program asks for has been provided | The function reads nothing but its inputs |
| Reading a global directly | Allowed: `Effect.sync(() => Date.now())` adds nothing to `R` | Reported |
| Adopting it | Write code in Effect's style | Lint existing code; the `lift` fix rewrites what it can |

The two can be used together. `R` lists the services a program asks for. It doesn't list what the code reads without asking, such as `Date.now()` inside `Effect.sync`, or a module-level database client used inside `Effect.tryPromise`. If the functions in an Effect program are hermetic, everything they depend on appears either in `R` or in their inputs. Effect provides the clock and random numbers as services so that tests can replace them. A hermetic function gets them as inputs, for the same reason, and `intrinsics`, which picks out the built-ins to pass in, leaves `Date` and `Math.random` out.

Effect's own modules are inputs too. Hermetic treats every import as a value to pass in, so a hermetic function that builds Effect programs gets `Effect` through `this`, like its other dependencies.

## Results

<!-- outcomes effect -->

| Outcome | Functions | Share |
| --- | ---: | ---: |
| Already hermetic, marked | {{effect.hermetic}} | {{effect.hermeticPct}} |
| Lifted, values passed directly | {{effect.direct}} | {{effect.directPct}} |
| Lifted, values passed through a shared context | {{effect.shared}} | {{effect.sharedPct}} |
| Skipped | {{effect.skipped}} | {{effect.skippedPct}} |

## Already hermetic

{{effect.hermetic}} of Effect's functions read nothing but their inputs, so the fix only marks them: with a `"use hermetic"` directive, or, for an arrow function with an expression body, an `@hermetic` tag in its JSDoc. `reset` changes the list it's given, which a hermetic function may do. It also reads `undefined`, which is a global, but one that can't be changed, so a hermetic function may read it like a keyword:

<!-- example effect/src/MutableList.ts#reset -->

## Lifted

Most candidates are module-level functions that call other module-level functions. `Array.ts` calls its own helpers and the `Option` module, and Effect's internal modules call each other. The lift moves each function's body into a new hermetic function that reads those names from `this`. The original function keeps its name, signature and export, and becomes a wrapper that passes the names in. {{effect.direct}} wrappers pass the values directly:

<!-- example effect/src/Option.ts#fromNullable -->

Passing values directly is only safe when every name has been initialized by the time the wrapper can run, and is never reassigned. The lift calls such names *settled*. Here, `none` and `some` are declared above `fromNullable`, and `fromNullable` is a `const`, so it can't run before its own line, and by then both exist.

Names declared further down the file aren't settled. If the function ran before their declarations, the original would only fail if it actually used one of them. To keep that behavior, the wrapper passes a shared context object instead, declared right after it, whose getters read each name only when the hermetic function uses it. {{effect.shared}} lifts in Effect work this way, like `tail`, which uses `tailNonEmpty`, declared twenty lines below it:

<!-- example effect/src/Array.ts#tail -->

Globals aren't settled either. A global can be missing, like `process` outside Node, or replaced by other code, so the lift reads every global through a getter, built-ins included. {{effect.sharedForGlobals}} of the shared lifts use a context object only because of a global, like `after`, which reads `Number` as well as `make`:

<!-- example effect/src/internal/schedule/interval.ts#after -->

## Skipped, and why

<!-- reasons effect -->

- **Object members**, functions stored in an object's properties, are {{effect.membersPctOfSkipped}} of the skipped functions. The lift only rewrites functions declared at the top level of a module, because a function stored in an object may be called as a method, with the object as its `this`.
- **Typed variables**, such as `export const isChunk: { … } = …`, get their type from the annotation, not from the function. A separate hermetic function wouldn't have the annotation, so its type would change.
- **Module names used inside nested functions or classes.** `makePrimitive` returns a `function () { … }` that reads the module's `args` symbol. Inside that inner function, `this` belongs to the inner function, so it can't reach the values passed to the outer one.
- **Function declarations** are hoisted: they can run before any other line of their module. So they're only lifted when everything they read is guaranteed to exist by then. In Effect, the skipped ones read module constants, or globals, which are never settled. `absurd` is skipped because the function it returns throws an `Error`:

<!-- example effect/src/Arbitrary.ts#absurd -->

- **Functions that read the stack** would see an extra stack frame after the rewrite. This rule came from Effect's test suite, as the next section explains:

<!-- example effect/src/internal/context.ts#makeGenericTag -->

## What the test suite caught

The lift was checked with the type checker first. Once the lifted source type-checked with no new errors, we ran Effect's test suite on it, and 30 of its tests failed.

One cause was the stack. `makeGenericTag` records where a tag was defined by lowering `Error.stackTraceLimit` to 2 and keeping the frame above it. After the rewrite, it recorded the wrapper instead of the caller, and a test that checks the recorded location failed. The lift now skips any function that reads `.stack`, `Error.captureStackTrace`, `Error.prepareStackTrace` or `Error.stackTraceLimit`.

Every other failure came from the code running slower: timeouts, and a test that races a timer. The first version of the wrapper built its context object on every call, as an object literal with getters. V8 stores objects like that in a slower representation, dictionary mode, so building one per call was about 790 times slower than the original call in a microbenchmark, and the test suite took 2.7 times as long. That is why there are two kinds of wrapper today. Settled values go in a plain object literal, which is cheap for V8 to build, and everything else goes through a single context object, created once.

The type checker had found other problems earlier. In the first type check of the lifted code, generic functions lost their type arguments when called through `.call`, unique symbols widened to `symbol`, and functions typed by their variable lost that type. The wrapper now passes type arguments explicitly and gives the shared context explicit types, and typed variables are skipped. Later rounds added two more exclusions: mapped types with `as` clauses, and some generic rest parameters. The type checker, the test suite and the round trip below each found problems the others missed, so the corpus runs all three.

## Verification

- **Types:** the fixed source adds {{effect.typeErrorsIntroduced}} type errors.
- **Round trip:** `unlift` turns all {{effect.folded}} lifted functions back into their original form, and {{effect.roundTripDiffering}} files differ from the original program.
- **Tests:** Effect's suite passes on the lifted source, {{effect.suite.lifted.passed}} tests with {{effect.suite.lifted.failed}} failures, and on the source lifted and then unlifted, {{effect.suite.unlifted.passed}} tests with {{effect.suite.unlifted.failed}} failures.

## Performance

A lifted function makes one extra call and a few property reads each time it runs. On Effect's hot paths, that is measurable:

<!-- bench -->

`unlift` removes that cost. It turns each wrapper back into the original function, so the source can stay hermetic while the build runs the original code. In the table, the unlifted source performs like the second copy of the original, which means the remaining difference is noise. `unliftPlugin` runs it in Vite builds, so a production build gets the original code while the source stays hermetic.

## Reproduce it

```sh
npm run corpus -- report            # census, fix, round trip and type checks
npm run corpus -- effect            # Effect's suite on the lifted source
npm run corpus -- effect --unlift   # and on the source lifted, then unlifted
npm run corpus -- bench             # the benchmark above
```
