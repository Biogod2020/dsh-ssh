/** Real tool execution against hosts already configured in the private browser fixture. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, realpathSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { HostStore } from '../src/store.ts'
import { SshEngine } from '../src/engine.ts'
import { DEFAULT_KNOWN_HOSTS } from '../src/engine/known-hosts.ts'
import { sshListTool, sshExecTool, sshUploadTool, sshDownloadTool, sshTunnelTool, sshClusterTool } from '../src/tools.ts'

const root = realpathSync(resolve(process.argv[2] ?? ''))
assert(basename(root).startsWith('dsh-remote-browser-'), 'Use only a generated browser fixture')
const fixture = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'))
assert.equal(realpathSync(fixture.root), root)
assert.equal(realpathSync(fixture.local), join(root, 'local'))
assert.equal(realpathSync(fixture.remote), join(root, 'remote'))
DEFAULT_KNOWN_HOSTS.splice(0, DEFAULT_KNOWN_HOSTS.length, join(root, 'local/.ssh/known_hosts'))
const engine = new SshEngine(new HostStore(join(root, 'local/.dsh/dsh-ssh.json')))
const run = (tool: ToolDefinition, args: Record<string, unknown>, signal?: AbortSignal) =>
  tool.execute(args, { signal } as never) as Promise<Record<string, any>>
const server = createServer((_req, res) => res.end('SSH_TOOL_TUNNEL_OK'))
try {
  const host = engine.find('isolated-remote')
  assert.equal(host?.host, '127.0.0.1')
  const home = await engine.exec('isolated-remote', 'printf %s "$HOME"')
  assert.equal(home.stdout, fixture.remote, 'Remote writes require the verified fixture HOME')
  const list = await run(sshListTool(engine), {})
  assert(list.hosts.some((row: Record<string, unknown>) => row.alias === 'isolated-remote'))
  assert(list.hosts.every((row: Record<string, unknown>) => !('proxyCommand' in row)))
  const exec = await run(sshExecTool(engine), { alias: 'isolated-remote', command: 'printf SSH_TOOL_EXEC_OK' })
  assert.equal(exec.stdout, 'SSH_TOOL_EXEC_OK'); assert.equal(exec.success, true)
  const output = mkdtempSync(join(tmpdir(), 'dsh-agent-tools-'))
  const original = join(output, 'original.txt'), downloaded = join(output, 'downloaded.txt')
  const remote = join(fixture.remote, 'agent-tool-roundtrip.txt')
  writeFileSync(original, 'SSH tool file roundtrip\n', { mode: 0o600 })
  assert.equal((await run(sshUploadTool(engine), { alias: 'isolated-remote', localPath: original, remotePath: remote })).ok, true)
  assert.equal((await run(sshDownloadTool(engine), { alias: 'isolated-remote', remotePath: remote, localPath: downloaded })).ok, true)
  assert.deepEqual(readFileSync(downloaded), readFileSync(original))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert(address && typeof address === 'object')
  const tunnelTool = sshTunnelTool(engine)
  const tunnel = await run(tunnelTool, { action: 'start', alias: 'isolated-remote', remotePort: address.port })
  assert.equal(tunnel.ok, true)
  assert.equal(await (await fetch(`http://127.0.0.1:${tunnel.tunnel.localPort}/`)).text(), 'SSH_TOOL_TUNNEL_OK')
  assert.equal((await run(tunnelTool, { action: 'list' })).tunnels.length, 1)
  assert.equal((await run(tunnelTool, { action: 'stop', tunnelId: tunnel.tunnel.id })).stopped, 1)
  const second = engine.find('isolated-secondary') ? 'isolated-secondary' : 'imported-fixture'
  assert(engine.find(second), 'Cluster smoke needs a second already configured fixture host')
  const cluster = await run(sshClusterTool(engine), { aliases: ['isolated-remote', second], command: 'printf SSH_TOOL_CLUSTER_OK' })
  assert.equal(cluster.results.length, 2)
  assert(cluster.results.every((row: Record<string, unknown>) => row.ok && row.stdout === 'SSH_TOOL_CLUSTER_OK'))
  const stop = new AbortController()
  const cancelled = run(sshExecTool(engine), { alias: 'isolated-remote', command: 'sleep 10', timeoutMs: 15000 }, stop.signal)
  const timer = setTimeout(() => stop.abort(), 50)
  try { assert.match(String((await cancelled).error), /cancelled.*outcome unknown/) } finally { clearTimeout(timer) }
  assert.equal((await engine.exec('isolated-remote', 'printf SSH_STILL_ALIVE')).success, true)
  console.log('Six SSH agent tools passed real execution, file roundtrip, tunnel HTTP, selected cluster and Stop. No model API called.')
  console.log(`Private file evidence: ${output}`)
} finally {
  engine.dispose()
  server.close()
}
