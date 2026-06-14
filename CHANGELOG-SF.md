# Changelog — codegraph-sf

The release log for the **codegraph-sf** fork. Versions are the fork's own line
(independent of upstream — see [`FORK.md`](FORK.md)). For the upstream engine's
own changes, see [`CHANGELOG.md`](CHANGELOG.md).

## [Unreleased]

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
