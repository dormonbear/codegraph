# Changelog — codegraph-sf

The release log for the **codegraph-sf** fork. Versions are the fork's own line
(independent of upstream — see [`FORK.md`](FORK.md)). For the upstream engine's
own changes, see [`CHANGELOG.md`](CHANGELOG.md).

## [Unreleased]

## [0.5.2] - 2026-06-17

### Fixes
- **The first query after opening a project no longer hangs on large Salesforce orgs.** When a git branch-switch or pull dirties tens of thousands of metadata files, CodeGraph reconciles them in the background instead of blocking your first `codegraph_explore` / `codegraph_search` until the whole catch-up finishes — it now serves the (slightly stale) graph after a brief wait while the sync completes behind the scenes. Set `CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS=0` to restore the old wait-for-full-sync behavior.

### New Features
- Synced the upstream engine — impact analysis now follows same-file value references (a value assigned in one place and used in another) across C/C++, C#, Dart, Java, Kotlin, Scala, and more, so "what breaks if I change this" is more complete.

## [0.5.1] - 2026-06-15

### Fixes
- **Salesforce object queries no longer hang on large orgs.** `codegraph_object_search` / `codegraph_object_impact` on an object with many fields (and an org with hundreds of thousands of edges) could take minutes; they now return in well under a second. Same results, far less work.
- The on-disk graph no longer balloons: the database's write-ahead log is now bounded and reclaimed after each sync instead of growing without limit (a large re-index could otherwise leave a multi-gigabyte file behind).
- Re-scanning a Salesforce project for changes is faster — the schema-metadata sweep dropped redundant filesystem work.

### New Features
- Synced the upstream engine (`@colbymchenry/codegraph` v1.0.1) — adds **R** language support and upstream extraction/resolution improvements, all under the unchanged `codegraph` command.
- New `codegraph daemon gc` command reaps leaked/orphaned MCP daemon processes (use `--dry-run` to preview). Handy if background `codegraph` processes accumulate across many editor sessions.

> **Note:** upgrading rebuilds each project's index once on first use — the engine's extraction format advanced with the upstream sync.

## [0.5.0] - 2026-06-14

### New Features
- The SObject schema is now indexed **even when `force-app/main/default/objects/` is `.gitignore`d** — common on large or org-managed projects, where the field/object tools would otherwise come up empty. The schema metadata is always picked up.
- **Usage inference**: when an object or field is referenced from Apex/SOQL/LWC but has no metadata in source (standard objects like Account, managed-package objects, or a gitignored schema), CodeGraph now infers it from how it's used so `codegraph_object_*` / `codegraph_field_*` still answer. Inferred entries are labelled (no field types or relationships — real metadata always wins).
- **Polymorphic lookups** now link to every target object, not just the first.
- `codegraph_object_impact` now also lists the object's **own** parent lookups (what it depends on), alongside the child objects that orphan when it's deleted.
- Master-detail relationships are distinguished from plain lookups.

## [0.4.0] - 2026-06-14

### New Features
- New **SObject object layer** with three MCP tools — `codegraph_object_search`, `codegraph_object_usages`, and `codegraph_object_impact`. Ask where an object is used (SOQL `FROM`, DML, `List<Obj>`, `trigger on Obj`, Visualforce `standardController`) and get the full blast radius before renaming or deleting it: code usages **plus** the declarative metadata that breaks silently (Page Layouts, Validation Rules, Flows, Permission Sets, Profiles, Record Types), every field the object owns, and the other objects that have a lookup to it (they orphan on delete).

## [0.3.0] - 2026-06-12

### New Features
- Synced the upstream engine — Astro support, callback/function-as-value capture in callers & impact, chained factory-call resolution across more languages, PHP/Ruby symbol coverage, and more.
- The Salesforce **field** tools (`codegraph_field_search` / `_usages` / `_impact`) are now listed by default in the agent's tool surface, so agents reach for them without configuration.

## [0.2.0] - 2026-06-10

### New Features
- Synced the upstream engine — chained static-factory call resolution across ~10 languages, the `CODEGRAPH_DIR` setting for side-by-side Windows/WSL indexes, ASP.NET Razor / Blazor markup parsing, namespace-aware C# types, and the `codegraph upgrade` command.

## [0.1.1] - 2026-06-10

### Fixes
- First release published automatically via npm Trusted Publishing (OIDC, no stored token). No functional change from 0.1.0.

## [0.1.0] - 2026-06-10

### New Features
- Initial **codegraph-sf** release — a Salesforce-focused fork of [`@colbymchenry/codegraph`](https://www.npmjs.com/package/@colbymchenry/codegraph). Indexes the **whole Salesforce stack** (Apex `.cls`/`.trigger`, Visualforce, Aura, LWC) linked end-to-end to the Apex it calls, the **React ↔ Apex** `remoteAction` postMessage bridge, and an **SObject field layer** (`codegraph_field_search` / `_usages` / `_impact`) covering every `Object__c.Field__c` with its Apex/SOQL/LWC usages and its Layout / Validation-Rule / formula references. Also fixes name-match noise where JS/Python builtins (`.replace()`, `.resolve()`) falsely linked to same-named Apex methods. Installs the `codegraph` CLI/MCP command unchanged, so existing configs keep working.
