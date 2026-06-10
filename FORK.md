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
- `src/resolution/name-matcher.ts` — the cross-family `calls` gate
- `src/mcp/tools.ts`, `src/index.ts`, `src/mcp/server-instructions.ts` — the field tools
- `package.json` — name/version (always a conflict; **keep ours**)

So `git merge upstream/main` typically conflicts in ~6–8 known files, each a simple
"both sides added lines" resolution.

## Sync from upstream

```bash
git fetch upstream
git merge upstream/main          # or: git rebase upstream/main
# resolve conflicts in the files above; for package.json keep our name/version
npm install
npm test                         # full vitest suite must stay green
```

After merging, bump `EXTRACTION_VERSION` in `src/extraction/extraction-version.ts`
**only if** upstream's extraction logic changed in a way that invalidates cached indexes.

## Publish a new version

This fork ships as a **plain npm package** (no bundled-runtime release workflow — that
upstream machinery is not used). The `prepare` hook builds `dist/` on install/publish.

```bash
# 1. bump version in package.json (independent of upstream's version)
# 2. update CHANGELOG if you keep one
npm test
npm publish                      # unscoped public package → publishes publicly
```

Requires `npm login` as the account that owns the `codegraph-sf` name. Node 20–24.

## What must never change on sync

- Package `name` stays `codegraph-sf`; `bin` stays `codegraph`.
- The Salesforce new-files and the hook insertions above — re-apply them if an upstream
  refactor moves a hook point.
