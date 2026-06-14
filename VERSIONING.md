# Versioning — codegraph-sf

`codegraph-sf` follows **[Semantic Versioning 2.0.0](https://semver.org/)** on its
**own independent version line**, decoupled from upstream `@colbymchenry/codegraph`.
The upstream commit each release is based on is recorded in `package.json`'s
`forkedFrom` field, never in the version number. Release notes live in
[`CHANGELOG-SF.md`](CHANGELOG-SF.md); release mechanics in [`FORK.md`](FORK.md).

## The rule: `MAJOR.MINOR.PATCH`

Bump by the **largest** applicable change in the release. Default to the *smallest*
bump that fits — **PATCH is the default**, not MINOR.

| Bump | When | Examples for this fork |
|------|------|------------------------|
| **PATCH** (`0.5.0 → 0.5.1`) | Bug fixes and **any change that doesn't add or break a user-facing capability** — including **merging upstream** (even when upstream itself shipped features: from a codegraph-sf consumer's view it's a non-breaking engine update). | Sync upstream; fix a resolver bug; widen coverage of an existing tool; docs/CI. |
| **MINOR** (`0.5.1 → 0.6.0`) | A **new user-facing capability the fork adds** — backwards-compatible. | A new MCP tool; a new index layer / node or edge kind a user can query; a new language/framework the fork adds. |
| **MAJOR** (`0.x → 1.0.0`, then `1.x → 2.0.0`) | A **backwards-incompatible** change to the fork's own surface, or the first commitment to a stable API. | Remove/rename an MCP tool; change a tool's input/output shape; drop a supported runtime. |

### The upstream-sync rule (the one that's easy to get wrong)

> **Merging upstream is a PATCH by default.** Upstream shipping new features does
> **not** make it a MINOR for *us* — codegraph-sf's own tools and their contracts
> are unchanged, so it's a non-breaking update from a consumer's perspective.
> It becomes MINOR only if the sync **adds a capability we expose**, and MAJOR only
> if it **breaks one of our tools**.

This is the correction to an earlier loose policy ("any feature → MINOR") that
inflated the fork from 0.1 → 0.5 in a week — most of those should have been
patches. Don't repeat that: count features the **fork** adds, not features that
ride in from upstream.

## Pre-1.0 (we are here)

While in `0.y.z`, SemVer §4 says the public API is not yet stable. We adopt the
common community convention until `1.0.0`:

- **MINOR** (`0.y`) is the breaking-or-feature lever.
- **PATCH** (`0.y.z`) is fixes and non-breaking changes.
- A breaking change pre-1.0 bumps **MINOR** (not MAJOR), but **must** be called
  out in a `### Breaking Changes` section in `CHANGELOG-SF.md`.

**Go to `1.0.0`** when we're ready to commit to a stable MCP-tool API — not before.
Don't drift toward 1.0 by reflex; a fast minor cadence is a smell that PATCH is
being skipped.

## Pre-release & channels

- Pre-releases use a SemVer suffix: `0.6.0-beta.1`, `0.6.0-rc.1`. npm treats these
  as prerelease (excluded from `^`/`~` ranges); publish them under a dist-tag:
  `npm publish --tag beta`.
- `latest` always points to the newest **stable** release.

## Mechanics

Bump `version` in `package.json`, move the `[Unreleased]` notes in
`CHANGELOG-SF.md` into a `## [X.Y.Z] - <date>` block, commit, then tag `vX.Y.Z`
and push — the publish workflow tests, publishes to npm, and creates the GitHub
Release. Full steps + the upstream-base (`forkedFrom`) update are in
[`FORK.md`](FORK.md).
