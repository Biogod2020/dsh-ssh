/** Page-local compatibility for Desktop's permission-denying browser guests.
 * Serialize before the remote Client boots. No clipboard reads, IPC or SSH. */
export function embeddedClipboard(): void {
  const clipboard = navigator.clipboard
  if (!clipboard || typeof clipboard.writeText !== 'function' || typeof document.execCommand !== 'function') return
  const marker = Symbol.for('dsh-ssh.embedded-clipboard')
  if ((clipboard as unknown as Record<symbol, unknown>)[marker]) return
  const original = clipboard.writeText
  let copying = false
  const writeText = async (text: string): Promise<void> => {
    // Only a focused, visible document's current user gesture can use the
    // legacy copy path. Background calls retain the browser's own policy.
    if (typeof text === 'string' && !copying && navigator.userActivation?.isActive === true
      && !document.hidden && document.hasFocus() && document.body) {
      copying = true
      const focused = document.activeElement
      const input = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : undefined
      const selection = document.getSelection()
      const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : []
      const anchor = selection?.anchorNode, anchorOffset = selection?.anchorOffset
      const focus = selection?.focusNode, focusOffset = selection?.focusOffset
      const start = input?.selectionStart, end = input?.selectionEnd, direction = input?.selectionDirection
      const field = document.createElement('textarea')
      field.value = text; field.readOnly = true; field.tabIndex = -1
      field.setAttribute('aria-hidden', 'true')
      field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none'
      // Override only the event caused by our temporary field. No listener
      // survives the synchronous command or changes ordinary selection copy.
      const onCopy = (event: ClipboardEvent) => {
        if (event.target !== field || !event.clipboardData) return
        event.clipboardData.setData('text/plain', text); event.preventDefault()
      }
      let accepted = false
      try {
        document.body.append(field); field.focus({ preventScroll: true }); field.select()
        field.addEventListener('copy', onCopy)
        accepted = document.execCommand('copy') === true
      } catch { /* Fall through to the native API, preserving its rejection. */ }
      finally {
        field.removeEventListener('copy', onCopy); field.remove()
        try {
          if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true })
          if (input && start !== null && start !== undefined && end !== null && end !== undefined) input.setSelectionRange(start, end, direction ?? undefined)
          else if (selection) {
            if (ranges.length === 1 && anchor?.isConnected && focus?.isConnected && typeof selection.setBaseAndExtent === 'function') {
              selection.setBaseAndExtent(anchor, anchorOffset!, focus, focusOffset!)
            } else { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range) }
          }
        } catch { /* Selection can disappear when the owning component unmounts. */ }
        copying = false
      }
      if (accepted) return
    }
    await original.call(clipboard, text)
  }
  try {
    Object.defineProperty(clipboard, 'writeText', { configurable: true, writable: true, value: writeText })
    Object.defineProperty(clipboard, marker, { value: true })
  } catch { /* A future immutable API retains the browser's normal behavior. */ }
}
