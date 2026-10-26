import { describe, expect, it } from 'vitest'
import { pruneHostAuthCookies, type HostAuthCookie, type HostAuthCookieJar } from '../src/host-cookies.ts'

class FakeCookieJar implements HostAuthCookieJar {
  readonly removed: [string, string][] = []
  private readonly stored: readonly HostAuthCookie[]

  constructor(stored: readonly HostAuthCookie[]) {
    this.stored = stored
  }

  async get(): Promise<readonly HostAuthCookie[]> { return this.stored }

  async remove(url: string, name: string): Promise<void> { this.removed.push([url, name]) }
}

const cookie = (name: string, overrides: Partial<HostAuthCookie> = {}): HostAuthCookie => ({
  name, domain: '127.0.0.1', path: '/', secure: false, ...overrides,
})

const HOST_URL = 'http://127.0.0.1:54321/?token=launch'

describe('pruneHostAuthCookies', () => {
  it('removes every Host launch cookie and keeps unrelated cookies', async () => {
    const jar = new FakeCookieJar([
      cookie('dsh-auth-abc123'),
      cookie('dsh-auth-def456', { domain: '.localhost', path: '/nested', secure: true }),
      cookie('test_gate'),
    ])

    await pruneHostAuthCookies({ cookies: jar }, HOST_URL)

    expect(jar.removed).toEqual([
      ['http://127.0.0.1/', 'dsh-auth-abc123'],
      ['https://localhost/nested', 'dsh-auth-def456'],
    ])
  })

  it('falls back to the running Host for cookies without a stored domain or path', async () => {
    const jar = new FakeCookieJar([{ name: 'dsh-auth-abc123', secure: false }])

    await pruneHostAuthCookies({ cookies: jar }, HOST_URL)

    expect(jar.removed).toEqual([['http://127.0.0.1/', 'dsh-auth-abc123']])
  })

  it('leaves the jar untouched when no Host cookie is stored', async () => {
    const jar = new FakeCookieJar([cookie('test_gate')])

    await pruneHostAuthCookies({ cookies: jar }, HOST_URL)

    expect(jar.removed).toEqual([])
  })
})
