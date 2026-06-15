import { describe, it, expect } from 'vitest';
import { selectStaleServePids, type ServeProcess } from '../src/mcp/daemon-gc';

const SELF = 9999;

function procs(...rows: Array<[number, number, string]>): ServeProcess[] {
  return rows.map(([pid, ppid, command]) => ({ pid, ppid, command }));
}

describe('selectStaleServePids', () => {
  const SERVE = 'node --liftoff-only /x/codegraph.js serve --mcp -p /proj';
  const LAUNCHER = 'node /x/bin/codegraph serve --mcp -p /proj';

  it('selects orphaned serve processes (ppid === 1, reparented on POSIX)', () => {
    const alive = (pid: number) => pid !== 1; // init is "alive" but means orphaned
    const stale = selectStaleServePids(procs([100, 1, LAUNCHER], [101, 100, SERVE]), alive, SELF);
    expect(stale).toEqual([100]); // launcher orphaned; child's parent (100) still alive
  });

  it('selects serve processes whose parent is dead (Windows: no reparenting)', () => {
    const alive = (pid: number) => pid === 555; // host 555 alive, 4242 dead
    const stale = selectStaleServePids(
      procs([200, 4242, SERVE], [201, 555, SERVE]),
      alive,
      SELF
    );
    expect(stale).toEqual([200]);
  });

  it('keeps supervised processes (live, non-init parent)', () => {
    const alive = () => true;
    expect(selectStaleServePids(procs([300, 555, SERVE], [301, 555, LAUNCHER]), alive, SELF)).toEqual([]);
  });

  it('never selects itself or non-codegraph processes', () => {
    const alive = (pid: number) => pid !== 1;
    const stale = selectStaleServePids(
      procs(
        [SELF, 1, LAUNCHER],            // self — skip even though orphaned
        [400, 1, 'node /x/bin/codegraph serve'],   // serve WITHOUT --mcp — not ours
        [402, 1, SERVE]                 // genuine orphan
      ),
      alive,
      SELF
    );
    expect(stale).toEqual([402]);
  });
});
