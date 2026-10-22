import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const run = promisify(execFile)

/** A separate process must survive errors from the real TCP accept callback. */
async function exercise(mode: 'disconnected' | 'early-socket-error' | 'rejected', workspace = false) {
  const source = `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { startTunnel, stopAllTunnels } from './src/engine/tunnel.ts';
const { Client } = createRequire(process.cwd() + '/package.json')('ssh2');
const mode = ${JSON.stringify(mode)}, workspace = ${JSON.stringify(workspace)};
const client = new Client(), original = client.forwardOut;
let attempts = 0, pending, release;
const requested = new Promise(resolve => { release = resolve });
client.connect = () => { throw new Error('A failed request must not reconnect SSH') };
client.forwardOut = (...args) => {
  attempts++;
  if (mode === 'disconnected') return original.apply(client, args);
  if (mode === 'rejected') { setImmediate(() => args.at(-1)(new Error('fixture forwarding rejected'))); return client }
  pending = args.at(-1); release(); return client;
};
const record = { client, hops: [], idleAt: Date.now(), pinned: false, broken: false, inFlight: 0 };
const engine = { store: { find: () => ({ alias: 'fixture' }) }, opts: {}, pool: new Map([['fixture', record]]), acquireQueue: new Map(), tunnels: new Map(), nextTunnelId: 1 };
const health = createServer((_request, response) => response.end('still alive'));
await new Promise(resolve => health.listen(0, '127.0.0.1', resolve));
try {
  const tunnel = await startTunnel(engine, 'fixture', { remotePort: 65534 }, workspace);
  const connectOnce = () => {
    const socket = connect(tunnel.localPort, '127.0.0.1');
    socket.on('error', () => {});
    const closed = new Promise(resolve => socket.once('close', resolve));
    return { socket, closed };
  };
  if (mode === 'early-socket-error') {
    const incoming = connectOnce();
    await requested;
    const accepted = [...engine.tunnels.get(tunnel.id).sockets][0];
    assert(accepted);
    accepted.emit('error', new Error('fixture socket failed before SSH replied'));
    await incoming.closed;
    const channel = new PassThrough();
    let closes = 0;
    channel.close = () => { closes++; channel.destroy() };
    pending(undefined, channel);
    assert.equal(closes, 1, 'a late channel must be released exactly once');
    channel.emit('error', new Error('fixture late channel error'));
    assert.equal(closes, 1);
    assert.equal(attempts, 1);
  } else {
    for (let n = 0; n < 2; n++) await connectOnce().closed;
    assert.equal(attempts, 2, 'each incoming socket is attempted once, without replay');
  }
  assert.equal(engine.pool.get('fixture'), record, 'unrelated ownership must remain intact');
  assert.equal(record.pinned, true);
  assert.equal(await (await fetch('http://127.0.0.1:' + health.address().port)).text(), 'still alive');
  console.log(JSON.stringify({ alive: true, attempts, mode, workspace }));
} finally {
  stopAllTunnels(engine, undefined, true);
  health.closeAllConnections();
  await new Promise(resolve => health.close(resolve));
}
`
  const { stdout } = await run(process.execPath, ['--experimental-transform-types', '--input-type=module', '--eval', source], {
    cwd: process.cwd(), timeout: 8000, maxBuffer: 128 * 1024,
  })
  return JSON.parse(stdout.trim()) as { alive: boolean; attempts: number; mode: string; workspace: boolean }
}

it.each([false, true])('survives a stale disconnected SSH client without reconnecting or replaying (workspace=%s)', async workspace => {
  expect(await exercise('disconnected', workspace)).toMatchObject({ alive: true, attempts: 2, workspace })
})

it('handles local socket failure before SSH replies and closes a late channel', async () => {
  expect(await exercise('early-socket-error')).toMatchObject({ alive: true, attempts: 1 })
})

it('keeps the process alive after asynchronous forwarding rejection without replay', async () => {
  expect(await exercise('rejected')).toMatchObject({ alive: true, attempts: 2 })
})
