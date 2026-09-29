# Working in this repository

## Vocabulary

Write with the words in [VOCABULARY.md](VOCABULARY.md), each in its one meaning: in docs, rule messages, test names, the public API and the code the lift writes. If a new idea needs a word, add it there first. The docs use plain, short sentences, and say what a thing does rather than what it is like.

## Checking a change

- `npm run check` runs the typecheck, lint and every test. CI also runs `npm run build`, on Node 22, 24 and 26, with ESLint 9 and 10, and on Windows.
- Some docs are tested: `docs.test.ts` lints the rule docs' examples and checks the fix `prefer-hermetic.md` shows, and `readme.test.ts` checks the core README's first `check` example and its table of intrinsics.
- `npm run site -- <dir>` builds the site. A placeholder the corpus report can't fill fails the build.

## The corpus

`npm run corpus` measures the rules on Effect, RxJS and TanStack Query, downloaded into `.corpus/`.

- Never commit inside `.corpus/`. `.corpus/effect-repository` is a checkout of Effect's own repository.
- Each result records the commit it came from, and `report` says when they differ, so commit before a run and don't commit during one. Only `packages/*/src`, `scripts/corpus.mjs`, the package manifests and the lockfile count as the measured code.
- Run nothing heavy alongside `effect` or `bench`: Effect's suite has tests that time out under load, and the benchmark needs an idle machine.
- `site/data/corpus.json` is written by `npm run corpus -- report`. Don't edit it by hand.
