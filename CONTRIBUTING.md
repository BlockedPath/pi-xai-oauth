# Contributing to pi-xai-oauth

Thank you for your interest in contributing to **pi-xai-oauth**! This guide will help you get started.

## Code of Conduct

This project and everyone participating in it is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to the maintainers.

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the existing issues to avoid duplicates. When you create a bug report, please include as many details as possible:

- **Use a clear and descriptive title**
- **Describe the exact steps to reproduce the behavior**
- **Provide specific examples to demonstrate the steps**
- **Describe the behavior you observed after following the steps**
- **Explain which behavior you expected to see instead and why**
- **Include screenshots if possible**

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, please include:

- **Use a clear and descriptive title**
- **Provide a step-by-step description of the suggested enhancement**
- **Provide specific examples to demonstrate the steps**
- **Describe the current behavior and explain the expected behavior**
- **Explain why this would be useful to most users**

### Pull Requests

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Setup

```bash
# Clone the repository
git clone https://github.com/BlockedPath/pi-xai-oauth.git
cd pi-xai-oauth

# Install dependencies
npm install

# Run the complete policy + focused unit + real-loader suite
npm test
npm run typecheck

# Run one suite or one named regression while developing
npm run test:unit -- tests/catalog/cache.test.ts
npm run test:unit -- -t "invalidates stale entitlements"
npm run test:watch

# Run measured V8 coverage and the loader smoke independently
npm run test:coverage
npm run test:loader

# Fail on leaked asynchronous errors
NODE_OPTIONS=--unhandled-rejections=strict npm test

# Verify compatibility policy, package metadata, and unsupported peers
npm run compatibility:check

# Verify the exact minimum/latest Pi boundaries from a clean packed package
npm run compatibility:boundaries

# Test the CLI
node bin/setup.js --help
```

## Pi Compatibility and Release Changes

Maintainers should follow the exact dual-registry checklist in [`RELEASING.md`](RELEASING.md) for every release.

The compatibility contract lives in `compatibility/pi-versions.json`. Both Pi peer ranges must remain aligned, normal development dependencies must be exact at the policy's `latest` release, and CI derives its two exact matrix cells from that policy. Each release keeps npmjs `pi-xai-oauth` canonical and derives the GitHub Packages mirror `@blockedpath/pi-xai-oauth` from that exact tarball; `node scripts/verify-github-package.js` checks version, repository, peer, setup-name, and file-path parity.

To evaluate a future Pi release without advertising it prematurely:

```bash
node scripts/run-compatibility-matrix.js X.Y.Z --candidate
```

This changes metadata only inside a temporary extracted tarball. For a patch inside the allowed line, update the policy `latest`, both exact Pi dev dependencies, and `package-lock.json` only after the candidate passes. For a new pre-1.0 minor, keep the existing upper bound during evaluation and widen it only after the exact candidate passes the full packed tests/typecheck and review. If the minimum changes, test the immediately previous published release as unsupported and document the support break.

The xAI wire contract has an independent review process in [`compatibility/grok-build-wire-protocol.md`](compatibility/grok-build-wire-protocol.md). Pin an immutable upstream Grok Build commit, trace header/ID ownership from source, preserve the package's truthful identity and pinned routes, update request-shape/privacy tests, and never copy an official client version merely to bypass a gate. Encrypted reasoning changes must preserve the documented opaque replay, route/model isolation, local-session privacy, and redacted terminal-error contract.

Every dependency/compatibility PR and release must run:

```bash
npm test
NODE_OPTIONS=--unhandled-rejections=strict npm test
npm run test:coverage
npm run typecheck
npm run compatibility:check
node scripts/verify-github-package.js
npm run compatibility:boundaries
npm pack --dry-run --json
git diff --check
```

Do not use `--legacy-peer-deps` or `--force` for supported-version validation. The verifier uses `--force` only inside temporary negative fixtures to prove npm emits peer warnings for unsupported hosts.

## Style Guidelines

- Use TypeScript strict mode
- Prefer async/await for OAuth and API calls
- Add JSDoc for all exported functions
- Keep OAuth callback server minimal and secure
- Never log sensitive tokens

## Commit Messages

We follow conventional commits:

- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `refactor:` for code refactoring
- `test:` for adding tests
- `chore:` for maintenance tasks

## Questions?

Feel free to open an issue with the label `question` if you have any questions about contributing.

Thank you for contributing! 🚀
