/** Read the installed SDK, not a reimplementation of its registry/dispatch. */
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

export function nativeShortcuts() {
  const bin = process.env.DSH_REMOTE_TEST_DSH ?? execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
  const require = createRequire(realpathSync(bin))
  const workspace = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-workspace/client'), 'utf8')
  const start = workspace.indexOf('function installWorkspaceShortcuts('), body = workspace.indexOf('{', start)
  if (start < 0) throw new Error('Set DSH_REMOTE_TEST_DSH to a reviewed RC2/RC3 SDK for shortcut contract tests')
  let depth = 0, end = -1
  for (let i = body; i < workspace.length; i++) {
    if (workspace[i] === '{') depth++
    if (workspace[i] === '}' && --depth === 0) { end = i + 1; break }
  }
  const install = Function(`return (${workspace.slice(start, end)})`)()
  const source = readFileSync(require.resolve('@deepseek-ai/dsh-client-shortcuts/client'), 'utf8')
    .replace('module.exports = ShortcutsService;', 'module.exports = { ShortcutRegistry, installNativeKeyboard };')
  let sdk: any
  Function('window', source)({ __ModuleLoader__: { load: ({ factory }: any) => {
    sdk = factory((id: string) => id === '@deepseek-ai/dsh-client-ui-primitives' ? { modalSelector: '[data-shortcut-modal]' } : require(id))
  } } })
  return { ...sdk, install }
}
