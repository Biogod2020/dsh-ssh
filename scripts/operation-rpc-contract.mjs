/** Probe the supplied, unmodified SDK factory with a MOCK Context and HTTP
 * transport. This verifies SDK acknowledgement timing, not page boot coverage,
 * a live Host, a renderer, or an automatic view release. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { Script, createContext } from 'node:vm'
import { createHash, webcrypto } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createOperationLedger } from '../src/remote/operation-ledger.ts'
import { ViewReceiptStore } from '../src/remote/view-receipts.ts'
import { operationTransport } from '../src/remote/operation-client.ts'
import { createRemoteOperationObserver } from '../src/remote/operation-streams.ts'

const [bundlePath, output] = process.argv.slice(2)
assert(bundlePath && output && isAbsolute(bundlePath) && isAbsolute(output), 'Supply the absolute SDK browser bundle and new report path')
const source = await readFile(bundlePath, 'utf8'), modules = []
const sandbox = createContext({ window: { __ModuleLoader__: { load: value => modules.push(value) } },
  crypto: webcrypto, Blob, Uint8Array, URL, AbortController, AbortSignal, setTimeout, clearTimeout, console })
new Script(source).runInContext(sandbox, { timeout: 3000 })
assert.equal(modules.length, 1); assert.equal(modules[0].id, '@deepseek-ai/dsh-client-connection')
const sdk = modules[0].factory(() => { throw Error('Unexpected SDK import') })
assert.equal(typeof sdk.installConnection, 'function', 'This probe requires the public composition function')
const ledger = createOperationLedger(); ledger.coverage(true)
let current, reply
const fetch = async (path, init) => {
  assert(current, 'Dispatch must occur inside the observed invocation')
  const operation = current
  const request = JSON.parse(init.body)
  assert.equal(path, 'api/session/cancel')
  assert.equal(request.method, 'session/cancel')
  operation.dispatched()
  return reply(request)
}
let connection
sdk.installConnection({ provide(name, value) { assert.equal(name, 'connection'); connection = value } }, { transport: { fetch }, interactions: 'none' })
const invoke = (endpoint = 'session/cancel', signal) => {
  const operation = ledger.reserve('session', 'http', 'generated-session')
  const previous = current; current = operation
  let result
  try { result = connection.rpc.call('/api', endpoint, { args: { _request: { sessionId: 'generated-session' } } }, signal) }
  catch (error) { operation.finish(false); throw error }
  finally { current = previous }
  return result.then(value => { operation.finish(true); return value }, error => { operation.finish(false); throw error })
}
const envelope = (request, result = { ok: true, value: {} }) => ({ type: 'server-response', rpcId: request.rpcId, result })
await assert.rejects(invoke('../invalid'), /invalid RPC target/)
assert.equal(ledger.inspection().unconfirmedOperations, 0, 'Local rejection is not an uncertain dispatch')

let releaseJson
reply = request => {
  const response = new Response('', { headers: { 'content-type': 'application/json' } })
  response.json = () => new Promise(resolve => { releaseJson = () => resolve(envelope(request)) })
  return response
}
const pending = invoke()
for (let n=0;n<20 && !releaseJson;n++) await Promise.resolve()
assert(releaseJson); assert.equal(ledger.inspection().pendingRequests, 1, 'Headers are not an acknowledgement')
releaseJson(); assert.equal((await pending).ok, true); assert.equal(ledger.inspection().pendingRequests, 0)

reply = request => Response.json({ ...envelope(request), rpcId: 'generated-mismatched-id' })
await assert.rejects(invoke(), /rpcId mismatch/)
assert.equal(ledger.inspection().unconfirmedOperations, 1)
reply = request => Response.json(envelope(request, { ok: false, error: { code: 'session/generated-refusal', message: 'Generated refusal', details: {} } }))
assert.equal((await invoke()).ok, false)
assert.equal(ledger.inspection().unconfirmedOperations, 1, 'A validated refusal is an acknowledgement, not a retry instruction')

const controller = new AbortController()
reply = request => { controller.abort(); return Response.json(envelope(request)) }
await assert.rejects(invoke('session/cancel', controller.signal))
assert.equal(ledger.inspection().unconfirmedOperations, 2, 'Abort after dispatch cannot prove remote cancellation')

let releaseBinary, binaryReached
const reached = new Promise(resolve => { binaryReached = resolve })
reply = request => {
  const blob = new Blob(['fixture'])
  blob.arrayBuffer = () => { binaryReached(); return new Promise(resolve => { releaseBinary = resolve }) }
  const metadata = { ...envelope(request, { ok: true, value: null }), attachments: [{ codec: 'bytes', part: 'fixture', path: [] }] }
  const response = new Response('', { headers: { 'content-type': 'multipart/form-data; boundary=fixture' } })
  response.formData = async () => new Map([['metadata', JSON.stringify(metadata)], ['fixture', blob]])
  return response
}
const binary = invoke(); await reached
assert.equal(ledger.inspection().pendingRequests, 1, 'Multipart metadata is not completed binary decoding')
releaseBinary(new Uint8Array([11,22,33]).buffer)
assert.deepEqual(Array.from((await binary).value), [11,22,33]); assert.equal(ledger.inspection().pendingRequests, 0)

const parent = await mkdtemp(join(tmpdir(), 'dsh-operation-contract-')), root = join(parent, 'observations'), host = 'a'.repeat(24)
const store = new ViewReceiptStore(root)
try {
  const token = ledger.freeze()
  assert(await ledger.seal(token, rows => store.saveMany(host, rows)))
  assert(ledger.commitRelease(token)); await store.close()
  const reopened = new ViewReceiptStore(root)
  try { assert.equal((await reopened.list(host)).entries.length, 2) } finally { await reopened.close() }
} finally { await store.close(); await rm(parent, { recursive: true, force: true }) }

// Exercise the new serialized composition against the same real SDK as well:
// the transport only marks dispatch; its decorated public RPC owns completion.
let scopedReply, scopedConnection
sandbox.fetch = async (_path, init) => scopedReply(JSON.parse(init.body))
new Script(`(${operationTransport.toString()})('aaaaaaaaaaaaaaaaaaaaaaaa',(${createOperationLedger.toString()}),(${createRemoteOperationObserver.toString()}));`).runInContext(sandbox, { timeout: 3000 })
const scoped = sandbox.window.__dshSshOperations, transport = sandbox.window.__DSH_TRANSPORT__
assert(scoped && transport)
sdk.installConnection({ provide(name, value) { assert.equal(name, 'connection'); scopedConnection = value } }, { transport, interactions: 'none' })
const originalRpc = scopedConnection.rpc.call, detach = scoped.attach(scopedConnection.rpc)
let finishScoped, startedScoped
const scopedStarted = new Promise(resolve => { startedScoped = resolve })
scopedReply = request => {
  const response = new Response('', { headers: { 'content-type': 'application/json' } })
  response.json = () => { startedScoped(); return new Promise(resolve => { finishScoped = () => resolve(envelope(request)) }) }
  return response
}
const scopedPending = scopedConnection.rpc.call('/api', 'session/cancel', { args: {} })
await scopedStarted
assert.equal(scoped.inspection().unary.observedPendingRequests, 1)
assert.equal(scoped.inspection().fullCoverage, false); assert.equal(scoped.inspection().pendingRequests, null)
finishScoped(); assert.equal((await scopedPending).ok, true)
assert.equal(scoped.inspection().unary.observedPendingRequests, 0)
assert.equal(scoped.inspection().unary.scopedFetchObserved, true)
const parallel = new Map()
scopedReply = request => {
  const response = new Response('', { headers: { 'content-type': 'application/json' } })
  response.json = () => new Promise(resolve => { parallel.set(request.payload.args.generatedLabel, () => resolve(envelope(request))) })
  return response
}
const a = scopedConnection.rpc.call('/api','session/cancel',{args:{generatedLabel:'A'}})
const b = scopedConnection.rpc.call('/api','session/cancel',{args:{generatedLabel:'B'}})
for(let n=0;n<20&&parallel.size<2;n++)await Promise.resolve()
assert.equal(parallel.size,2);assert.equal(scoped.inspection().unary.observedPendingRequests,2)
parallel.get('B')();assert.equal((await b).ok,true);assert.equal(scoped.inspection().unary.observedPendingRequests,1)
parallel.get('A')();assert.equal((await a).ok,true);assert.equal(scoped.inspection().unary.observedPendingRequests,0)
assert.equal(scoped.inspection().unary.rpcDecoratorAttached,true)
let finishScopedBinary, startedScopedBinary
const binaryStarted = new Promise(resolve => { startedScopedBinary = resolve })
scopedReply = request => {
  const blob = new Blob(['fixture'])
  blob.arrayBuffer = () => { startedScopedBinary(); return new Promise(resolve => { finishScopedBinary = resolve }) }
  const metadata = { ...envelope(request, { ok: true, value: null }), attachments: [{ codec: 'bytes', part: 'fixture', path: [] }] }
  const response = new Response('', { headers: { 'content-type': 'multipart/form-data; boundary=fixture' } })
  response.formData = async () => new Map([['metadata', JSON.stringify(metadata)], ['fixture', blob]])
  return response
}
const scopedBinary = scopedConnection.rpc.call('/api', 'session/cancel', { args: {} }); await binaryStarted
assert.equal(scoped.inspection().unary.observedPendingRequests, 1)
finishScopedBinary(new Uint8Array([44,55]).buffer); assert.deepEqual(Array.from((await scopedBinary).value), [44,55])
assert.equal(scoped.inspection().unary.observedPendingRequests, 0)
assert.equal(scoped.inspection().automaticReleaseEligible, false)
detach(); assert.equal(scopedConnection.rpc.call, originalRpc)
await writeFile(output, JSON.stringify({ passed: true, sdkBundleSha256: createHash('sha256').update(source).digest('hex'),
  ledgerSourceSha256: createHash('sha256').update(await readFile(new URL('../src/remote/operation-ledger.ts', import.meta.url))).digest('hex'),
  scopedObserverSourceSha256: createHash('sha256').update(await readFile(new URL('../src/remote/operation-client.ts', import.meta.url))).digest('hex'),
  actualUnmodifiedSdkFactory: true, mockContextAndHttpTransport: true, localRejectNotDispatched: true,
  headersDoNotCompleteObservation: true, rpcIdMismatchRemainsUnknown: true, validatedRefusalAcknowledged: true,
  abortAfterDispatchRemainsUnknown: true, pendingUntilBinaryDecoded: true, durableUnknownBeforeRelease: true,
  persistedUnknownAfterStoreRestart: 2, actualScopedUnaryDecoratorVerified: true, scopedBinaryDecodeWaitVerified: true, concurrentDefaultSdkCallsVerified: true,
  pageBootCoverageVerified: false, realHostVerified: false,
  nativeUiVerified: false, automaticViewReleaseVerified: false, modelRequests: 0 }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
console.log('Actual SDK unary acknowledgement contract passed; Context/transport are mocked, page coverage and automatic release remain unverified')
