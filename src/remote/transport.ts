import type { ClientChannel } from 'ssh2'
import type { SshEngine } from '../engine.ts'
import { withClient } from '../engine/connection-pool.ts'
import { StringDecoder } from 'node:string_decoder'
import { RemoteFailureError } from './errors.ts'

export const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"

/** Exactly one dispatch. Private output stays here, never in generic exec logs or errors. */
export async function remoteScript(engine: SshEngine, alias: string, command: string, source: string,
  onLine: (line: string) => void, timeoutMs: number, expectedUpdatedAt?: number): Promise<void> {
  return withClient(engine, alias, client => new Promise<void>((resolve, reject) => {
    let channel: ClientChannel | undefined, done = false, bytes = 0, buffer = '', reported = ''
    const decoder = new StringDecoder('utf8')
    const finish = (error?: Error) => {
      if (done) return
      done = true; clearTimeout(timer); client.off('close', lost)
      error ? reject(error) : resolve()
    }
    const lost = () => finish(new Error('SSH disconnected; remote setup may still be running. Outcome unknown; not replayed.'))
    const timer = setTimeout(() => { channel?.close(); finish(new Error('Remote setup timed out; inspect its state before trying again. Not replayed.')) }, timeoutMs)
    client.once('close', lost)
    client.exec(command, (error, stream) => {
      if (error) { finish(new Error('Unable to dispatch remote setup. Not retried.')); return }
      channel = stream
      if (done) { stream.close(); return }
      stream.on('data', (data: Buffer) => {
        if (done) return
        bytes += data.length
        if (bytes > 1024 * 1024) { stream.close(); finish(new Error('Remote setup output exceeded its limit; outcome unknown')); return }
        buffer += decoder.write(data)
        for (let at; (at = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
          if (line.startsWith('DSH_ERROR:')) reported = line.slice(10).trim().slice(0, 500)
          try { onLine(line) } catch (error) { finish(error instanceof RemoteFailureError ? error : new Error('Invalid remote setup response')) }
          if (done) return
        }
      })
      // Remote shell diagnostics can contain credentials. Do not publish raw stderr.
      stream.stderr.resume()
      stream.once('error', lost)
      stream.once('close', (code: number | null) => finish(code === 0 ? undefined : new Error(reported || 'Remote setup failed; inspect its private log. No operation was replayed.')))
      stream.end(source)
    })
  }), undefined, expectedUpdatedAt)
}
