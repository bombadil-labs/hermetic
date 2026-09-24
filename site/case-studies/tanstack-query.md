---
title: TanStack Query: {{tanstack.hermeticPct}} already hermetic
description: What prefer-hermetic did to TanStack Query {{tanstack.version}}: a utility core that was mostly hermetic already, stateful classes, and React hooks.
---

# TanStack Query: {{tanstack.hermeticPct}} already hermetic

<p class="lede">TanStack Query is two packages: <code>@tanstack/query-core</code>, a framework-agnostic cache of classes and utilities, and <code>@tanstack/react-query</code>, its React hooks. Of the three libraries, it looks most like application code, with stateful classes, hooks and a couple of components. Much of it was hermetic before the plugin touched it.</p>

This covers the TypeScript source both packages ship on npm at {{tanstack.version}}: {{tanstack.files}} files and {{tanstack.candidates}} candidate functions.

<!-- outcomes tanstack-query -->

| Outcome | Functions | Share |
| --- | ---: | ---: |
| Already hermetic, marked | {{tanstack.hermetic}} | {{tanstack.hermeticPct}} |
| Lifted | {{tanstack.lifted}} | {{tanstack.liftedPct}} |
| Left alone | {{tanstack.skipped}} | {{tanstack.skippedPct}} |

## A core already sealed

Of the {{tanstack.hermetic}} functions that were already hermetic, {{tanstack.hermeticMembers}} are methods of its classes, `Query`, `QueryClient` and the observers, that reach only their own `this` and their arguments. Most of the rest are small helpers, many of them in query-core's `utils.ts`, such as `partialMatchKey`, `shallowEqualObjects` and `functionalUpdate`.

<!-- example @tanstack/query-core/src/utils.ts#addToEnd -->

## Lifted

In query-core, `hashQueryKeyByOptions` falls back to `hashKey`, a function declared in the same module, so the binding passes it in directly:

<!-- example @tanstack/query-core/src/utils.ts#hashQueryKeyByOptions -->

In react-query, hooks written as arrows lift with `React` passed in directly. `React` is a namespace import, so it is always there:

<!-- example @tanstack/react-query/src/errorBoundaryUtils.ts#useClearResetErrorBoundary -->

## Hooks declared as functions

`useQuery`, `useMutation`, `useQueries` and most of the other hooks are function declarations that read imports. They are left alone for the same reason as RxJS's operators: a hoisted function can run before its imports are initialized, and splitting it exactly would need a context that may not exist yet.

<!-- example @tanstack/react-query/src/useQuery.ts#useQuery -->

{{tanstack.hoistedOnlyImports}} of the {{tanstack.hoistedSkipped}} functions left alone for this reason read nothing unsettled except imports. Treating imports as settled would lift them, at the cost described in the [RxJS case study](rxjs.html#what-one-opt-in-would-change). The others also read globals, module constants or classes, which imports alone would not settle.

## Classes and components

- **Methods and object members**, {{tanstack.members}} of them, are left alone: the lift splits only functions declared at the top of a module.
- `QueryClientProvider` and `QueryErrorResetBoundary` render JSX, which compiles to calls of a factory the source never names, so there is nothing for the lift to pass in. They are left for a person.

## Everything left alone

<!-- reasons tanstack-query -->

## Checked

The fixed source adds {{tanstack.typeErrorsIntroduced}} type errors. Unlifting it folds all {{tanstack.folded}} bindings back, and {{tanstack.roundTripDiffering}} files differ from the original program.

## Reproduce it

```sh
npm run corpus -- report
```
