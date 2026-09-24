# Releasing

Versions of `eslint-plugin-hermetic` are published to npm by the [Release workflow](.github/workflows/release.yml) when a GitHub release is published. It uses npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers): npm accepts the workflow's OpenID Connect token instead of a stored secret, so no npm token lives in the repository or its settings, and each version carries a provenance attestation that links it to the run that built it.

## One-time setup

1. **Publish the first version by hand.** npm attaches a trusted publisher only to a package that already exists. On a clean checkout of `main`, with Node 22.18 or later and two-factor authentication on your npm account:

   ```sh
   npm login
   npm publish
   ```

   `prepublishOnly` runs the full check and a clean build first. This first version is the only one without provenance.

2. **Trust the Release workflow.** On npmjs.com, open the package's settings, and under trusted publishing add GitHub Actions with:

   | Field | Value |
   | --- | --- |
   | Organization or user | `bombadil-labs` |
   | Repository | `ts-isolated` |
   | Workflow filename | `release.yml` |
   | Environment | `npm` |

   Or, with npm 11.15 or later:

   ```sh
   npm trust github eslint-plugin-hermetic --repo bombadil-labs/ts-isolated --file release.yml --env npm --allow-publish
   ```

   A trusted publisher cannot be edited, only deleted and added again, so rename the repository first if you are going to.

3. **Disallow tokens.** In the package's settings, under publishing access, choose "Require two-factor authentication and disallow tokens". The workflow keeps publishing; a leaked token can no longer.

4. **Optionally, require an approval.** GitHub creates the `npm` environment on the workflow's first run. Under the repository's Settings → Environments → `npm`, add required reviewers, and every publish waits for one of them.

## Each release

1. Bump the version in a pull request, and merge it:

   ```sh
   npm version minor --no-git-tag-version   # or patch, major, or an exact version such as 0.2.0-beta.1
   ```

2. Publish a GitHub release on `main` whose tag is `v` and the new version, such as `v0.2.0`, from the releases page or with:

   ```sh
   gh release create v0.2.0 --target main --generate-notes
   ```

   Mark versions with a hyphen, such as `0.2.0-beta.1`, as pre-releases.

3. The Release workflow checks that the tag matches `package.json`, runs the checks, builds and publishes. A pre-release version goes to the `next` dist-tag, and any other version to `latest`.

To rehearse, run the Release workflow from the Actions tab. It does everything except publish.
