/**
 * `codegraph daemon gc` — reclaim leaked daemon / launcher processes.
 *
 * Each indexed project's MCP server runs as an on-demand daemon supervised by a
 * PPID watchdog (#277). When the watchdog misses a host death — most often
 * because the host's PID was recycled and the liveness probe sees the reused
 * PID as still alive — the `codegraph serve --mcp` server (and the launcher
 * blocked in `spawnSync` waiting on it) leaks. Over many sessions these pile
 * up (observed: dozens). gc finds the orphans and kills them; daemons are
 * disposable, so the next MCP tool call respawns a fresh one.
 *
 * This is a manual backstop for the watchdog, not a replacement for it.
 */
import { execFileSync } from 'child_process';

export interface ServeProcess {
  pid: number;
  ppid: number;
  command: string;
}

/** Matches both the launcher (`codegraph serve --mcp`) and its re-exec child
 *  (`node --liftoff-only …/codegraph.js serve --mcp`). */
const SERVE_MARKER = /codegraph[^\n]*serve\s+--mcp/;

/**
 * Pure selection: which `codegraph serve --mcp` PIDs are orphaned and safe to
 * reap. A process is orphaned when its parent is gone:
 *   - POSIX reparents an orphan to init → `ppid === 1`.
 *   - Windows keeps the dead parent's pid → the liveness probe reports it gone.
 * Never selects `self` (the running gc process) or its own parent chain.
 */
export function selectStaleServePids(
  processes: ServeProcess[],
  isAlive: (pid: number) => boolean,
  self: number
): number[] {
  const out: number[] = [];
  for (const p of processes) {
    if (p.pid === self) continue;
    if (!SERVE_MARKER.test(p.command)) continue;
    if (p.ppid === 1 || !isAlive(p.ppid)) out.push(p.pid);
  }
  return out;
}

/** `process.kill(pid, 0)` liveness probe: alive, or alive-but-not-ours (EPERM). */
export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Enumerate running `codegraph serve --mcp` processes (POSIX `ps`). */
export function listServeProcesses(): ServeProcess[] {
  if (process.platform === 'win32') return [];
  let out: string;
  try {
    out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const procs: ServeProcess[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! });
  }
  return procs;
}

export interface GcResult {
  selected: number[];
  killed: number[];
  dryRun: boolean;
}

/**
 * Find orphaned serve processes and (unless dryRun) kill them: SIGTERM, then
 * SIGKILL any that don't exit promptly.
 */
export function gcDaemons(opts: { dryRun?: boolean } = {}): GcResult {
  const dryRun = opts.dryRun ?? false;
  const selected = selectStaleServePids(listServeProcesses(), isProcessAlive, process.pid);
  if (dryRun || selected.length === 0) return { selected, killed: [], dryRun };

  for (const pid of selected) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  // Brief grace so daemons flush cleanly, then force-kill survivors. Atomics.wait
  // on a throwaway buffer is a clean blocking sleep (no CPU spin).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  const killed: number[] = [];
  for (const pid of selected) {
    if (isProcessAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
    if (!isProcessAlive(pid)) killed.push(pid);
  }
  return { selected, killed, dryRun };
}
