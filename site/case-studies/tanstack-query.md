---
title: TanStack Query: {{tanstack.hermeticPct}} already hermetic
description: What prefer-hermetic did to TanStack Query {{tanstack.version}}: helpers that were mostly hermetic already, stateful classes, and React hooks.
---

# TanStack Query: {{tanstack.hermeticPct}} already hermetic

<p class="lede">TanStack Query is two packages: <code>@tanstack/query-core</code>, a framework-agnostic data-fetching cache made of classes and helpers, and <code>@tanstack/react-query</code>, its React hooks. Of the three libraries, it's the closest to application code, with stateful classes, hooks and a couple of components. Much of it was hermetic before the plugin changed anything.</p>

It covers the TypeScript source that both packages publish to npm at version {{tanstack.version}}: {{tanstack.files}} files and {{tanstack.candidates}} candidate functions.

## Results

<!-- outcomes tanstack-query -->

| Outcome | Functions | Share |
| --- | ---: | ---: |
| Already hermetic, marked | {{tanstack.hermetic}} | {{tanstack.hermeticPct}} |
| Lifted | {{tanstack.lifted}} | {{tanstack.liftedPct}} |
| Skipped | {{tanstack.skipped}} | {{tanstack.skippedPct}} |

## Already hermetic

Of the {{tanstack.hermetic}} functions that were already hermetic, {{tanstack.hermeticMembers}} are methods of its classes, such as `Query`, `QueryClient` and the observers, that read nothing but `this` and their arguments. Most of the rest are small helpers, many of them in query-core's `utils.ts`, such as `partialMatchKey`, `shallowEqualObjects` and `functionalUpdate`.

<!-- example @tanstack/query-core/src/utils.ts#addToEnd -->

## Lifted

In query-core, `hashQueryKeyByOptions` falls back to `hashKey`, a function declared in the same module, so the wrapper passes it in directly:

<!-- example @tanstack/query-core/src/utils.ts#hashQueryKeyByOptions -->

In react-query, hooks written as arrow functions lift with `React` passed in directly. `React` is a namespace import, so it's always initialized:

<!-- example @tanstack/react-query/src/errorBoundaryUtils.ts#useClearResetErrorBoundary -->

## Hooks declared as functions

`useQuery`, `useMutation`, `useQueries` and most of the other hooks are function declarations that read imports. They're skipped for the same reason as RxJS's operators: a hoisted function can run before its imports are initialized, and rewriting it without changing that behavior would need a context object that may not exist yet either.

<!-- example @tanstack/react-query/src/useQuery.ts#useQuery -->

{{tanstack.hoistedOnlyImports}} of the {{tanstack.hoistedSkipped}} functions skipped for this reason read nothing that could be uninitialized except imports. Treating imports as always initialized would lift them, with the tradeoff described in the [RxJS case study](rxjs.html#what-treating-imports-as-initialized-would-change). The others also read globals, module constants or classes, so that option wouldn't be enough for them.

## Classes and components

- **Methods and object members**, {{tanstack.members}} of them, are skipped: the lift only rewrites functions declared at the top level of a module.
- `QueryClientProvider` and `QueryErrorResetBoundary` render JSX. JSX compiles to calls to a factory function that the source never names, so the lift has nothing to pass in, and both are skipped.

## Everything skipped

<!-- reasons tanstack-query -->

## Verification

The fixed source adds {{tanstack.typeErrorsIntroduced}} type errors. `unlift` turns all {{tanstack.folded}} lifted functions back into their original form, and {{tanstack.roundTripDiffering}} files differ from the original program.

## Reproduce it

```sh
npm run corpus -- report
```
