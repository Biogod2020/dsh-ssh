// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ClusterResults } from '../src/client/panel/ClusterResults.tsx'
import type { ClusterRow } from '../src/client/cluster-history.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
afterEach(() => { act(() => roots.splice(0).forEach(root => root.unmount())); document.body.replaceChildren(); document.documentElement.removeAttribute('lang') })
const row = (alias: string, phase: ClusterRow['phase']): ClusterRow => ({ alias, phase, host: 'original.example', user: 'OriginalUser', port: 2222, updatedAt: 1, stdout: `${alias}-raw-output\n`, stderr: '' })
async function fixture(rows: ClusterRow[]) {
  document.documentElement.lang = 'en'
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); roots.push(root); const copy = vi.fn()
  const render = async (rows: ClusterRow[], active = true) => { await act(async () => root.render(<ClusterResults rows={rows} active={active} onCopy={copy} />)) }
  await render(rows)
  return { element, render, copy }
}
async function select(element: Element, label: string, value: string) {
  const control = element.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
  await act(async () => { control.value = value; control.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function search(element: Element, value: string) {
  const control = element.querySelector<HTMLInputElement>('input[type=search]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(control, value); control.dispatchEvent(new Event('input', { bubbles: true })) })
}
const names = (element: Element) => [...element.querySelectorAll('article')].map(x => x.getAttribute('aria-label'))
const button = (element: Element, text: string) => [...element.querySelectorAll('button')].find(x => x.textContent === text)!

it('separates uncertain and failed results from verified non-dispatch cancellation and counts the whole run', async () => {
  const rows: ClusterRow[] = ['ok', 'fail', 'timeout', 'stopped', 'unknown', 'notRun', 'queued', 'connecting', 'running'].map(phase => row(phase, phase as ClusterRow['phase']))
  const before = JSON.stringify(rows), f = await fixture(rows)
  await select(f.element, 'Result status', 'attention')
  expect(names(f.element)).toEqual(['fail', 'timeout', 'stopped', 'unknown']); expect(f.element.textContent).toContain('Showing 4/9 hosts')
  await select(f.element, 'Result status', 'active'); expect(names(f.element)).toEqual(['queued', 'connecting', 'running'])
  await select(f.element, 'Result status', 'notRun'); expect(names(f.element)).toEqual(['notRun'])
  await select(f.element, 'Result status', 'ok'); expect(names(f.element)).toEqual(['ok']); expect(JSON.stringify(rows)).toBe(before)
})
it('searches only the original public identity with case-insensitive intersection and keeps raw output unchanged', async () => {
  const first = row('Alpha-恢复', 'unknown'), second = { ...row('Beta', 'ok'), host: 'another.example', stdout: 'Alpha-恢复 SECRET-LIKE OUTPUT' }
  const f = await fixture([first, second])
  await search(f.element, '  ALPHA-恢复 '); expect(names(f.element)).toEqual(['Alpha-恢复'])
  await act(async () => button(f.element, 'Copy').click()); expect(f.copy).toHaveBeenCalledExactlyOnceWith(first)
  await search(f.element, 'originaluser@original.example:2222'); expect(names(f.element)).toEqual(['Alpha-恢复'])
  await select(f.element, 'Result status', 'ok'); expect(names(f.element)).toEqual([])
  expect(f.element.textContent).toContain('original record and export still contain all hosts'); expect(f.element.textContent).toContain('Showing 0/2 hosts')
  await act(async () => button(f.element, 'Clear filters').click()); expect(names(f.element)).toEqual(['Alpha-恢复', 'Beta'])
  expect(document.activeElement).toBe(f.element.querySelector('input')); expect(second.stdout).toBe('Alpha-恢复 SECRET-LIKE OUTPUT')
})
it('clears search on Escape while retaining the status filter and input focus', async () => {
  const f = await fixture([row('Alpha', 'unknown'), row('Beta', 'ok')]); await select(f.element, 'Result status', 'attention'); await search(f.element, 'missing')
  const input = f.element.querySelector('input')!; input.focus()
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(names(f.element)).toEqual(['Alpha']); expect(document.activeElement).toBe(input)
  expect(f.element.querySelector<HTMLSelectElement>('select[aria-label="Result status"]')?.value).toBe('attention')
})
it('updates live filters without moving focus or losing the complete result data', async () => {
  const original = [row('Alpha', 'running'), row('Beta', 'queued')], f = await fixture(original)
  await select(f.element, 'Result status', 'attention'); const input = f.element.querySelector('input')!; input.focus()
  await f.render([{ ...original[0]!, phase: 'timeout' }, { ...original[1]!, phase: 'notRun' }])
  expect(names(f.element)).toEqual(['Alpha']); expect(f.element.textContent).toContain('Alpha-raw-output'); expect(document.activeElement).toBe(input)
  expect(original.map(x => x.phase)).toEqual(['running', 'queued'])
})
it('locates only after the explicit action and scrolls its own viewport with result focus', async () => {
  const f = await fixture([row('Alpha', 'ok'), row('Beta', 'unknown')]), target = f.element.querySelectorAll<HTMLElement>('article')[1]!, viewport = target.parentElement!.parentElement!
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect); vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 450 } as DOMRect)
  viewport.scrollTop = 20
  await select(f.element, 'Locate host result', 'Beta'); expect(viewport.scrollTop).toBe(20)
  await act(async () => button(f.element, 'View result').click())
  expect(document.activeElement).toBe(target); expect(viewport.scrollTop).toBe(370); expect(window.scrollY).toBe(0)
  await f.render([row('Alpha', 'ok'), row('Beta', 'unknown')]); expect(document.activeElement).toBe(target); expect(viewport.scrollTop).toBe(370)
})
it('does not focus a hidden panel or a result excluded after a live status change', async () => {
  const f = await fixture([row('Alpha', 'running')]); await select(f.element, 'Result status', 'active'); await select(f.element, 'Locate host result', 'Alpha')
  const external = document.createElement('input'); document.body.append(external); external.focus()
  await f.render([row('Alpha', 'running')], false); await act(async () => button(f.element, 'View result').click()); expect(document.activeElement).toBe(external)
  await f.render([row('Alpha', 'ok')]); expect(button(f.element, 'View result').disabled).toBe(true)
  expect(f.element.querySelector<HTMLSelectElement>('select[aria-label="Locate host result"]')?.disabled).toBe(true); expect(document.activeElement).toBe(external)
})
it('returns lost card focus to search when a live filter removes it, without focusing a hidden panel', async () => {
  const f = await fixture([row('Alpha', 'running')]); await select(f.element, 'Result status', 'active')
  f.element.querySelector<HTMLElement>('article')!.focus()
  await f.render([row('Alpha', 'timeout')])
  expect(names(f.element)).toEqual([]); expect(document.activeElement).toBe(f.element.querySelector('input'))
  await f.render([row('Alpha', 'running')]); f.element.querySelector<HTMLButtonElement>('article button')!.focus()
  await f.render([row('Alpha', 'ok')], false)
  expect(document.activeElement).toBe(document.body)
})
