/**
 * Extraction version
 *
 * A monotonically-increasing integer that identifies the *shape and depth* of
 * what the extractor writes into the graph. Unlike `CURRENT_SCHEMA_VERSION`
 * (which tracks the SQLite table layout and is migrated in place), this tracks
 * the EXTRACTED CONTENT — node kinds, edges, synthesizers, resolver coverage.
 *
 * When an index was built by an older engine whose `EXTRACTION_VERSION` is
 * below the running engine's, the data on disk is structurally fine but
 * *stale*: it's missing whatever a newer extractor would now produce. A schema
 * migration can't backfill that — only a re-index can. So this is the signal
 * `codegraph status` uses to recommend a re-index, and the reason `codegraph
 * upgrade` reminds users to refresh their projects.
 *
 * BUMP THIS when a release changes extraction output enough that existing
 * indexes should be rebuilt to benefit — e.g. a new language/framework
 * extractor, a new dynamic-dispatch synthesizer, a new node/edge kind, or a
 * resolver fix that materially changes which edges exist. Do NOT bump for
 * pure bug fixes, CLI/UX changes, or schema-only migrations. Over-bumping
 * turns the re-index hint into noise — keep it honest (see CLAUDE.md, "Honesty
 * in the product is load-bearing").
 */
// Fork note: upstream's counter independently reached 14; this fork's Salesforce
// extraction added the shapes below (its own v2–v11 line). On each upstream merge,
// set this ABOVE both lineages (here: 15) so every existing index re-builds.
// v2: added Salesforce Apex (.cls/.trigger/.apex) language extractor.
// v3: added Salesforce resolver — LWC/Aura JS → Apex method (@salesforce/apex import).
// v4: added Visualforce (.page/.component) extractor — page → controller/extensions/<c:comp>.
// v5: added LWC HTML template (lwc/*.html) extractor — template → <c-child> component.
// v6: added Aura (.cmp/.app/.evt/.intf) extractor + Aura JS handlers + cmp.get("c.x") → Apex.
// v7: React→Apex postMessage bridge — remoteAction("Class.method").
// v8: SObject field layer — sobject_field nodes + Apex/SOQL field read/write/select/filter edges.
// v9: P2 relationship-path field resolution — `A__r.B__c` in Apex + SOQL.
// v10: P3 cross-layer LWC field binds — lightning-input-field → sobject_field.
// v11: P4 field metadata refs — Layout/ValidationRule/formula → sobject_field (field_impact).
// v15: merged upstream main (was at 14) into the Salesforce fork.
// v25: merged upstream main (was at 24) into the Salesforce fork.
// v26: SObject OBJECT layer — `sobject` nodes + object_soql_from/dml/type_ref/schema_ref/metadata_ref edges.
// v27: object_metadata_ref from Flow / PermissionSet / Profile / RecordType declarative metadata.
// v28: object_relationship edges — lookup/master-detail field → its referenceTo object (orphan-on-delete).
// v29: gitignore-exempt SObject metadata + usage-inferred nodes + polymorphic lookups + master-detail signature.
// v30: upstream sync (1.0.1) — new R language extractor + cross-language extractor changes; forces one-time re-index.
export const EXTRACTION_VERSION = 30;
