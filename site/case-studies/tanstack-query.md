---
title: TanStack Query: {{tanstack.hermeticPct}} already hermetic
description: What prefer-hermetic did to TanStack Query {{tanstack.version}}: stateful classes, helpers that read built-ins and the clock, and React hooks.
---

# TanStack Query: {{tanstack.hermeticPct}} already hermetic

<p class="lede">TanStack Query is two packages: <code>@tanstack/query-core</code>, a framework-agnostic data-fetching cache made of classes and helpers, and <code>@tanstack/react-query</code>, its React hooks. Of the three libraries, it's the closest to application code, with stateful classes, hooks and a couple of components. {{tanstack.methodsPctOfNamed}} of its named functions are methods, which can't be hermetic yet, and its helpers read built-ins, the clock among them.</p>

It covers the TypeScript source that both packages publish to npm at version {{tanstack.version}}: {{tanstack.files}} files and {{tanstack.candidates}} candidate functions, not counting {{tanstack.methods}} methods.

## Results

<!-- outcomes tanstack-query -->

| Outcome | Functions | Share |
| --- | ---: | ---: |
| Already hermetic, marked | {{tanstack.hermetic}} | {{tanstack.hermeticPct}} |
| Lifted | {{tanstack.lifted}} | {{tanstack.liftedPct}} |
| Skipped | {{tanstack.skipped}} | {{tanstack.skippedPct}} |

## Already hermetic

The {{tanstack.hermetic}} functions that were already hermetic are small helpers, many of them in query-core's `utils.ts`, such as `functionalUpdate`, `addToStart` and `addToEnd`, and react-query's option helpers, such as `queryOptions`.

<!-- example @tanstack/query-core/src/utils.ts#addToEnd -->

## Helpers that read built-ins

Other helpers in `utils.ts` read built-ins: `partialMatchKey` and `shallowEqualObjects` call `Object.keys`, and `timeUntilStale` reads the clock. They're function declarations, which can run before the rest of their module, so the lift only rewrites them when it can pass every value directly. A global can be missing or replaced, so it never passes one directly, and skips them:

<!-- example @tanstack/query-core/src/utils.ts#timeUntilStale -->

A hermetic `timeUntilStale` would get `Math` and the clock through `this`, so a test could pass it a fixed time.

## Lifted

In query-core, `hashQueryKeyByOptions` falls back to `hashKey`, a function declared in the same module, so the wrapper passes it in directly:

<!-- example @tanstack/query-core/src/utils.ts#hashQueryKeyByOptions -->

In react-query, hooks written as arrow functions lift with `React` passed in directly. `React` is a namespace import, so it's always initialized:

<!-- example @tanstack/react-query/src/errorBoundaryUtils.ts#useClearResetErrorBoundary -->

## Hooks declared as functions

`useQuery`, `useMutation`, `useQueries` and most of the other hooks are function declarations that read imports. They're skipped for the same reason as RxJS's operators: a hoisted function can run before its imports are initialized, and rewriting it without changing that behavior would need a context object that may not exist yet either.

<!-- example @tanstack/react-query/src/useQuery.ts#useQuery -->

{{tanstack.hoistedOnlyImports}} of the {{tanstack.hoistedSkipped}} functions skipped for this reason read nothing that could be uninitialized except imports. The `importsSettled` option would lift them, with the tradeoff described in the [RxJS case study](rxjs.html#what-treating-imports-as-initialized-would-change). The others also read globals, module constants or classes, so the option isn't enough for them.

## Classes and components

- **Methods**, {{tanstack.methods}} of them, in `Query`, `QueryClient`, the caches and the observers, aren't counted. A method's `this` is its object, not its inputs, so methods can't be hermetic yet.
- **Object members**, {{tanstack.members}} of them, are skipped: the lift only rewrites functions declared at the top level of a module. They're the default timers in `timeoutManager.ts`, which call the global `setTimeout` and its relatives.
- `QueryClientProvider` and `QueryErrorResetBoundary` render JSX. JSX compiles to calls to a factory function that the source never names, so the lift has nothing to pass in, and both are skipped.

## Everything skipped

<!-- reasons tanstack-query -->

## Verification

The fixed source adds {{tanstack.typeErrorsIntroduced}} type errors. `unlift` turns all {{tanstack.folded}} lifted functions back into their original form, and {{tanstack.roundTripDiffering}} files differ from the original program.

## Reproduce it

```sh
npm run corpus -- report
```
