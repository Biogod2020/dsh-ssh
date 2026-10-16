import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
assert.equal(pkg.engines.dsh, pkg.dsh.engines.dsh, 'native and legacy DSH compatibility declarations must agree')
assert.equal(pkg.dependencies['@xterm/xterm'], '6.0.0', 'continuation adapter requires the pinned browser core')
assert.equal(pkg.dependencies['@xterm/headless'], '6.0.0', 'continuation adapter requires the matching headless core')
assert.equal(pkg.dependencies['@xterm/addon-serialize'], '0.14.0', 'serializer behavior is verified at the pinned version')
const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
assert(client.includes(`id: "${pkg.name}"`), 'browser module id must match package name')
assert(!/reportDailyHeartbeat|dsh-market|api\/telemetry/.test(client), 'no telemetry in browser bundle')
const requires = [...client.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1])
for (const id of requires) assert(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].includes(id), `unexpected client dependency ${id}`)
console.log(`Artifact verified: ${pkg.name}@${pkg.version}; client dependencies: ${[...new Set(requires)].join(', ')}`)
