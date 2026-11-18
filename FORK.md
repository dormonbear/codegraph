# FORK.md — maintaining `codegraph-sf`

`codegraph-sf` is a hard fork of [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph)
that adds Salesforce-stack indexing (Apex/VF/Aura/LWC cross-layer, the React↔Apex
postMessage bridge, and the SObject field-usage/impact layer). It is published to npm
under its **own** name but **tracks upstream** — upstream fixes are merged in periodically.

The `codegraph` **bin/CLI/MCP command name is intentionally unchanged** so existing MCP
configs keep working after swapping the package.

## Repo layout

| Remote   | Repo                          | Role                          |
|----------|-------------------------------|-------------------------------|
| `upstream` | `colbymchenry/codegraph`    | source of truth for the engine |
| `origin` | `dormonbear/codegraph`        | this fork (published as `codegraph-sf`) |

Current base: forked from upstream `main` @ `471084d` (2026-06-06).

If your remotes are still named the old way (`origin`=colbymchenry, `fork`=dormonbear),
rename them once so the commands below read correctly:

```bash
git remote rename origin upstream
git remote rename fork   origin
```

## Why upstream syncs stay tractable

The fork is **almost purely additive** (~+2500 / −10 lines). The bulk lives in **new
files upstream never touches** (`src/resolution/frameworks/salesforce.ts`,
`src/extraction/sobject-schema-extractor.ts`, `src/extraction/salesforce-metadata-extractor.ts`,
`src/extraction/wasm/tree-sitter-apex.wasm`, …). The edits to **shared core files** are
insertions at stable hook points, not rewrites:

- `src/extraction/tree-sitter.ts` — apex field-usage hooks in `visitNode` + `visitForCallsAndStructure`
- `src/extraction/grammars.ts` — `isSObjectFieldMeta` / `isSalesforceMetadata` dispatch
- `src/types.ts` — `sobject_field` NodeKind + `field_*` EdgeKinds
- `src/resolution/name-matcher.ts` — `apex: 'apex'` in upstream's `CODE_FAMILY` (the cross-family `calls` gate)
- `src/resolution/frameworks/salesforce.ts` — its `languages` list must cover every JS dialect (`javascript`/`typescript`/`tsx`/`jsx`); upstream only runs a framework resolver for languages it lists
- `src/extraction/index.ts` — `mergeSalesforceMetadata` wraps `scanDirectory`'s results
- `src/mcp/tools.ts`, `src/index.ts`, `src/mcp/server-instructions.ts`, `src/db/queries.ts` — the field/object tools
- `src/bin/codegraph.ts` — `codegraph daemon gc`
- `AGENTS.md` — the fork note in `## Releases` (`CLAUDE.md` is upstream's thin `@AGENTS.md` wrapper; take theirs)
- `package.json` — name/version/`forkedFrom`/`prepare` (always a conflict; **keep ours**, take upstream's other fields); `ui/package.json` `version` must equal ours (`ui-package.test.ts`)
- `telemetry-dashboard/`, `telemetry-worker/` — upstream's own telemetry service, left out of the fork: on conflict keep ours / drop upstream's added files and tests (e.g. `__tests__/telemetry-services.test.ts`)

So `git merge upstream/main` typically conflicts in ~10–15 known files, each a simple
"both sides added lines" resolution.

## Sync from upstream

```bash
git fetch upstream
git merge upstream/main          # or: git rebase upstream/main
# resolve conflicts in the files above; for package.json keep our name/version
npm install
npm test                         # full vitest suite must stay green
```

After merging:

1. Bump `EXTRACTION_VERSION` in `src/extraction/extraction-version.ts` **only if**
   upstream's extraction logic changed in a way that invalidates cached indexes.
2. Update the `forkedFrom` field in `package.json` to the new upstream base
   (`upstreamVersion` = upstream's `package.json` version, `upstreamCommit` = the
   merged upstream commit). This is the only record of "which upstream am I on" —
   the published version number is independent (see below).

## Versioning policy

The authoritative policy is **[`VERSIONING.md`](VERSIONING.md)** (SemVer 2.0.0,
independent fork line). In short:

- **PATCH is the default** — including **merging upstream** (upstream shipping
  features does NOT make it a minor for us; our tool contracts are unchanged).
- **MINOR** only when the **fork** adds a user-facing capability (a new MCP tool,
  a new index layer).
- **MAJOR** for a backwards-incompatible change to our own tools.

Never mirror upstream's number; the upstream base is tracked in `forkedFrom`
(`npm view codegraph-sf forkedFrom`), not the version string.

## Publish a new version

Publishing is automated by `.github/workflows/npm-publish.yml` via npm **Trusted
Publishing (OIDC)** — no stored npm token. The `prepare` hook builds `dist/` on publish.

```bash
# 1. bump "version" in package.json per the policy above
# 2. resync the lock:  npm install --package-lock-only --ignore-scripts
# 3. commit, then tag — the tag MUST equal package.json's version
git commit -am "chore: release vX.Y.Z"
git tag vX.Y.Z && git push origin salesforce vX.Y.Z
```

The workflow verifies the tag matches `package.json`, runs the suite, and publishes.
A manual run is also available from the Actions tab (`workflow_dispatch`). Node 20–24.

## What must never change on sync

- Package `name` stays `codegraph-sf`; `bin` stays `codegraph`.
- The Salesforce new-files and the hook insertions above — re-apply them if an upstream
  refactor moves a hook point.
