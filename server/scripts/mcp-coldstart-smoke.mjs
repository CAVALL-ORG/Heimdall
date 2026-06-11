// Cold-start MCP smoke test — exercises the install-timeout fix end to end
// against a real installed server binary, over the same stdio JSON-RPC protocol
// every MCP client (Claude Code, Cursor, Codex) speaks.
//
// Asserts:
//   1. `initialize` responds fast (browser launch is NOT in the handshake path).
//   2. tool calls return BROWSER_INITIALIZING while the runtime warms.
//   3. the runtime reaches ready — i.e. Chromium downloaded (if missing) +
//      launched + the Ketcher page loaded — within the deadline.
//
// Usage: node mcp-coldstart-smoke.mjs <path-to/dist/mcp/server.mjs>
// Set PLAYWRIGHT_BROWSERS_PATH to an empty dir to force a real cold download.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

const BIN = process.argv[2];
if (!BIN || !existsSync(BIN)) {
  console.error(`usage: node mcp-coldstart-smoke.mjs <server.mjs>  (got: ${BIN})`);
  process.exit(2);
}

// Generous vs CI-runner slowness but still far under any client's connect
// timeout (Claude's is 30s) — the logged value is the real evidence (~1-3s).
const HANDSHAKE_MAX_MS = 20_000;
const READY_DEADLINE_MS = 8 * 60_000;

const child = spawn(process.execPath, [BIN], {
  env: { ...process.env, KETCHER_AGENT_MODE: process.env.KETCHER_AGENT_MODE ?? 'standalone' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const waiters = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  }
});
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const rpc = (id, method, params) =>
  new Promise((res) => { waiters.set(id, res); send({ jsonrpc: '2.0', id, method, params }); });
const now = () => Number(process.hrtime.bigint() / 1000000n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

let id = 0;
const t0 = now();
const init = await rpc(++id, 'initialize', {
  protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' },
});
const handshakeMs = now() - t0;
check('initialize responds', !!init.result, init.error ? JSON.stringify(init.error) : '');
check(`initialize fast (<${HANDSHAKE_MAX_MS}ms)`, handshakeMs < HANDSHAKE_MAX_MS, `${handshakeMs}ms`);
send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

const tl = await rpc(++id, 'tools/list', {});
check('tools/list responds', Array.isArray(tl.result?.tools), `${tl.result?.tools?.length ?? 0} tools`);

const deadline = now() + READY_DEADLINE_MS;
let ready = false, sawGate = false;
while (now() < deadline) {
  const r = await rpc(++id, 'tools/call', { name: 'get_state', arguments: {} });
  const text = textOf(r);
  let ok = false; try { ok = JSON.parse(text).ok === true; } catch {}
  const sec = Math.round((now() - t0) / 1000);
  if (ok) { console.log(`[t+${sec}s] get_state ok=TRUE — runtime live`); ready = true; break; }
  if (/BROWSER_INITIALIZING/.test(text)) { sawGate = true; console.log(`[t+${sec}s] BROWSER_INITIALIZING…`); }
  else { console.log(`[t+${sec}s] unexpected: ${text.slice(0, 120)}`); }
  await sleep(10_000);
}
check('saw BROWSER_INITIALIZING gate', sawGate);
check('runtime reached ready within deadline', ready);

const bp = process.env.PLAYWRIGHT_BROWSERS_PATH;
if (bp && existsSync(bp)) console.log(`browsers dir: ${readdirSync(bp).join(', ') || '(empty)'}`);

child.kill('SIGTERM');
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
