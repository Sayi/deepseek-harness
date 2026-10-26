/** Sessions offered by the Desktop tray menu: the running ones first, then the most recently active. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
// Type-only: contributes the `sessionProjections` Context merge and its registry type.
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
// Type-only: contributes the optional `sessionProjectionCache` Context merge.
import type {} from '@deepseek-ai/dsh-session-projection-cache'
// Type-only: contributes the `sessionQuery` Context merge.
import type {} from '@deepseek-ai/dsh-session-query'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import type {} from '@deepseek-ai/dsh-workspace'

/** One Session the tray lists; the shell mirrors this shape across its private IPC channel. */
export interface DesktopTraySession {
  /** Durable Session identity the shell names when the entry is chosen. */
  readonly sessionId: string
  /** Latest log-backed title, absent until the Session records one. */
  readonly title?: string
  /** Display name of the Session's working directory. */
  readonly project?: string
  /** Whether a live top-level Agent is running this Session now. */
  readonly running: boolean
}

/** Highest number of Sessions one tray menu lists. */
export const DESKTOP_TRAY_SESSION_LIMIT = 5

/** Summary values the menu orders and labels by. */
interface SessionListFacts {
  /** The `title` projection: the latest log-backed title, absent when none was ever folded. */
  readonly title?: string
  /** The `sessionListMetadata` projection's "no turn has started" flag. */
  readonly blank: boolean
  /** The `sessionListMetadata` projection's last user prompt time, or 0 without one. */
  readonly lastPromptAt: number
}

/**
 * Register the tray Session listing on the owning Host context.
 * @param ctx - Booted Desktop profile context; disposal makes the listing reject.
 * @returns Listing of up to {@link DESKTOP_TRAY_SESSION_LIMIT} Sessions: running ones in
 *   registration order, then the rest by most recent activity. Title and activity come from
 *   already-materialized projection cells, so listing neither activates an Agent nor replays a log.
 */
export function installDesktopTraySessions(ctx: Context): () => Promise<readonly DesktopTraySession[]> {
  let stopped = false
  ctx.effect(() => () => { stopped = true })
  return async () => {
    if (stopped) throw new Error('desktop tray: Host is stopping')
    const agents = ctx.get('agents')
    const query = ctx.get('sessionQuery')
    const projections = ctx.get('sessionProjections')
    if (agents === undefined || query === undefined || projections === undefined) {
      throw new Error('desktop tray: session services are unavailable')
    }
    const archived = new Set<string>(ctx.get('workspaceRegistry')?.archivedSessionIds ?? [])
    const listed = new Set<string>()
    const sessions: DesktopTraySession[] = []
    for (const agent of agents.roots()) {
      if (agent.status !== 'running') continue
      listed.add(agent.id)
      sessions.push(describe(agent.id, agent.session.header, liveFacts(projections, agent.session), true))
      if (sessions.length === DESKTOP_TRAY_SESSION_LIMIT) return sessions
    }
    const records = await query.listSessions()
    const candidates = records
      .filter(record => !listed.has(record.header.id) && !archived.has(record.header.id)
        && record.header.origin !== 'subagent')
      .map((record) => {
        const facts = cachedFacts(ctx, record.header)
        return {
          header: record.header,
          facts,
          updatedAt: Math.max(record.header.createdAt, facts?.lastPromptAt ?? 0),
        }
      })
      // A Session whose first turn never started is an unused draft, not recent work.
      .filter(candidate => candidate.facts?.blank !== true)
      .sort((left, right) => right.updatedAt - left.updatedAt)
    for (const candidate of candidates) {
      sessions.push(describe(candidate.header.id, candidate.header, candidate.facts, false))
      if (sessions.length === DESKTOP_TRAY_SESSION_LIMIT) break
    }
    return sessions
  }
}

/**
 * Projection values already folded for an attached Session.
 * @param projections - live projection registry of the booted profile.
 * @param session - attached Session to read.
 * @returns the summary values in memory, or undefined before any fold.
 */
function liveFacts(projections: SessionProjectionRegistry, session: Session): SessionListFacts | undefined {
  return factsOf(projections.cachedSnapshot(session, projections.summaryKeys()))
}

/** Projection values the persisted cache holds for a Session the Host did not attach. */
function cachedFacts(ctx: Context, header: SessionHeader): SessionListFacts | undefined {
  const cache = ctx.get('sessionProjectionCache')
  if (cache === undefined) return undefined
  try {
    const projections = ctx.get('sessionProjections')
    if (projections === undefined) return undefined
    const keys = projections.summaryKeys()
    return factsOf(cache.cachedSnapshot(header, keys)) ?? factsOf(cache.cachedPredecessorTitle(header))
  } catch (error: unknown) {
    // A cache read is a listing hint; an unusable row must not fail the whole menu.
    ctx.logger.warn(`desktop tray: projection cache read failed for "${header.id}": ${String(error)}`)
    return undefined
  }
}

/**
 * Reduce one projection block to the summary values the menu reads.
 * @param snapshot - projection block from the live registry or the persisted cache.
 * @returns the values present in the block, or undefined without a block.
 */
function factsOf(snapshot: { readonly values: unknown } | undefined): SessionListFacts | undefined {
  const values = snapshot?.values
  if (typeof values !== 'object' || values === null) return undefined
  const title = 'title' in values ? values.title : undefined
  const metadata = 'sessionListMetadata' in values ? values.sessionListMetadata : undefined
  const blank = typeof metadata === 'object' && metadata !== null && 'blank' in metadata && metadata.blank === true
  const lastPromptAt = typeof metadata === 'object' && metadata !== null && 'lastPromptAt' in metadata
    && typeof metadata.lastPromptAt === 'number' ? metadata.lastPromptAt : 0
  return {
    ...(typeof title === 'string' ? { title } : {}),
    blank,
    lastPromptAt,
  }
}

/**
 * Menu entry for one Session.
 * @param sessionId - durable Session identity.
 * @param header - that Session's header, for the working-directory name.
 * @param facts - summary values the menu orders and labels by.
 * @param running - whether a live top-level Agent runs the Session now.
 * @returns the entry the shell renders.
 */
function describe(
  sessionId: string,
  header: SessionHeader,
  facts: SessionListFacts | undefined,
  running: boolean,
): DesktopTraySession {
  return {
    sessionId,
    ...(facts?.title === undefined ? {} : { title: facts.title }),
    ...(header.cwd === undefined ? {} : { project: workspaceTitleOf(header.cwd) }),
    running,
  }
}
