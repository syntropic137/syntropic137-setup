# Releasing

## Versioning scheme

This package tracks the Syntropic137 platform version but can also release independently.

- **`version`** in `package.json` — the npm publish version (standard semver)
- **`platformVersion`** in `package.json` — the Syntropic137 release these templates came from

**Rule: `version` >= `platformVersion`, always.** CI enforces this.

### How it works

| Event | `version` | `platformVersion` |
|-------|-----------|-------------------|
| Syntropic releases `0.19.0` | `0.19.0` | `0.19.0` |
| CLI-only bug fix | `0.19.1` | `0.19.0` |
| Another CLI fix | `0.19.2` | `0.19.0` |
| Syntropic releases `0.19.1` | `0.19.3`* | `0.19.1` |
| Syntropic releases `0.20.0` | `0.20.0` | `0.20.0` |

*Template sync never goes backwards — if `version` is already past the platform release, it bumps to `version + 1`.

### Why not a fourth segment?

npm requires strict semver. `0.19.0.1` is invalid. Pre-release segments (`0.19.0-rev.1`) sort *before* `0.19.0` and break `^` ranges. Build metadata (`0.19.0+1`) is ignored by npm. The `platformVersion` field solves this cleanly without fighting semver.

## When a new platform version is released

1. A release on [syntropic137/syntropic137](https://github.com/syntropic137/syntropic137) triggers a `workflow_dispatch` to this repo
2. The **template-sync** workflow:
   - Downloads digest-pinned templates from the **release assets** (not source files)
   - Sets `platformVersion` to the release version
   - Bumps `version` to at least the release version (never goes backwards)
   - Opens a PR
3. Review the PR — check the diff against the release notes
4. Merge the PR

## Publishing to npm

Publishing is always manual. It never happens automatically, even after a template sync merge.

1. Go to **Actions -> Publish to npm -> Run workflow**
2. Optionally run with "Dry run" checked first to verify the package contents
3. Run again with dry run unchecked to publish

The publish workflow runs type checking (`tsc --noEmit --strict`), tests, and builds before publishing. If any step fails, nothing is published.

## CLI-only releases

For changes that only touch CLI code (not templates):

1. Bump `version` in `package.json` — `platformVersion` stays the same
2. Publish as normal

The CI consistency check will verify that `version >= platformVersion` and that templates still have valid digest pins.

## CI consistency checks

Every PR is validated:

- `version >= platformVersion` (no version regression)
- All `ghcr.io` images in the compose file use `@sha256:` digest pins (no floating tags like `:latest` or `:v0.19.0`) and the digests exist in GHCR; third-party images are tag-pinned only

## First-time setup

Publishing uses [npm Trusted Publishing](https://docs.npmjs.com/generating-provenance-statements) (OIDC) — no npm token is stored in GitHub secrets. Both steps below are **required** for the publish workflow to succeed.

### 1. Create the `npm-publish` GitHub environment

The publish workflow references `environment: npm-publish`. GitHub Actions will fail if this environment doesn't exist.

1. Go to **Settings -> Environments -> New environment**
2. Name it exactly `npm-publish`
3. Configure protections:
   - **Deployment branches**: select "Selected branches" -> add `main` (prevents publishing from feature branches)
   - **Wait timer** (recommended): set to 5-30 minutes to give yourself time to cancel a rogue publish
   - **Required reviewers**: add reviewers if you have multiple maintainers (not possible for solo devs -- GitHub doesn't allow self-approval)

### 2. Configure Trusted Publisher on npmjs.com

1. Go to `@syntropic137/setup` -> Settings -> Publishing access
2. Add a Trusted Publisher with these exact values:
   - **Repository**: `syntropic137/syntropic137-setup`
   - **Workflow**: `publish.yml`
   - **Environment**: `npm-publish`
   - **Allowed actions**: enable direct publish (the workflow runs `npm publish`). Without it the publish fails with `403 OIDC permission denied for this action`. Leave dist-tags off.

The fields are fixed once saved. If the repo is ever renamed again, delete the entry and create a new one before the next publish.

Every published version includes a provenance attestation linking it to the exact commit and workflow run. Users can verify with `npm audit signatures`.

### Publishing locally (alternative)

If the GitHub environment isn't set up yet, you can publish from your local machine:

```sh
npm login --scope=@syntropic137   # required once -- authenticates with the scoped org
npm run build && npm test && npm publish --access public
```

Note: local publishes don't include provenance attestations (those require GitHub Actions OIDC).

See [repository-setup.md](./repository-setup.md) for the full branch protection and upstream dispatch configuration.
