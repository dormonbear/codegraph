# codegraph-sf Performance Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop `codegraph_object_search`/`codegraph_explore` from hanging for minutes on large Salesforce graphs by fixing four compounding defects: un-truncated WAL, an N+1 object-impact query, a per-sync 79k-file metadata walk, and leaked daemon processes.

**Architecture:** Four independent workstreams, each separately testable and committed. Order by leverage/risk: ① WAL (config) → ② query de-N+1 (core) → ③ metadata catch-up → ④ daemon lifecycle (confirm-then-fix + safe `gc`).

**Tech Stack:** TypeScript, node:sqlite (built-in) / better-sqlite3 adapter, vitest (`--run`), tree-sitter. Tests in `__tests__/`, real SQLite + temp dirs (no mocks).

Spec: `docs/superpowers/specs/2026-06-15-codegraph-sf-perf-hardening-design.md`. Fork rules: entry in `CHANGELOG-SF.md`, PATCH per `VERSIONING.md`, `npm run build` then `npx vitest run` to verify.

---

## Track 0 — DONE (2026-06-15)

Killed 81 leaked `codegraph serve --mcp` processes; `wal_checkpoint(TRUNCATE)` shrank omni-sf WAL 5.5 GB → 0 B (`integrity_check: ok`, counts unchanged). One-time relief; tasks below stop recurrence.

---

## Task 1 — ① WAL: TRUNCATE checkpoint + autocheckpoint

**Files:**
- Modify: `src/db/index.ts` — `configureConnection` (~30-38), `runMaintenance` (~207-218)
- Test: `__tests__/db-wal-maintenance.test.ts` (create)

- [ ] **Step 1: Write failing test.** After many writes + `runMaintenance()`, the `.db-wal` file is bounded (well under the bytes written) and row counts are intact.

```ts
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { DatabaseConnection } from '../src/db';

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

describe('WAL maintenance', () => {
  it('runMaintenance bounds the WAL file', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wal-'));
    const dbPath = path.join(dir, 'codegraph.db');
    const conn = DatabaseConnection.initialize(dbPath);
    const db = conn.getDb();
    const insert = db.prepare("INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line) VALUES (?,?,?,?,?,?,?,?)");
    db.transaction(() => { for (let i = 0; i < 20000; i++) insert.run(`n${i}`, 'function', `f${i}`, `f${i}`, 'a.ts', 'ts', 1, 2); })();
    conn.runMaintenance();
    const walPath = dbPath + '-wal';
    const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    expect(walSize).toBeLessThan(1_000_000); // TRUNCATE → near-zero, not multi-MB
    expect((db.prepare('SELECT count(*) c FROM nodes').get() as any).c).toBe(20000);
    conn.close();
  });
});
```

- [ ] **Step 2: Run, verify FAIL** (PASSIVE leaves WAL large). `npx vitest run __tests__/db-wal-maintenance.test.ts`
- [ ] **Step 3: Implement.** In `runMaintenance`, change `wal_checkpoint(PASSIVE)` → `wal_checkpoint(TRUNCATE)`:

```ts
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // ignore (e.g., not in WAL mode)
    }
```

  And in `configureConnection`, after the `journal_mode = WAL` line, add:

```ts
  db.pragma('wal_autocheckpoint = 2000'); // ≈8MB self-bound between TRUNCATE runs
```

- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Verify caller fires maintenance after sync.** Confirm `runMaintenance()` is invoked at the end of `sync()`/`indexAll()` (grep `runMaintenance` in `src/index.ts`/`src/extraction`). If a sync path doesn't call it, add the call after the write transaction commits. Re-run full suite: `npx vitest run`.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "fix(db): TRUNCATE checkpoint + wal_autocheckpoint to bound WAL growth"`

---

## Task 2 — ② getObjectImpact: eliminate N+1 (output unchanged)

**Files:**
- Modify: `src/index.ts` — `getObjectImpact` (1151-1218), `getObjectUsages` field-rollup section
- Modify: `src/db/query-builder.ts` — add `getFieldsForObject(objectName)` (SQL prefix) and `countFieldUsagesForFields(fieldQNames, kinds)` (one GROUP BY)
- Test: `__tests__/object-impact-perf.test.ts` (create)

- [ ] **Step 1: Read** `src/db/query-builder.ts` for the existing method pattern (prepared-statement style, `getNodesByKind`, `getIncomingEdges`, `getFieldUsages`). Match it exactly.
- [ ] **Step 2: Write failing test** — output equivalence + query-count bound. Build a small graph: 1 `sobject` node `Acct__c`, 50 `sobject_field` nodes `Acct__c.F{i}__c`, plus `field_read`/`field_soql_select` edges into some fields. Assert `getObjectImpact('Acct__c').fields` returns all 50 with correct `usageCount`, sorted desc, and that the implementation issues O(1) (not O(fields)) field-usage queries (spy/count prepared `.all()` calls, or assert wall-time < 200ms on 50 fields). Exact fixtures filled at execution after reading the Node insert shape.
- [ ] **Step 3: Run, verify FAIL.**
- [ ] **Step 4: Implement.**
  - Add `QueryBuilder.getFieldsForObject(objectName)`: `SELECT * FROM nodes WHERE kind='sobject_field' AND qualified_name LIKE ? ESCAPE '\\'` with param `${objectName}.%` (escape `%`/`_` in objectName). Replaces `getNodesByKind('sobject_field').filter(startsWith(prefix))`.
  - Add `QueryBuilder.countFieldUsagesForFields(fieldIds, kinds)`: one query, `SELECT target, count(*) c FROM edges WHERE kind IN (...) AND target IN (...) GROUP BY target` (chunk the `IN` list if > 900). Returns `Map<string, number>`.
  - In `getObjectImpact`/`getObjectUsages`, replace the per-field `getFieldUsages(f.qualifiedName).length` loop with one `countFieldUsagesForFields` call keyed by field id; default usage kinds = the same list `getFieldUsages` defaults to.
  - `EXPLAIN QUERY PLAN` the two new statements during impl; confirm index use (`idx_nodes_qualified_name`, `idx_edges_target_kind`). Add an index only if a scan shows.
- [ ] **Step 5: Run, verify PASS** + run `__tests__/` object/field suites to confirm zero output regression. `npx vitest run -t object`
- [ ] **Step 6: Probe on real graph.** `npm run build`, then time `getObjectImpact('IC_Royalty_Center__c')` against omni-sf via a one-off `scripts/agent-eval/probe-node.mjs`-style script (read-only). Expect sub-second.
- [ ] **Step 7: Commit.** `git commit -m "perf(objects): de-N+1 getObjectImpact via prefix query + grouped usage count"`

---

## Task 3 — ③ Salesforce metadata catch-up storm

**Files:**
- Modify: `src/extraction/index.ts` — `mergeSalesforceMetadata` (435-460) + the sync pre-filter (~1460-1520)
- Test: `__tests__/sf-metadata-catchup.test.ts` (create)

- [ ] **Step 1: Read** the sync reconcile loop in `src/extraction/index.ts` (~1460-1520) — confirm the exact mtime/size pre-filter and where `filesAdded` is counted.
- [ ] **Step 2: Write failing test.** Build a temp SFDX project (`sfdx-project.json` + `force-app/main/default/objects/Acct__c/fields/F__c.field-meta.xml` ×N, with `objects/*` in `.gitignore`). First `sync` indexes them. Touch nothing. Second `sync` must report **0** changed and must NOT re-hash the metadata files (assert via a spy on `fs.readFileSync` count, or a hash-call counter). Currently the second sync re-discovers + re-hashes all metadata.
- [ ] **Step 3: Run, verify FAIL.**
- [ ] **Step 4: Implement.** Ensure metadata files honor the existing tracked `(size, mtime)` pre-filter (skip without hashing when unchanged) — same branch source files use. If `mergeSalesforceMetadata`-discovered files currently bypass that branch, route them through it. Add a cached metadata-path set under `.codegraph/` keyed by `objects/`-subtree dir mtimes; on cache hit skip the deep walk, on miss do the full walk and rewrite the cache. Keep the carve-out semantics (gitignored objects still indexed on first run / on real change).
- [ ] **Step 5: Run, verify PASS** + full suite (`npx vitest run`) — no regression in existing SF extraction tests.
- [ ] **Step 6: Probe.** `npm run build`; run a no-op `codegraph sync -p <omni-sf>` and confirm it does not stat/hash ~79k files (time it; should be fast and report few/zero changed).
- [ ] **Step 7: Commit.** `git commit -m "perf(sf): cache metadata walk + honor mtime pre-filter to kill catch-up storm"`

---

## Task 4 — ④ Daemon/launcher leak: confirm root cause, then fix + safe `gc`

> NOTE: The HOST_PPID watchdog (#277) already exists (`wasm-runtime-flags.ts:49-60`, proxy poll). So the leak is NOT missing plumbing — do NOT add a `spawnSync` timeout (it would kill healthy long-lived daemons). Confirm the actual failure mode before changing watchdog logic.

**Files:**
- Read first: `src/mcp/proxy.ts` (watchdog `startPpidWatchdog`, `supervisionLostReason`), `src/mcp/daemon.ts` (idle/backstop/`reapDeadClients`), `src/mcp/index.ts` (`startDaemonProcess`), `src/bin/codegraph.ts` (subcommand registration)
- Modify: `src/bin/codegraph.ts` (+ `src/mcp/daemon-paths.ts`/new helper) — add `codegraph daemon gc`
- Test: `__tests__/daemon-gc.test.ts` (create)

- [ ] **Step 1: Confirm the failure mode** (systematic-debugging Phase 1). Inspect `supervisionLostReason`: does it treat a reused PID as alive? Is `HOST_PPID` lost on any path? Reproduce: start a daemon, kill the host, observe whether the server reaps within the poll interval; check whether leaked survivors are daemons (no watchdog, rely on idle timeout) vs proxies (watchdog). Write the confirmed cause into the spec before coding the watchdog fix.
- [ ] **Step 2: Ship the always-safe cleanup first — `codegraph daemon gc`.** TDD a pure helper `findStaleDaemonProcesses()` that lists `codegraph serve --mcp` PIDs whose host is gone / whose socket is dead, and `gcDaemons({dryRun})` that SIGTERM→SIGKILL them and removes stale pidfiles/sockets. Test the pure selection logic with injected process/pidfile lists (no real kills). Wire a `daemon gc [--dry-run]` subcommand in `src/bin/codegraph.ts`.
- [ ] **Step 3: Apply the confirmed watchdog/reaping fix** from Step 1 (e.g. PID+start-time identity to defeat PID reuse, or faster zero-client daemon reaping). One change, with a test reproducing the leak condition. If Step 1 shows the cause needs deeper work than this PR, STOP and record it — ship gc + the confirmed diagnosis, don't guess.
- [ ] **Step 4: Cross-platform note.** Mark daemon-lifecycle tests that depend on POSIX signals/`/proc` with `it.runIf(process.platform !== 'win32')`. Validate Linux (Docker `--init`) per CLAUDE.md before claiming ④ done.
- [ ] **Step 5: Commit.** `git commit -m "fix(daemon): add 'daemon gc' cleanup + reap leaked launchers"`

---

## Task 5 — Changelog + finish

- [ ] **Step 1:** Add a `## [Unreleased]`-style entry to `CHANGELOG-SF.md` under New Features/Fixes (user-facing language: faster Salesforce object queries, bounded disk use, cleaner daemon lifecycle, `codegraph daemon gc`).
- [ ] **Step 2:** `npm run build && npx vitest run` — full green.
- [ ] **Step 3:** Per `superpowers:finishing-a-development-branch`, present merge/PR options. Do NOT bump version or publish (maintainer's call per CLAUDE.md).

---

## Self-review

- **Spec coverage:** ①→Task 1, ②→Task 2, ③→Task 3, ④→Task 4, changelog/VERSIONING→Task 5. All four workstreams + Track-0 record present.
- **Placeholders:** Task 1 has full code. Tasks 2-4 have exact files/anchors/SQL and explicit "read X then fill fixtures at execution" — justified because exact insert/fixture shapes depend on the live `QueryBuilder`/sync code read in each task's Step 1; not vague requirements.
- **Type consistency:** new methods `getFieldsForObject`, `countFieldUsagesForFields`, `findStaleDaemonProcesses`, `gcDaemons` referenced consistently.
- **Risk:** ④ explicitly gated to confirm-before-fix (no guessing); ② asserts output equivalence (zero regression); ① verified safe in Track 0.
