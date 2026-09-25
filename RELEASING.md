# Releasing

This repository publishes two packages to npm, always together and at the same version:

- [`@bombadil/hermetic`](packages/hermetic): `check`, `confine` and `intrinsics`.
- [`@bombadil/eslint-plugin-hermetic`](packages/eslint-plugin-hermetic): the ESLint rules. It depends on exactly the same version of `@bombadil/hermetic`.

The [Release workflow](.github/workflows/release.yml) publishes them when a GitHub release is published. It uses npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers): npm accepts the workflow's OpenID Connect token instead of a stored secret, so no npm token lives in the repository or its settings, and each version carries a provenance attestation that links it to the run that built it.

## One-time setup

`@bombadil/hermetic` is already set up. `@bombadil/eslint-plugin-hermetic` isn't yet: it has never been published, and npm attaches a trusted publisher only to a package that already exists. Do these steps once for it.

1. **Publish the first version by hand.** On a clean checkout of `main`, with Node 22.18 or later, two-factor authentication on your npm account, and publish rights in the `bombadil` npm organization, which also owns `@bombadil/loam`:

   ```sh
   npm ci
   npm run check
   npm login
   npm publish --workspace @bombadil/eslint-plugin-hermetic
   ```

   `prepublishOnly` builds the package from a clean `dist` first, and `publishConfig` makes the scoped package public. This first version is the only one without provenance. If it is the version you are about to release, the Release workflow skips it and publishes `@bombadil/hermetic` alone.

2. **Trust the Release workflow.** On npmjs.com, open the package's settings, and under trusted publishing add GitHub Actions with:

   | Field | Value |
   | --- | --- |
   | Organization or user | `bombadil-labs` |
   | Repository | `hermetic` |
   | Workflow filename | `release.yml` |
   | Environment | `npm` |

   Or, with npm 11.15 or later:

   ```sh
   npm trust github @bombadil/eslint-plugin-hermetic --repo bombadil-labs/hermetic --file release.yml --env npm --allow-publish
   ```

   A trusted publisher cannot be edited, only deleted and added again, so rename the repository first if you are going to.

3. **Disallow tokens.** In the package's settings, under publishing access, choose "Require two-factor authentication and disallow tokens". The workflow keeps publishing; a leaked token can no longer.

The `npm` environment is shared by both packages. To require an approval before every publish, add required reviewers under the repository's Settings → Environments → `npm`.

## Moving to 0.3.0

Up to 0.2.0, `@bombadil/hermetic` was the ESLint plugin. From 0.3.0 it holds `check` and `confine`, and the rules are in `@bombadil/eslint-plugin-hermetic`. An ESLint config that imports `@bombadil/hermetic` stops working on 0.3.0, so after the 0.3.0 release, point users of the old versions at the new package:

```sh
npm deprecate "@bombadil/hermetic@<0.3.0" "The ESLint rules moved to @bombadil/eslint-plugin-hermetic. From 0.3.0, @bombadil/hermetic is the runtime package: check and confine."
```

## Each release

1. Set the new version in a pull request, and merge it:

   ```sh
   node scripts/version.mjs 0.4.0   # or a pre-release, such as 0.4.0-beta.1
   ```

   This sets the version of both packages and the plugin's dependency on `@bombadil/hermetic`, and updates `package-lock.json`. Don't use `npm version` for this: it leaves the plugin depending on the old version, which npm would then install from the registry instead of linking the workspace.

2. Publish a GitHub release on `main` whose tag is `v` and the new version, such as `v0.4.0`, from the releases page or with:

   ```sh
   gh release create v0.4.0 --target main --generate-notes
   ```

   Mark versions with a hyphen, such as `0.4.0-beta.1`, as pre-releases.

3. The Release workflow checks that the tag matches both packages, runs `npm run check`, and publishes `@bombadil/hermetic`, then `@bombadil/eslint-plugin-hermetic`. A pre-release version goes to the `next` dist-tag, and any other version to `latest`. A package that is already on npm at that version is skipped, so if a run fails partway, fix the cause and run it again.

To rehearse, run the Release workflow from the Actions tab. It checks, builds and packs both packages, and publishes nothing.
