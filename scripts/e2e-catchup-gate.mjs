// E2E: drive the REAL shipped `serve --mcp` stdio server against a project with
// a large pending catch-up, and measure how long the first tool call takes.
// Proves the bounded gate serves the (stale) graph fast while sync runs in the
// background, vs the old `=0` behavior that blocks the first call on full sync.
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const BIN = path.resolve('dist/bin/codegraph.js');
const N = 2000;

// The sandbox sets TMPDIR to the repo; force a real tmp base so the throwaway
// project (and its .codegraph index) never lands inside the repo tree.
const TMPBASE = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();

function makeProject() {
  const dir = fs.mkdtempSync(path.join(TMPBASE, 'cg-e2e-gate-'));
  fs.mkdirSync(path.join(dir, 'src'));
  for (let i = 0; i < N; i++) {
    fs.writeFileSync(path.join(dir, 'src', `mod${i}.ts`),
      `export function targetFn${i}() { return ${i}; }\n`);
  }
  return dir;
}

function dirtyAll(dir, tag) {
  for (let i = 0; i < N; i++) {
    fs.writeFileSync(path.join(dir, 'src', `mod${i}.ts`),
      `// ${tag}\nexport function targetFn${i}() { return ${i} + ${tag.length}; }\n`);
  }
}

// Speak newline-delimited JSON-RPC to a fresh `serve --mcp` and time the first tool call.
function measure(dir, gateTimeoutMs) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env,
      CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS: String(gateTimeoutMs),
      CODEGRAPH_WASM_RELAUNCHED: '1', CODEGRAPH_NO_WATCH: '1' };
    const p = spawn(process.execPath, [BIN, 'serve', '--mcp', '--path', dir, '--no-watch'],
      { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', toolStart = 0, done = false;
    const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) { // initialize response
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          toolStart = Date.now();
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
            params: { name: 'codegraph_search', arguments: { query: 'targetFn1' } } });
        } else if (msg.id === 2 && !done) { // first tool response
          done = true;
          const ms = Date.now() - toolStart;
          const text = msg.result?.content?.[0]?.text ?? '';
          const isErr = !!msg.result?.isError;
          p.kill('SIGKILL');
          resolve({ ms, isErr, hit: /targetFn1\b/.test(text) });
        }
      }
    });
    p.stderr.on('data', () => {});
    p.on('error', reject);
    setTimeout(() => { if (!done) { p.kill('SIGKILL'); reject(new Error('timeout 90s — first tool call never returned (HANG)')); } }, 90_000);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } });
  });
}

const dir = makeProject();
try {
  console.log(`[setup] ${N} files at ${dir} — indexing via shipped binary...`);
  execFileSync(process.execPath, [BIN, 'init', dir, '--force'],
    { env: { ...process.env, CODEGRAPH_WASM_RELAUNCHED: '1' }, stdio: 'ignore' });

  // Baseline cost of a full catch-up (=0: block first call until sync done).
  dirtyAll(dir, 'rev-A-blocking');
  const blocking = await measure(dir, 0);
  console.log(`[=0  blocking ] first tool call: ${blocking.ms} ms  hit=${blocking.hit} err=${blocking.isErr}`);

  // Bounded gate: serve stale graph fast while the same-size sync runs in bg.
  dirtyAll(dir, 'rev-B-bounded');
  const bounded = await measure(dir, 200);
  console.log(`[=200 bounded ] first tool call: ${bounded.ms} ms  hit=${bounded.hit} err=${bounded.isErr}`);

  const ok = bounded.ms < blocking.ms && bounded.ms < 2000 && !bounded.isErr && bounded.hit;
  console.log(`\nRESULT: bounded(${bounded.ms}ms) < blocking(${blocking.ms}ms), bounded<2s, served a real hit → ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
