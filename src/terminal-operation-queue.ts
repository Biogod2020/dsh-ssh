/** Output parsing and resizing must share one order on both terminal renderers. */
export interface TerminalWriter {
  write(data: string, callback: () => void): void
  resize(cols: number, rows: number): void
}
export class TerminalOperationQueue {
  private tail: Promise<void> = Promise.resolve()
  private disposed = false
  private pending = new Set<() => void>()
  constructor(private terminal: TerminalWriter) {}
  run(task: () => void): Promise<void> {
    const operation = this.tail.then(() => { if (!this.disposed) task() })
    this.tail = operation.catch(() => undefined)
    return operation
  }
  write(data: string, applied?: () => void): Promise<void> {
    const operation = this.tail.then(() => {
      if (this.disposed || !data) return
      return new Promise<void>((resolve, reject) => {
        const done = (): void => {
          this.pending.delete(done)
          try { if (!this.disposed) applied?.(); resolve() } catch (error) { reject(error) }
        }
        this.pending.add(done)
        try { this.terminal.write(data, done) } catch (error) { this.pending.delete(done); reject(error) }
      })
    })
    this.tail = operation.catch(() => undefined)
    return operation
  }
  resize(cols: number, rows: number): Promise<void> { return this.run(() => this.terminal.resize(cols, rows)) }
  dispose(): void {
    this.disposed = true
    for (const done of this.pending) done()
    this.pending.clear()
  }
}
