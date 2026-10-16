// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SshApi, TransferCancelledError } from '../src/client/api.ts'
import { TransferTab } from '../src/client/panel/TransferTab.tsx'
import { browserTransferHistory } from '../src/client/transfer-history.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
afterEach(() => {
  act(() => roots.splice(0).forEach(root => root.unmount()))
  document.body.replaceChildren(); document.documentElement.removeAttribute('lang')
  sessionStorage.clear(); vi.unstubAllGlobals()
})
async function fixture() {
  document.documentElement.lang = 'en'
  const api = new SshApi()
  vi.spyOn(api, 'listHosts').mockResolvedValue([{ alias: 'fixture', host: '127.0.0.1', port: 22, user: 'test', auth: 'key', tags: [], updatedAt: 1 } as never])
  const element = document.createElement('div'); document.body.appendChild(element)
  const root = createRoot(element); roots.push(root)
  await act(async () => root.render(<TransferTab api={api} />))
  const select = element.querySelector('select')!
  await act(async () => { select.value = 'fixture'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  const input = element.querySelector<HTMLInputElement>('input[placeholder]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '/remote/')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return { api, root, element }
}
function button(element: Element, text: string) {
  return [...element.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!
}
async function upload(element: Element) {
  const input = element.querySelector<HTMLInputElement>('input[type=file]')!
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['test'], 'file.txt')] })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
}

it('shows the selected local filename and disk saving stage, then retains the completed receipt after reload', async () => {
  vi.stubGlobal('showSaveFilePicker', vi.fn(async () => ({ name: 'local-恢复.bin', createWritable: vi.fn() })))
  const f = await fixture(); let complete!: () => void
  const download = vi.spyOn(f.api, 'downloadFile').mockImplementation(async (_alias, _path, report) => {
    report?.({ phase: 'saving', file: '/remote/', transferred: 4, total: 4, percent: 100 })
    await new Promise<void>(resolve => { complete = resolve })
    return { filename: 'original.bin', streamed: true, bytes: 4 }
  })
  await act(async () => button(f.element, 'Download').click())
  expect(f.element.textContent).toContain('Local filename: local-恢复.bin')
  expect(f.element.textContent).toContain('Saving local file…'); expect(f.element.textContent).not.toContain('Done:')
  await act(async () => complete()); expect(f.element.textContent).toContain('Done: 4 bytes')
  await act(async () => f.root.unmount())
  const restored = await fixture(), nextDownload = vi.spyOn(restored.api, 'downloadFile')
  expect(restored.element.textContent).toContain('Local filename: local-恢复.bin'); expect(restored.element.textContent).toContain('Done: 4 bytes')
  expect(download).toHaveBeenCalledOnce(); expect(nextDownload).not.toHaveBeenCalled()
})

it('restores interrupted and pending uploads, rejects changed selections, then starts only the reviewed pending file', async () => {
  const first = await fixture(), selected = [new File(['test'], 'first.txt', { lastModified: 1234 }), new File(['data'], 'second.txt', { lastModified: 4567 })]
  let complete!: (value: { transferredBytes: number }) => void
  const originalUpload = vi.spyOn(first.api, 'uploadFile').mockReturnValue(new Promise(resolve => { complete = resolve }))
  const input = first.element.querySelector<HTMLInputElement>('input[type=file]')!
  Object.defineProperty(input, 'files', { configurable: true, value: selected })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
  await act(async () => first.root.unmount())
  const recovered = await fixture(), upload = vi.spyOn(recovered.api, 'uploadFile').mockResolvedValue({ transferredBytes: 4 })
  expect(recovered.element.textContent).toContain('Result unconfirmed'); expect(recovered.element.textContent).toContain('Source file needed')
  expect(recovered.element.querySelector('article')?.textContent).toContain('Result unconfirmed')
  expect(button(recovered.element, 'Resume queue').disabled).toBe(true); expect(upload).not.toHaveBeenCalled()
  const restore = button(recovered.element, 'Re-select files (1)'); restore.focus()
  await act(async () => restore.click())
  const reselect = recovered.element.querySelector<HTMLInputElement>('input[type=file]')!
  Object.defineProperty(reselect, 'files', { configurable: true, value: [new File(['changed'], 'second.txt', { lastModified: 4567 })] })
  await act(async () => reselect.dispatchEvent(new Event('change', { bubbles: true })))
  expect(recovered.element.textContent).toContain('does not match'); expect(upload).not.toHaveBeenCalled()
  await act(async () => button(recovered.element, 'Re-select files (1)').click())
  Object.defineProperty(reselect, 'files', { configurable: true, value: [new File(['data'], 'second.txt', { lastModified: 4567 })] })
  await act(async () => reselect.dispatchEvent(new Event('change', { bubbles: true })))
  expect(document.activeElement).toBe(button(recovered.element, 'Resume queue')); expect(upload).not.toHaveBeenCalled()
  await act(async () => button(recovered.element, 'Resume queue').click())
  expect(upload).toHaveBeenCalledOnce(); expect(upload.mock.calls[0]?.slice(1, 3)).toEqual(['fixture', '/remote/second.txt'])
  await act(async () => complete({ transferredBytes: 4 }))
  expect(originalUpload).toHaveBeenCalledOnce(); expect(recovered.element.textContent).toContain('Result unconfirmed')
})

it('restores a waiting download and prepares its save method without starting until Resume', async () => {
  const first = await fixture()
  vi.spyOn(first.api, 'uploadFile').mockReturnValue(new Promise(() => {}))
  await upload(first.element); await act(async () => button(first.element, 'Pause queue').click())
  const originalDownload = vi.spyOn(first.api, 'downloadFile')
  await act(async () => button(first.element, 'Download').click()); expect(originalDownload).not.toHaveBeenCalled()
  await act(async () => first.root.unmount())
  const recovered = await fixture(), download = vi.spyOn(recovered.api, 'downloadFile').mockResolvedValue({ streamed: true, bytes: 4, filename: 'file.txt' })
  expect(recovered.element.textContent).toContain('Save method needed'); expect(button(recovered.element, 'Resume queue').disabled).toBe(true)
  await act(async () => button(recovered.element, 'Choose save location').click())
  expect(download).not.toHaveBeenCalled(); expect(button(recovered.element, 'Resume queue').disabled).toBe(false)
  await act(async () => button(recovered.element, 'Resume queue').click())
  expect(download).toHaveBeenCalledOnce(); expect(download.mock.calls[0]?.[6]).toBe(1)
})

it('keeps unreadable records, starts nothing and clears them only after explicit confirmation', async () => {
  const store = browserTransferHistory(); store.write('{broken')
  const f = await fixture(), upload = vi.spyOn(f.api, 'uploadFile'), download = vi.spyOn(f.api, 'downloadFile')
  expect(button(f.element, 'Upload').disabled).toBe(true); expect(f.element.textContent).toContain('Original record kept')
  await act(async () => button(f.element, 'Retry record').click()); expect(store.read()).toBe('{broken')
  await act(async () => button(f.element, 'Clear recovery record').click())
  const dialog = f.element.querySelector('[role=alertdialog]')!
  await act(async () => button(dialog, 'Cancel').click()); expect(store.read()).toBe('{broken')
  expect(document.activeElement).toBe(button(f.element, 'Clear recovery record'))
  await act(async () => button(f.element, 'Clear recovery record').click())
  await act(async () => f.element.querySelector('[role=alertdialog]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(store.read()).toBe('{broken'); expect(f.element.querySelector('[role=alertdialog]')).toBeNull()
  expect(document.activeElement).toBe(button(f.element, 'Clear recovery record'))
  await act(async () => button(f.element, 'Clear recovery record').click())
  await act(async () => button(f.element.querySelector('[role=alertdialog]')!, 'Clear recovery record').click())
  expect(store.read()).toBeNull(); expect(button(f.element, 'Upload').disabled).toBe(false)
  expect(upload).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled()
})

it('stops only the active upload, keeps destination context and ignores late progress', async () => {
  const { api, element } = await fixture()
  let progress: Parameters<SshApi['uploadFile']>[3], signal: AbortSignal | undefined
  const transfer = vi.spyOn(api, 'uploadFile').mockImplementation((_file, _alias, path, report, abort) => {
    expect(path).toBe('/remote/file.txt'); progress = report; signal = abort
    return new Promise((_resolve, reject) => abort?.addEventListener('abort', () => reject(new TransferCancelledError(true))))
  })
  await upload(element)
  await act(async () => progress?.({ phase: 'transferring', file: '/remote/file.txt', transferred: 2, total: 4, percent: 50 }))
  expect(element.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('50')
  await act(async () => progress?.({ phase: 'transferring', file: '/remote/file.txt', transferred: 3072, total: 0, percent: 0 }))
  expect(element.textContent).toContain('3.0 KB')
  expect(element.querySelector('[role=progressbar]')?.hasAttribute('aria-valuenow')).toBe(false)
  await act(async () => button(element, 'Stop transfer').click())
  expect(signal?.aborted).toBe(true)
  expect(element.textContent).toContain('only partly written')
  expect(element.textContent).toContain('Upload · fixture')
  expect(element.textContent).toContain('test@127.0.0.1:22 · /remote/file.txt')
  await act(async () => progress?.({ phase: 'done', file: '/remote/file.txt', transferred: 4, total: 4, percent: 100 }))
  expect(element.textContent).not.toContain('Done:')
  expect(transfer).toHaveBeenCalledOnce()
  expect(button(element, 'Upload').disabled).toBe(false)
})

it('aborts its transfer when unmounted and never reports late success', async () => {
  const { api, root, element } = await fixture()
  let signal: AbortSignal | undefined, complete: (value: { transferredBytes: number }) => void
  vi.spyOn(api, 'uploadFile').mockImplementation((_file, _alias, _path, _progress, abort) => {
    signal = abort; return new Promise(resolve => { complete = resolve })
  })
  await upload(element)
  await act(async () => root.unmount())
  expect(signal?.aborted).toBe(true)
  await act(async () => complete!({ transferredBytes: 4 }))
  expect(element.textContent).toBe('')
})

it.each([true, false])('returns focus after Stop only while the transfer panel is active (%s)', async active => {
  const { api, root, element } = await fixture()
  let fail: (error: Error) => void
  vi.spyOn(api, 'uploadFile').mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
  await upload(element)
  const stop = button(element, 'Stop transfer'); stop.focus()
  await act(async () => stop.click())
  const other = document.createElement('button'); document.body.appendChild(other)
  if (!active) {
    await act(async () => root.render(<TransferTab api={api} active={false} />))
    other.focus()
  }
  await act(async () => fail!(new TransferCancelledError(true)))
  expect(document.activeElement).toBe(active ? element.querySelector('summary') : other)
  expect(element.textContent).not.toContain('Done:')
})

it('keeps native save cancellation distinct from a dispatched download stop', async () => {
  const { api, element } = await fixture()
  vi.spyOn(api, 'downloadFile').mockRejectedValue(new TransferCancelledError(false))
  await act(async () => button(element, 'Download').click())
  expect(element.textContent).toContain('No transfer was started')
  expect(element.textContent).not.toContain('Stop requested')
})

it('passes the selected download method and chooses browsed directories as upload targets', async () => {
  const { api, element } = await fixture()
  vi.spyOn(api, 'ls').mockResolvedValue([{ name: 'folder', type: 'dir', size: 0, mtimeMs: 0, mode: 0o700 }])
  await act(async () => button(element, 'Browse remote').click())
  const folder = [...element.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes('folder'))!
  await act(async () => folder.click())
  expect(element.querySelector<HTMLInputElement>('input[placeholder]')!.value).toBe('/remote/folder/')
  const mode = element.querySelectorAll('select')[1]!
  await act(async () => { mode.value = 'browser'; mode.dispatchEvent(new Event('change', { bubbles: true })) })
  const download = vi.spyOn(api, 'downloadFile').mockRejectedValue(new Error('Directory download is not supported'))
  await act(async () => button(element, 'Download').click())
  expect(download.mock.calls[0]?.[4]).toBe('browser')
  expect(element.textContent).toContain('Directory download is not supported')
})

it('exits a pending save picker without dispatch and ignores its late selected writer', async () => {
  const { api, element } = await fixture()
  let choose!: (value: { createWritable: () => Promise<never> }) => void
  vi.stubGlobal('showSaveFilePicker', vi.fn(() => new Promise(resolve => { choose = resolve })))
  const download = vi.spyOn(api, 'downloadFile'), writer = vi.fn()
  await act(async () => button(element, 'Download').click())
  expect(button(element, 'Download').disabled).toBe(true)
  await act(async () => button(element, 'Cancel preparation').click())
  expect(button(element, 'Download').disabled).toBe(false)
  expect(document.activeElement).toBe(button(element, 'Download'))
  await act(async () => choose({ createWritable: writer }))
  expect(writer).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled()
  expect(element.textContent).not.toContain('Transfer 1:')
  expect(element.textContent).toContain('Preparation cancelled; no transfer started')
})

it.each([true, false])('treats native picker cancellation as information and preserves focus ownership (active=%s)', async active => {
  const { api, element, root } = await fixture(); let cancel!: (cause: unknown) => void
  vi.stubGlobal('showSaveFilePicker', vi.fn(() => new Promise((_resolve, reject) => { cancel = reject })))
  const download = vi.spyOn(api, 'downloadFile'), trigger = button(element, 'Download'); trigger.focus()
  await act(async () => trigger.click())
  const external = document.createElement('input'); document.body.append(external)
  if (!active) { await act(async () => root.render(<TransferTab api={api} active={false} />)); external.focus() }
  else { trigger.blur() }
  await act(async () => cancel(new DOMException('User cancelled', 'AbortError')))
  expect(download).not.toHaveBeenCalled(); expect(element.textContent).toContain('Save cancelled. No transfer was started.')
  expect(element.querySelector('[data-kind="info"]')).not.toBeNull(); expect(element.querySelector('article')).toBeNull()
  expect(document.activeElement).toBe(active ? trigger : external)
})

it('checks a recovered upload from its own receipt without replaying it or rewriting the recovery record', async () => {
  const original = await fixture(), firstUpload = vi.spyOn(original.api, 'uploadFile').mockReturnValue(new Promise(() => {}))
  await upload(original.element); await act(async () => original.root.unmount())
  const recovered = await fixture(), store = browserTransferHistory(), before = store.read()
  const check = vi.spyOn(recovered.api, 'inspectDestination').mockResolvedValue({ exists: true, type: 'file', size: 4, mtimeMs: 1000, checkedAt: 2000 })
  const replay = vi.spyOn(recovered.api, 'uploadFile')
  await act(async () => button(recovered.element, 'Check destination').click())
  expect(check).toHaveBeenCalledWith('fixture', '/remote/file.txt', 1, expect.any(AbortSignal))
  expect(recovered.element.textContent).toContain('Result unconfirmed'); expect(recovered.element.textContent).toContain('contents not verified')
  expect(store.read()).toBe(before); expect(firstUpload).toHaveBeenCalledOnce(); expect(replay).not.toHaveBeenCalled()
})
