import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_TRAY_SESSION_LIMIT, installDesktopTraySessions } from '../src/session-menu.ts'

/** Session header fields the listing reads. */
interface FakeHeader {
  readonly id: SessionId
  readonly createdAt: number
  readonly cwd?: string
  readonly origin?: 'subagent'
}

/** One live top-level Agent; only the roster fields the listing reads are present. */
interface FakeAgent {
  readonly id: SessionId
  status: 'idle' | 'running'
  readonly session: { readonly header: FakeHeader }
}

const agents: FakeAgent[] = []
const records: { header: FakeHeader }[] = []
const archived: SessionId[] = []
/** Projection values the live registry already folded, keyed by Session id. */
const folded = new Map<string, Record<string, unknown>>()
/** Projection values the persisted cache holds, keyed by Session id. */
const cached = new Map<string, Record<string, unknown>>()
const listSessions = vi.fn(async () => records)

let ctx: Context
let list: ReturnType<typeof installDesktopTraySessions>

function header(id: string, createdAt: number, extra: { readonly cwd?: string; readonly origin?: 'subagent' } = {}): FakeHeader {
  return { id: SessionId(id), createdAt, ...extra }
}

function running(id: string, extra: { readonly cwd?: string } = {}): void {
  agents.push({ id: SessionId(id), status: 'running', session: { header: header(id, 0, extra) } })
}

function latestAt(id: string, lastPromptAt: number, createdAt = 0): void {
  cached.set(id, { sessionListMetadata: { blank: false, lastPromptAt } })
  records.push({ header: header(id, createdAt) })
}

beforeEach(() => {
  agents.length = 0
  records.length = 0
  archived.length = 0
  folded.clear()
  cached.clear()
  listSessions.mockClear()
  ctx = new Context()
  // Service doubles exercise the listing against a real Cordis lifecycle.
  ctx.provide('agents', { roots: () => agents } as never)
  ctx.provide('sessionQuery', { listSessions } as never)
  ctx.provide('workspaceRegistry', { archivedSessionIds: archived } as never)
  ctx.provide('sessionProjections', {
    summaryKeys: () => new Set(['title', 'sessionListMetadata']),
    cachedSnapshot: (session: { readonly header: FakeHeader }) => {
      const values = folded.get(session.header.id)
      return values === undefined ? undefined : { asOfSeq: 0, values }
    },
  } as never)
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: (meta: { readonly id: SessionId }) => {
      const values = cached.get(meta.id)
      return values === undefined ? undefined : { asOfSeq: 0, values }
    },
    cachedPredecessorTitle: () => undefined,
  } as never)
  list = installDesktopTraySessions(ctx)
})

afterEach(async () => { await ctx.fiber.dispose() })

describe('Desktop tray session listing', () => {
  it('puts running Sessions first and fills the rest by most recent prompt', async () => {
    running('build')
    // Creation order and activity order disagree; the menu follows the last user prompt.
    latestAt('prompted', 900, 100)
    latestAt('fresh', 0, 600)
    latestAt('middle', 500, 500)
    expect(await list()).toEqual([
      { sessionId: 'build', running: true },
      { sessionId: 'prompted', running: false },
      { sessionId: 'fresh', running: false },
      { sessionId: 'middle', running: false },
    ])
  })

  it('caps the listing and stops reading persistence once running Sessions fill it', async () => {
    for (let index = 0; index < DESKTOP_TRAY_SESSION_LIMIT; index++) running(`run-${String(index)}`)
    latestAt('recent', 100)
    const listed = await list()
    expect(listed).toHaveLength(DESKTOP_TRAY_SESSION_LIMIT)
    expect(listed.every(session => session.running)).toBe(true)
    expect(listSessions).not.toHaveBeenCalled()
  })

  it('leaves out archived, subagent, and unused draft Sessions', async () => {
    archived.push(SessionId('archived'))
    records.push({ header: header('archived', 1) })
    records.push({ header: header('child', 2, { origin: 'subagent' }) })
    records.push({ header: header('draft', 3) })
    cached.set('draft', { sessionListMetadata: { blank: true, lastPromptAt: 0 } })
    latestAt('kept', 10)
    expect((await list()).map(session => session.sessionId)).toEqual(['kept'])
  })

  it('keeps a Session whose projections never folded and leaves its title to the shell', async () => {
    records.push({ header: header('unknown', 5, { cwd: '/work/easygo-service' }) })
    expect(await list()).toEqual([{ sessionId: 'unknown', project: 'easygo-service', running: false }])
  })

  it('labels a running Session from its live projection and carries the workspace name', async () => {
    running('build', { cwd: '/work/easygo-service' })
    folded.set('build', { title: 'Fix the login redirect' })
    expect(await list()).toEqual([
      { sessionId: 'build', title: 'Fix the login redirect', project: 'easygo-service', running: true },
    ])
  })

  it('rejects once the Host side is disposed', async () => {
    await ctx.fiber.dispose()
    await expect(list()).rejects.toThrow('desktop tray: Host is stopping')
  })

  it('rejects without the Session services the listing reads', async () => {
    const bare = new Context()
    const missing = installDesktopTraySessions(bare)
    await expect(missing()).rejects.toThrow('desktop tray: session services are unavailable')
    await bare.fiber.dispose()
  })
})
