// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SshApi, TransferDestinationHostChangedError } from '../src/client/api.ts'
import { TransferDestinationCheck } from '../src/client/panel/TransferDestinationCheck.tsx'
import type { TransferJob } from '../src/client/transfer-queue.ts'
import type { TransferDestinationInfo } from '../src/protocol.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
afterEach(() => { act(() => roots.splice(0).forEach(root => root.unmount())); document.body.replaceChildren(); document.documentElement.removeAttribute('lang') })
const job: TransferJob = { id: 1, kind: 'upload', phase: 'interrupted', alias: 'original', host: 'original.host', user: 'original', port: 2222, updatedAt: 12,
  path: '/original/file', file: 'file', sourceSize: 4, sourceModified: 100, transferred: 2, total: 4, percent: 50, dispatched: true }
function deferred() { let resolve!: (value: TransferDestinationInfo) => void; const promise = new Promise<TransferDestinationInfo>(done => { resolve = done }); return { promise, resolve } }
async function fixture(active = true) {
  document.documentElement.lang = 'en'
  const api = new SshApi(), element = document.createElement('div'); document.body.appendChild(element)
  const root = createRoot(element); roots.push(root)
  await act(async () => root.render(<TransferDestinationCheck api={api} job={job} active={active} />))
  return { api, element, root }
}
const button = (element: Element, text: string) => [...element.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === text)!
const file = { exists: true, type: 'file', size: 4, mtimeMs: 1000, checkedAt: 2000 } satisfies TransferDestinationInfo
it('explains changed host identity in Chinese while retaining the raw error behind a disclosure', async () => {
  const f = await fixture(); document.documentElement.lang = 'zh-CN'
  vi.spyOn(f.api, 'inspectDestination').mockRejectedValue(new TransferDestinationHostChangedError('Original host identity mismatch'))
  await act(async () => button(f.element, 'Check destination').click())
  expect(f.element.querySelector('[role="status"]')?.textContent).toContain('主机配置已改变')
  expect(f.element.querySelector('details')?.open).toBe(false)
  expect(f.element.querySelector('pre')?.textContent).toBe('Original host identity mismatch')
})
it('uses frozen identity on an explicit click and never confirms or retries an equal-size receipt', async () => {
  const f = await fixture(), before = structuredClone(job), check = vi.spyOn(f.api, 'inspectDestination').mockResolvedValue(file), upload = vi.spyOn(f.api, 'uploadFile')
  expect(check).not.toHaveBeenCalled(); button(f.element, 'Check destination').focus()
  await act(async () => button(f.element, 'Check destination').click())
  expect(check).toHaveBeenCalledWith('original', '/original/file', 12, expect.any(AbortSignal))
  expect(f.element.textContent).toContain('contents not verified'); expect(f.element.textContent).toContain('original transfer is not confirmed')
  expect(document.activeElement).toBe(button(f.element, 'Check again')); expect(job).toEqual(before); expect(upload).not.toHaveBeenCalled()
})
it('cancels only its check, restores focus and ignores a late reply even after a new explicit check fails', async () => {
  const f = await fixture(), pending = deferred(), check = vi.spyOn(f.api, 'inspectDestination').mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error('Permission denied'))
  await act(async () => { button(f.element, 'Check destination').click(); button(f.element, 'Check destination').click() })
  expect(check).toHaveBeenCalledOnce()
  await act(async () => { button(f.element, 'Cancel check').focus(); button(f.element, 'Cancel check').click() })
  expect(check.mock.calls[0]?.[3]?.aborted).toBe(true); expect(f.element.textContent).toContain('Check cancelled')
  expect(document.activeElement).toBe(button(f.element, 'Check destination'))
  await act(async () => button(f.element, 'Check destination').click())
  await act(async () => pending.resolve(file))
  expect(f.element.textContent).toContain('Permission denied'); expect(f.element.textContent).not.toContain('currently does not exist'); expect(f.element.textContent).not.toContain('contents not verified')
  expect(check).toHaveBeenCalledTimes(2)
})
it.each([true, false])('does not steal focus from another control or an inactive panel (%s)', async active => {
  const f = await fixture(active), pending = deferred(); vi.spyOn(f.api, 'inspectDestination').mockReturnValue(pending.promise)
  await act(async () => button(f.element, 'Check destination').click())
  const elsewhere = document.createElement('button'); document.body.appendChild(elsewhere); elsewhere.focus()
  await act(async () => pending.resolve(file)); expect(document.activeElement).toBe(elsewhere)
})
it('cancels its own request when the receipt is removed and ignores late results', async () => {
  const f = await fixture(), pending = deferred(), check = vi.spyOn(f.api, 'inspectDestination').mockReturnValue(pending.promise)
  await act(async () => button(f.element, 'Check destination').click()); await act(async () => f.root.unmount())
  expect(check.mock.calls[0]?.[3]?.aborted).toBe(true)
  await act(async () => pending.resolve(file)); expect(f.element.textContent).toBe(''); expect(check).toHaveBeenCalledOnce()
})
it('distinguishes missing paths and final symlinks without comparing their size to source content', async () => {
  const f = await fixture(); vi.spyOn(f.api, 'inspectDestination').mockResolvedValueOnce({ exists: false, checkedAt: 2000 }).mockResolvedValueOnce({ ...file, type: 'symlink' })
  await act(async () => button(f.element, 'Check destination').click())
  expect(f.element.textContent).toContain('currently does not exist'); expect(f.element.textContent).toContain('not confirmed or retried')
  await act(async () => button(f.element, 'Check again').click())
  expect(f.element.textContent).toContain('Symbolic link (not followed)'); expect(f.element.textContent).not.toContain('Same size')
})
