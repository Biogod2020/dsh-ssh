/** Exercise the supplied unmodified rc.2 Client Gateway in real Cordis.
 * HTTP, WebSocket and user handlers are generated mocks, not a real Host/UI. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash, webcrypto } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Script, createContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import { createOperationLedger } from '../src/remote/operation-ledger.ts'
import { createRemoteOperationObserver } from '../src/remote/operation-streams.ts'
import { operationTransport } from '../src/remote/operation-client.ts'

const [scopeDirectory, output] = process.argv.slice(2)
assert(scopeDirectory && output && isAbsolute(scopeDirectory) && isAbsolute(output), 'Supply absolute @deepseek-ai package directory and new report path')
const gatewayPath = join(scopeDirectory, 'dsh-api-gateway/lib/types/client/index.js')
const eventPath = join(scopeDirectory, 'dsh-api-gateway/lib/types/client/remote-events.js')
const streamPath = join(scopeDirectory, 'dsh-api-gateway/lib/types/client/stream-client.js')
const connectionPath = join(scopeDirectory, 'dsh-client-connection/lib/client.browser.js')
const gateway = await import(pathToFileURL(gatewayPath).href)
const modules = [], context = new Context(), sockets = [], sent = [], replies = []
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const until = async predicate => { for (let n = 0; n < 100 && !predicate(); n++) await new Promise(setImmediate); assert(predicate(), 'Generated SDK callback did not occur') }
let onReply, onQuestion, disposedAgent = 0
class Socket extends EventTarget {
  readyState = 0
  constructor() { super(); sockets.push(this) }
  send(text) { assert.equal(this.readyState, 1); sent.push(JSON.parse(text)) }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')) }
}
const window = { __ModuleLoader__: { load: module => modules.push(module) } }
const sandbox = createContext({ window, crypto: webcrypto, Blob, Uint8Array, URL, AbortController, AbortSignal, setTimeout, clearTimeout, console,
  fetch: async (_path, init) => {
    const request = JSON.parse(init.body); replies.push(request)
    return onReply(request)
  } })
const connectionSource = await readFile(connectionPath, 'utf8')
new Script(connectionSource).runInContext(sandbox, { timeout: 3000 })
const sdk = modules[0].factory(() => { throw Error('Unexpected SDK import') })
new Script(`(${operationTransport.toString()})('aaaaaaaaaaaaaaaaaaaaaaaa',(${createOperationLedger.toString()}),(${createRemoteOperationObserver.toString()}));`).runInContext(sandbox, { timeout: 3000 })
const observer = window.__dshSshOperations, transport = window.__DSH_TRANSPORT__
transport.createWebSocket = () => new Socket()
transport.streamBaseUrl = 'http://127.0.0.1/'
sdk.installConnection(context, { transport, interactions: 'answer', location: { hostname: '127.0.0.1' } })
context.provide('loader', { await: () => new Promise(() => {}) })
const agent = { waterfall: (...args) => onQuestion(...args) }
context.provide('typert', { contexts: { getClient: () => ({ resolve: () => ({
  [Symbol.for('dsh.typert.owned-value')]: true, value: agent, [Symbol.dispose]() { disposedAgent++ },
}) }) } })
gateway.apply(context)
const remote = context.get('remote'), connection = context.get('connection'), events = remote.events
assert(remote && connection && events, 'Actual SDK service and forwarded-event owner must be present')
const originalStream = remote.openRemoteStream, originalAnswer = events.answer
const streamDescriptor = Object.getOwnPropertyDescriptor(remote, 'openRemoteStream'), answerDescriptor = Object.getOwnPropertyDescriptor(events, 'answer')
const detachRpc = observer.attach(connection.rpc), detachRemote = observer.attachRemote(remote)
assert.notEqual(remote.openRemoteStream, originalStream); assert.notEqual(events.answer, originalAnswer)
const logical = () => observer.inspection().logical
const body = request => ({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: {} } })
const controller = new AbortController()
let running
try {
  assert.equal(sockets.length, 1); sockets[0].open()
  const ready = deferred()
  running = events.runGeneration(controller.signal, ready.resolve)
  await until(() => sent.some(frame => frame.type === 'open' && frame.endpoint === '$events'))
  const streamId = sent.find(frame => frame.type === 'open' && frame.endpoint === '$events').streamId
  sockets[0].receive({ type: 'item', streamId, value: { type: 'ready', clientId: 'generated-client', host: { home: '/generated/home' } } })
  await ready.promise
  assert.equal(logical().observedStreams, 0); assert.equal(logical().observedEventSubscriptions, 1)
  assert.equal(logical().observedWaitingAnswers, 0, 'An open physical socket/event subscription is not an unanswered question')
  const userAnswer = deferred(), responseBody = deferred()
  onQuestion = async () => userAnswer.promise
  onReply = request => { const response = new Response('', { headers: { 'content-type': 'application/json' } }); response.json = () => responseBody.promise.then(() => body(request)); return response }
  const question = { type: 'waterfall', event: 'generated/question', eventId: 'generated-event', agentId: 'generated-agent', request: { generated: 'not persisted' } }
  sockets[0].receive({ type: 'item', streamId, value: question })
  await until(() => logical().observedWaitingAnswers === 1)
  assert.equal(replies.length, 0); assert.equal(disposedAgent, 0)
  userAnswer.resolve('Generated user answer')
  await until(() => replies.length === 1)
  assert.equal(logical().observedWaitingAnswers, 1, 'Result HTTP headers are not an acknowledgement or finished owner cleanup')
  assert.equal(observer.inspection().unary.observedPendingRequests, 1)
  responseBody.resolve(); await until(() => logical().observedWaitingAnswers === 0)
  assert.equal(disposedAgent, 1); assert.equal(replies.length, 1, 'No replay of the answer')
  const ignoredCancel = deferred()
  onQuestion = async () => ignoredCancel.promise
  sockets[0].receive({ type: 'item', streamId, value: { ...question, eventId: 'cancelled-generated-event' } })
  await until(() => logical().observedWaitingAnswers === 1)
  sockets[0].receive({ type: 'item', streamId, value: { type: 'cancel', eventId: 'cancelled-generated-event' } })
  await new Promise(setImmediate)
  assert.equal(logical().observedWaitingAnswers, 1, 'Host cancellation cannot make an unresolved user handler disappear')
  ignoredCancel.resolve('late generated answer'); await until(() => logical().observedWaitingAnswers === 0)
  assert.equal(disposedAgent, 2); assert.equal(replies.length, 1, 'The SDK does not send a cancelled answer')
  const read = remote.openRemoteStream('generated/read', { args: {} }, new AbortController().signal), next = read.next()
  await until(() => sent.some(frame => frame.type === 'open' && frame.endpoint === 'generated/read'))
  const id = sent.find(frame => frame.type === 'open' && frame.endpoint === 'generated/read').streamId
  assert.equal(logical().observedStreams, 1)
  sockets[0].receive({ type: 'item', streamId: id, value: { generated: 7 } })
  assert.deepEqual(await next, { done: false, value: { generated: 7 } }); assert.equal(logical().observedStreams, 1)
  const end = read.next(); sockets[0].receive({ type: 'end', streamId: id }); assert.equal((await end).done, true)
  assert.equal(logical().observedStreams, 0)
  assert.equal(observer.inspection().fullCoverage, false); assert.equal(observer.inspection().pendingRequests, null)
  assert.equal(observer.inspection().automaticReleaseEligible, false)
  assert(!JSON.stringify(observer.inspection()).match(/generated-event|generated-client|generated-agent|Generated user answer|not persisted/))
  controller.abort(); await running; running = undefined
  assert.equal(logical().observedEventSubscriptions, 0)
  detachRemote(); detachRpc()
  assert.deepEqual(Object.getOwnPropertyDescriptor(remote, 'openRemoteStream'), streamDescriptor)
  assert.deepEqual(Object.getOwnPropertyDescriptor(events, 'answer'), answerDescriptor)
} finally {
  controller.abort(); if (running) await running.catch(() => {})
  detachRemote(); detachRpc(); await context.fiber.dispose()
}
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex')
await writeFile(output, JSON.stringify({ passed: true, actualUnmodifiedSdkGatewayAndEvents: true, realCordisContext: true,
  mockHttpWebSocketAndUserHandlers: true, pendingUntilValidatedResultAndAgentCleanup: true,
  physicalSocketAndEventSubscriptionNotCountedAsQuestion: true, cancelledHandlerProtectedUntilSettlement: true,
  cancelledReplyNotSent: true, actualMuxItemsAndEndPreserved: true, restoredOriginalMethods: true,
  correlationAndContentExcludedFromInspection: true, connectionBundleSha256: await hash(connectionPath),
  gatewayModuleSha256: await hash(gatewayPath), eventsModuleSha256: await hash(eventPath), streamModuleSha256: await hash(streamPath),
  observerSourceSha256: await hash(new URL('../src/remote/operation-streams.ts', import.meta.url)),
  transportSourceSha256: await hash(new URL('../src/remote/operation-client.ts', import.meta.url)),
  fullPageBootCoverageVerified: false, realHostVerified: false, nativeUiVerified: false, automaticViewReleaseVerified: false,
  modelRequests: 0 }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
console.log('Unmodified rc.2 SDK + real Cordis logical stream and incoming answer contract passed; transports/handlers mocked, no full release claim')
