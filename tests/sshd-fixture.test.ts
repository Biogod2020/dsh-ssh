import { existsSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { TestSshd } from './helpers/sshd.ts'
import { DEFAULT_KNOWN_HOSTS } from '../src/engine/known-hosts.ts'

const available = process.platform !== 'win32' && existsSync('/usr/sbin/sshd')
it.skipIf(!available)('rejects another listener on the selected port before pinning the wrong generated key',async()=>{
  const first=await TestSshd.start()
  try {
    const before=readFileSync(DEFAULT_KNOWN_HOSTS[0]!)
    await expect(TestSshd.start({port:first.port})).rejects.toThrow('sshd failed to start')
    expect(readFileSync(DEFAULT_KNOWN_HOSTS[0]!)).toEqual(before)
    expect((first as any).process.exitCode).toBeNull()
    expect((first as any).process.signalCode).toBeNull()
  }finally{first.stop()}
})

it.skipIf(!available)('starts concurrent generated servers on distinct OS-selected ports and confirms each identity',async()=>{
  const fixtures:TestSshd[]=[]
  try {
    const results=await Promise.allSettled(Array.from({length:3},async()=>{fixtures.push(await TestSshd.start())}))
    expect(results.every(result=>result.status==='fulfilled')).toBe(true)
    expect(new Set(fixtures.map(server=>server.port)).size).toBe(3)
    const pins=readFileSync(DEFAULT_KNOWN_HOSTS[0]!,'utf8')
    for(const server of fixtures)expect(pins).toContain(`[127.0.0.1]:${server.port} ssh-ed25519 `)
  }finally{fixtures.forEach(server=>server.stop())}
})
