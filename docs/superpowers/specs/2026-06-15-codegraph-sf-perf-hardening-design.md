# codegraph-sf — Salesforce performance hardening (design)

**Date:** 2026-06-15 · **Branch:** `perf/sf-perf-hardening` (fork `codegraph-sf`) · **Status:** implemented (see "Outcome" per workstream)

## Problem

On a large Salesforce graph (`omni-sf`: 188,090 nodes / 462,162 edges / 70,317 tracked files),
the MCP tools `codegraph_object_search` / `codegraph_explore` hang for minutes and never
return. Root-caused (with `sample`, process inspection, and SQLite stats) to **four
independent defects** that compound:

| # | Defect | Evidence | Location |
|---|--------|----------|----------|
| ① | WAL never truncated | `codegraph.db-wal` = 5.5 GB vs `.db` = 622 MB; checkpoint frames already merged → pure dead file space | `src/db/index.ts:214` uses `wal_checkpoint(PASSIVE)` |
| ② | `getObjectImpact` N+1 | `sample` shows 100% CPU in one `StatementSync.all()` → millions of `sqlite3BtreeTableMoveto` → `walFindFrame` | `src/index.ts:1151` |
| ③ | Salesforce metadata catch-up storm | `Caught up 56590 file(s)`; `objects/` holds **79,414** gitignored `-meta.xml`, walked every sync | `src/extraction/index.ts` `mergeSalesforceMetadata` + `sync` |
| ④ | Daemon/launcher process leak | **81** leaked `codegraph serve --mcp` processes (12/project × 5 + bases); launchers blocked in `spawnSync`, etime up to 7 h | `src/extraction/wasm-runtime-flags.ts:98`, `src/mcp/proxy.ts`, `src/mcp/daemon.ts` |

Mechanism: ② issues a query doing N point-lookups; ① makes every lookup pay a
`walFindFrame` scan over a multi-GB WAL; ③ keeps re-bloating the WAL and pegging CPU on
cold start; ④ leaves stale daemons holding the bloated DB and contending the lock.

## Decisions (locked)

- **Scope:** full hardening — fix all four layers (①②③④).
- **Track 0 (immediate ops): DONE 2026-06-15** — killed 81 leaked processes, `wal_checkpoint(TRUNCATE)` shrank omni-sf WAL 5.5 GB → 0 B, integrity ok, data intact. This is one-time relief; the code fixes below stop it recurring.
- **②:** keep `codegraph_object_search`'s full per-field rollup output (zero behaviour
  regression) — optimize the implementation, do not change what it returns.

## Design — four workstreams

Each is independent and separately testable. All land in the fork: entry in
`CHANGELOG-SF.md`, PATCH bump per `VERSIONING.md`, test coverage per house rules.

### ① WAL truncation (config, low risk, highest leverage)

- In the maintenance routine (`src/db/index.ts` ~194–214) change
  `PRAGMA wal_checkpoint(PASSIVE)` → `wal_checkpoint(TRUNCATE)` so the WAL file is
  folded **and** shrunk. Keep `PRAGMA optimize`.
- Add `PRAGMA wal_autocheckpoint = 2000` (≈ 8 MB at the 4 KB page size; tune 1000–4000)
  at connection setup (`applyPragmas`, ~31–37) so the WAL self-bounds (PASSIVE) between
  the explicit TRUNCATE runs.
- Run a TRUNCATE checkpoint at the end of each `sync()`/`indexAll()` batch (after the
  write transaction commits and the writer connection is the only holder) so a large
  re-extraction can't leave a multi-GB WAL behind.
- **Why TRUNCATE is safe:** committed frames are written into the main DB first; only the
  file tail is reclaimed. Verified in Track 0 (`integrity_check: ok`, counts unchanged).
- **Unit/interface contract:** after `sync()` returns, `stat(.db-wal).size` is bounded
  (≤ a small ceiling, e.g. a few MB), and node/edge/file counts are unchanged.

### ② `getObjectImpact` de-N+1 (durable core fix)

Current hot spots in `src/index.ts:1151`:
1. `getNodesByKind('sobject_field').filter(n => n.qualifiedName.startsWith(prefix))`
   loads **every** `sobject_field` node into JS, then filters.
2. Per owned field: `getFieldUsages(f.qualifiedName).length` — one query per field, each
   walking edges + `getNodeById` per edge → N+1 explosion on wide objects.

Fix (output identical, implementation rewritten):
- Replace (1) with a SQL prefix query: `… WHERE kind='sobject_field' AND qualified_name
  LIKE 'Obj.%'`, served by `idx_nodes_qualified_name` (BINARY collation → prefix LIKE
  is sargable). Add a dedicated query method on `QueryBuilder` (e.g.
  `getFieldsForObject(prefix)`).
- Replace (2) with **one** aggregate: count incoming field-usage edges
  `GROUP BY target` over the field id set, restricted to the usage `EdgeKind`s, returning
  `{ fieldId → usageCount }`. Join to the field list in JS.
- If a covering index is missing for the aggregate, add `idx_edges_target_kind` is already
  present (`edges(target, kind)`) — confirm the planner uses it via `EXPLAIN QUERY PLAN`;
  add an index only if the plan shows a scan.
- **Contract:** `getObjectImpact(name)` returns the same shape and same field/usage
  numbers as today; for a wide object it runs in **O(1) queries**, not O(fields), and
  completes in well under a second on omni-sf.

### ③ Salesforce metadata catch-up (durable)

`mergeSalesforceMetadata` (`src/extraction/index.ts` ~435–460) walks the whole
gitignored `objects/` tree (79,414 files) on **every** sync; `sync()` then `statSync`s
the full ~106 k candidate set. Even a steady-state "9 files changed" sync pays the full
walk, and a version bump (v0.4→0.5) reprocessed tens of thousands at once.

Fix:
- Make metadata discovery honor the existing mtime/size pre-filter: a metadata file
  already in the `files` table with unchanged `(size, mtime)` must be skipped **without
  hashing**, same as source files (it currently bypasses the pre-filter when "new").
- Cache the discovered metadata path set in `.codegraph/` keyed by `objects/`-subtree
  directory mtimes; skip the deep filesystem walk when the subtree is unchanged. Fall
  back to a full walk on cache miss / first run.
- **Contract:** steady-state `sync()` on omni-sf does **not** `statSync`/hash 79 k files;
  `Caught up N` reflects genuinely changed indexed files, not newly-rediscovered
  candidates. A one-time full re-extraction (version bump) is still allowed but bounded
  and followed by a WAL truncate (①).

**Outcome (implemented, evidence-based — narrowed from the above):** Measured first.
The steady-state catch-up is **~5 s total** (parses the genuinely-changed files), not a
hang — metadata files already honor the mtime/size pre-filter once tracked, so they are
**not** re-hashed steady-state. The `Caught up 56590` was a **one-time** event: v0.5.0
was the first version to index SObject metadata at all (the gitignore-exempt carve-out),
so all ~56 k were "added" once, then tracked. The remaining fixed per-sync tax was the
`mergeSalesforceMetadata` walk (~800 ms on omni-sf). **A metadata-walk cache was rejected:**
the catch-up walk exists precisely to find edits made while the daemon was down, so any
cache that *skips* the walk would miss offline changes — it cannot be both correct and
faster. The real win was removing a **dead `realpathSync` loop-guard** from the walk
(symlinked dirs are never recursed, so no cycle is reachable) — ~140 ms saved, byte-identical
output, zero risk. Shipped with a carve-out characterization test.

### ④ Daemon/launcher lifecycle (durable)

Two-process model: a launcher (`node codegraph serve`, no `--liftoff-only`) blocks in
`spawnSync` waiting on a re-exec child (`node --liftoff-only … serve`). When the MCP host
(Claude) exits, the child's `process.ppid` is the **still-blocked launcher**, so the
proxy PPID watchdog (`src/mcp/proxy.ts:498`) sees a live parent and never reaps; the
launcher has no watchdog and no timeout → both leak. 81 such processes observed.

Fix:
- Launcher must not outlive the host: in `relaunchWithWasmRuntimeFlagsIfNeeded`
  (`src/extraction/wasm-runtime-flags.ts:98`) either (a) add a watchdog in the launcher
  that exits when `HOST_PPID` dies, or (b) thread `HOST_PPID` so the child's
  `supervisionLostReason` check reaps on host death regardless of the intermediate
  launcher. Prefer (b) (the env plumbing already exists) + a defensive `timeout` on
  `spawnSync` as a backstop.
- Verify the proxy watchdog uses `HOST_PPID_ENV` (the real host), not the immediate
  `process.ppid`, so the intermediate launcher can't mask host death.
- Add `codegraph daemon gc` (CLI subcommand) to enumerate and kill stale
  `codegraph serve --mcp` processes + stale pidfiles/sockets, for one-shot cleanup.
- **Contract:** when a host session exits, all launcher + child + proxy processes for
  that session terminate within the watchdog poll interval; re-running a session does not
  accumulate processes; `codegraph daemon gc` reduces a leaked set to the live daemons.

**Outcome (implemented — gc shipped; watchdog hardening deferred with diagnosis):**
Confirmed mechanism: the PPID watchdog (`ppid-watchdog.ts`) probes the host with
`process.kill(hostPpid, 0)` and has **no start-time identity check**. Over a long uptime
the dead host's PID gets recycled, the probe sees the reused PID as alive, and the watchdog
never fires → the `serve --mcp` process (and the launcher blocked in `spawnSync`) leak (38
launcher orphans observed). The robust fix (capture + compare host process start-time) is a
non-trivial **cross-platform** change (macOS `lstart` / Linux `/proc/<pid>/stat` field 22 /
Windows) that risks false-positive shutdowns of live daemons if gotten wrong — so per the
plan's "don't guess" guard it is **deferred** to its own change with real Linux/Windows
reproduction. The agent-suggested `spawnSync` timeout was **rejected**: it would kill
healthy long-lived daemons. Shipped instead: **`codegraph daemon gc`** — a manual,
always-safe backstop that reaps orphaned `serve --mcp` processes (`ppid === 1` on POSIX, or
a dead parent), with `--dry-run`. Daemons are disposable (respawned on the next tool call),
so reaping is safe. Pure selection logic is unit-tested; POSIX-only for now (Windows relies
on the watchdog).

## Cross-platform / risk notes

- ④ touches process lifecycle → validate on Linux (Docker `--init`) and Windows
  (named-pipe / SIGKILL edge cases) per CLAUDE.md, not just macOS.
- ① TRUNCATE checkpoint contends with readers; `busy_timeout=5000` already set — confirm
  no checkpoint-starvation under concurrent MCP load.
- Each workstream ships behind its own test; ② must assert byte-identical
  `getObjectImpact` output vs a fixture before/after.

## Out of scope

- Changing what any MCP tool returns (② keeps full rollup output).
- Reactive/reconciler dynamic-dispatch coverage (unrelated frontier).
- Upstream (non-fork) release flow.
