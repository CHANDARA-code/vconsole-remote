# Releasing

The server and the client SDK share a version number and ship together.
Releases are cut by pushing a tag; CI does the publishing.

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

4. **Commit and tag.**

   ```bash
   git commit -am "chore(release): v1.0.1"
   git tag v1.0.1
   git push origin main --follow-tags
   ```

5. **Watch the Release workflow.** It verifies tests and the tag/version match,
   publishes the SDK to npm with provenance, and attaches server binaries for
   linux/amd64, linux/arm64 and darwin/arm64 to the GitHub release.

## After publishing

- **npm** — `npm view vconsole-remote version` should show the new version
  within a minute.
- **CDN** — jsDelivr serves from npm and caches aggressively. The versioned URL
  (`.../vconsole-remote@1.0.1/dist/vconsole-remote.js`) is available
  immediately; the unversioned one may lag up to 12 hours. Link a versioned URL
  in documentation and announcements.
- **Docker** — the `docker` CI job builds the image on every push but does not
  publish it. Add a registry push step here if you decide to distribute images.

## Versioning

[Semantic Versioning](https://semver.org). For this project specifically:

- **Major** — a wire-protocol change between SDK and server, a removed
  configuration option, or a default that becomes more restrictive in a way
  that breaks existing deployments.
- **Minor** — new capabilities, new configuration with safe defaults.
- **Patch** — fixes that do not change the protocol or defaults.

Security fixes ship as a patch on the current minor release and are noted in
both the changelog and the advisory.
