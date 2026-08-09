# Release Checklist

Use this checklist for every npm release. Publishing a GitHub Release triggers `.github/workflows/publish.yml`, which validates one canonical archive and publishes it to both registries:

- npmjs: `pi-xai-oauth`
- GitHub Packages: `@blockedpath/pi-xai-oauth`

Do **not** run `npm publish` locally.

## 1. Prepare the release on a branch

Choose the appropriate version increment:

```bash
git switch -c release/next
npm version patch --no-git-tag-version
# Use "minor" or "major" instead of "patch" when appropriate.
```

Update `CHANGELOG.md` and any affected documentation. Confirm that `package.json` and `package-lock.json` contain the same new version.

Run the release gates:

```bash
NODE_OPTIONS=--unhandled-rejections=strict npm test
npm run typecheck
npm run compatibility:check
npm run compatibility:boundaries
npm pack --dry-run --json
git diff --check
```

Commit the release, push the branch, open a pull request, wait for CI, and merge it into `main`.

## 2. Tag the merged commit

```bash
git switch main
git pull --ff-only origin main

VERSION=$(node -p 'require("./package.json").version')
git tag "v$VERSION"
git push origin "v$VERSION"
```

The tag must be exactly `v` followed by the `package.json` version, and its commit must be contained in `main`.

## 3. Publish the GitHub Release

```bash
gh release create "v$VERSION" \
  --verify-tag \
  --generate-notes \
  --title "v$VERSION"
```

A tag push alone does not publish the packages. The workflow starts only when the non-prerelease GitHub Release is published.

## 4. Monitor the workflow

```bash
RUN_ID=$(gh run list \
  --workflow publish.yml \
  --event release \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')

gh run watch "$RUN_ID"
```

The workflow will:

1. Verify that the tag matches `package.json` and belongs to `main`.
2. Run tests, typecheck, package checks, and exact supported Pi boundaries.
3. Build one canonical tarball.
4. Publish that tarball to npmjs through trusted publishing.
5. Derive and publish the scoped GitHub Packages mirror with `GITHUB_TOKEN`.

The existing GitHub package visibility remains public for later versions.

## 5. Verify both publications

```bash
npm view "pi-xai-oauth@$VERSION" version
npm view "@blockedpath/pi-xai-oauth@$VERSION" version \
  --registry=https://npm.pkg.github.com
```

The GitHub Packages command requires npm authentication with a classic PAT containing `read:packages`.

Also confirm that the workflow completed successfully:

```bash
gh run view "$RUN_ID"
```

## Recover from a partial failure

Find the failed release run and rerun it:

```bash
gh run list --workflow publish.yml --event release
gh run rerun RUN_ID --failed
```

The workflow checks whether each version already exists before publishing. If npmjs succeeded but GitHub Packages failed, a rerun skips npmjs and retries the missing mirror.

## Important safeguards

- Never reuse or overwrite an already published version; bump the version instead.
- Never publish from a local checkout.
- Never store a long-lived npm token in GitHub Actions; npmjs uses trusted publishing/OIDC.
- Do not rename `.github/workflows/publish.yml` without updating the npm trusted-publisher configuration.
- Do not manually edit the scoped mirror name in `package.json`; the workflow generates it from the canonical tarball.
