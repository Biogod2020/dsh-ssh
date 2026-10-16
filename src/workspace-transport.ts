import type { SshEngine } from './engine.ts'
import { withClient } from './engine/connection-pool.ts'
import { WORKSPACE_WORKER } from './workspace-worker.ts'

export interface WorkerResult {
  ok: boolean
  error?: string
  code?: string
  path?: string
  version?: string
  value?: unknown
}

export class WorkspaceOperationError extends Error {
  constructor(message: string, readonly code?: string) { super(message) }
}

const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"

/** One dispatch, never retried. Loss after dispatch is always an uncertain outcome. */
export async function runWorkspaceOperation(engine: SshEngine, alias: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<WorkerResult> {
  signal?.throwIfAborted()
  return withClient(engine, alias, async client => {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      let done = false
      let channel: import('ssh2').ClientChannel | undefined
      const finish = (error?: Error, result?: WorkerResult): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        client.removeListener('close', lost)
        if (error) reject(error)
        else resolve(result!)
      }
      const stop = (): void => { try { channel?.signal('TERM'); channel?.close() } catch { /* lost */ } }
      const abort = (): void => {
        stop()
        finish(new Error('SSH operation cancelled; remote outcome may be unknown. Not retried.'))
      }
      const lost = (): void => finish(new Error('SSH connection lost; remote outcome may be unknown. Not retried.'))
      const args = input.args as { timeoutMs?: number } | undefined
      const timeout = input.op === 'bash' ? Math.min(args?.timeoutMs ?? 60000, 3600000) + 15000 : 30000
      const timer = setTimeout(() => { stop(); finish(new Error('SSH operation timed out; remote outcome may be unknown. Not retried.')) }, timeout)
      signal?.addEventListener('abort', abort, { once: true })
      client.once('close', lost)
      client.exec('python3 -c ' + quote(WORKSPACE_WORKER), (error, stream) => {
        if (error) { finish(new Error('SSH dispatch failed; remote outcome may be unknown. Not retried.', { cause: error })); return }
        channel = stream
        if (done || signal?.aborted) { stop(); abort(); return }
        const chunks: Buffer[] = []
        let bytes = 0
        let stderr = ''
        stream.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 64 * 1024 * 1024) { stop(); finish(new Error('SSH response exceeded limit; outcome may be unknown. Not retried.')); return }
          chunks.push(chunk)
        })
        stream.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString() })
        stream.once('error', lost)
        stream.once('close', (code: number | null) => {
          if (done) return
          if (code !== 0) { finish(new Error('Remote Python worker failed (' + code + '): ' + stderr + '; outcome may be unknown. Not retried.')); return }
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString()) as WorkerResult
            if (result.ok !== true) throw new WorkspaceOperationError(result.error ?? 'Remote operation failed', result.code)
            finish(undefined, result)
          } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
        })
        stream.end(JSON.stringify(input))
      })
    })
  })
}
