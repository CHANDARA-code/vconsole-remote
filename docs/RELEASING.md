# Releasing

The server and the client SDK share a version number and ship together.
CI does the publishing — you never run `npm publish` by hand.

Releasing affects two of the three ways people load the SDK:

| Path | Released by |
| --- | --- |
| `https://<broker>/sdk.js` | every deploy to `main` — **not** this workflow |
| `npm install vconsole-remote` | this workflow |
| jsDelivr / unpkg | this workflow, indirectly (both serve from npm) |

## One-time setup

Before the first release, these must exist:

1. **npm account with publish rights.** `npm login` locally to confirm, then
   create an automation token (`npm token create --read-only=false`).
2. **`NPM_TOKEN` repository secret.** Settings → Secrets and variables →
   Actions → New repository secret. The release workflow reads it as
   `NODE_AUTH_TOKEN`.
3. **Trusted publishing (optional but preferred).** If you configure npm
   trusted publishing for this repo, provenance works without a long-lived
   token. Otherwise the token above is used and `--provenance` still attaches
   an attestation because the workflow runs with `id-token: write`.

> Provenance requires publishing from CI. A local `npm publish` will not carry
> an attestation, which is why the workflow exists.

## Cutting a release

1. **Update the changelog.** Move entries from `## [Unreleased]` into a new
   version section with today's date, and add the comparison link at the
   bottom.

2. **Bump the version.** The tag must match `packages/vconsole-remote/package.json`
   or the release workflow fails on purpose.

   ```bash
   cd packages/vconsole-remote
   npm version patch --no-git-tag-version   # or minor / major
   cd ../..
   ```

   Keep the root and `server/package.json` versions in step by hand.

3. **Verify locally** — CI will re-run all of this, but catching it here is
   faster:

   ```bash
   npm run test:all
   ```

4. **Commit, then release one of two ways.**

   Commit the bump first either way:

   ```bash
   git commit -am "chore(release): v1.0.1"
   git push origin main
   ```

   **From the Actions tab** (no local tagging): Actions → Release → Run
   workflow → type `1.0.1`. The workflow creates and pushes the tag for you
   once its preflight checks pass.

   **Or by tag:**

   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```

5. **Watch the Release workflow.** It runs in this order, and stops at the
   first thing that is wrong:

   - **Preflight** — `NPM_TOKEN` exists, the version matches
     `package.json`, and that version is not already on npm. These are all
     seconds-long checks placed ahead of the test suite on purpose: a missing
     token used to surface as an opaque `ENEEDAUTH` ten minutes in, and npm
     versions are immutable so a duplicate can never be fixed by retrying.
   - **Verify** — server tests, SDK build and tests, `npm pack --dry-run`, a
     check that all three bundles exist and that the minified one parses and
     exposes `VConsoleRemote`, then the 4-tier E2E suite.
   - **Publish** — `npm publish --provenance`.
   - **Attach binaries** — linux/amd64, linux/arm64, darwin/arm64, built with
     the SDK embedded so a downloaded binary serves `/sdk.js` correctly.
   - **Verify npm + CDN** — polls the registry, purges jsDelivr's `@latest`
     alias, then confirms jsDelivr and unpkg actually serve the new bundle.

## After publishing

The **Verify npm + CDN** job already checks the first two of these and writes
the install snippets into the run summary, so there is normally nothing to do
by hand:

- **npm** — `npm view vconsole-remote version` should show the new version
  within a minute.
- **CDN** — jsDelivr and unpkg both serve from npm. The versioned URL
  (`.../vconsole-remote@1.0.1/dist/vconsole-remote.min.js`) appears within
  minutes; the *unversioned* one can lag up to 12 hours even after the purge
  the workflow issues. Always link a versioned URL in docs and announcements.
- **Docker** — the `docker` CI job builds the image on every push but does not
  publish it. Add a registry push step here if you decide to distribute images.

If **Verify npm + CDN** fails, the publish itself still succeeded and is
immutable — do not try to republish. It means the package is on npm but a CDN
has not picked it up yet, which resolves on its own; re-run that job to confirm.

## Versioning

[Semantic Versioning](https://semver.org). For this project specifically:

- **Major** — a wire-protocol change between SDK and server, a removed
  configuration option, or a default that becomes more restrictive in a way
  that breaks existing deployments.
- **Minor** — new capabilities, new configuration with safe defaults.
- **Patch** — fixes that do not change the protocol or defaults.

Security fixes ship as a patch on the current minor release and are noted in
both the changelog and the advisory.
