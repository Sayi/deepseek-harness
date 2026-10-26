/** Cookie maintenance for the Host authentication jar owned by the desktop shell. */

/**
 * Name prefix of the cookies `BrowserAuth` mints for Host requests
 * (`packages/client/connection/src/browser-auth.ts`).
 */
const HOST_AUTH_COOKIE_PREFIX = 'dsh-auth-'

/** Electron cookie fields that identify and remove one stored Host cookie. */
export interface HostAuthCookie {
  readonly name: string
  readonly domain?: string
  readonly path?: string
  readonly secure?: boolean
}

/** Cookie-jar slice used to enumerate and remove stored Host cookies. */
export interface HostAuthCookieJar {
  /**
   * @param filter - Electron cookie filter; an empty filter selects every stored cookie.
   * @returns Every cookie the jar holds for the filter.
   */
  get(filter: object): Promise<readonly HostAuthCookie[]>
  /**
   * @param url - Cookie domain and path identifying the stored cookie.
   * @param name - Stored cookie name.
   * @returns Completion after the jar removes the cookie.
   */
  remove(url: string, name: string): Promise<void>
}

function cookieUrl(cookie: HostAuthCookie, host: URL): string {
  const domain = cookie.domain ?? host.hostname
  const name = domain.startsWith('.') ? domain.slice(1) : domain
  const path = cookie.path === undefined || cookie.path === '' ? '/' : cookie.path
  const secure = cookie.secure ?? host.protocol === 'https:'
  return `${secure ? 'https' : 'http'}://${name}${path}`
}

/**
 * Remove Host authentication cookies left by earlier Desktop launches.
 *
 * Desktop binds its Host to an ephemeral port, and the Host names each cookie
 * after the full authority, including that port. Chromium scopes cookies by
 * host only, so every launch leaves another cookie that later requests keep
 * sending, until the Cookie header exceeds the Host's 16 KiB HTTP header limit
 * and authentication fails with 431.
 * @param browserSession - Electron session whose cookie jar serves Host requests.
 * @param hostUrl - Authenticated URL of the currently running Host.
 * @returns Completion after every stored Host cookie is removed.
 */
export async function pruneHostAuthCookies(
  browserSession: { readonly cookies?: HostAuthCookieJar } | undefined,
  hostUrl: string,
): Promise<void> {
  const jar = browserSession?.cookies
  if (jar?.get === undefined || jar?.remove === undefined) return
  const host = new URL(hostUrl)
  const stale = (await jar.get({}))
    .filter(cookie => cookie.name.startsWith(HOST_AUTH_COOKIE_PREFIX))
  await Promise.all(stale.map(cookie => jar.remove(cookieUrl(cookie, host), cookie.name)))
}
