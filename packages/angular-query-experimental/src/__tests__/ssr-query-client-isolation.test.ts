// @vitest-environment node
/**
 * Spec for per-request QueryClient isolation under Angular server rendering.
 *
 * The application config is built once, as in the Angular quick start and the
 * generated `app.config.ts` / `main.server.ts` pair, and each render calls that
 * same bootstrap. These tests fail while a later request's HTML contains query
 * data fetched for an earlier visitor.
 *
 * A fix passes when either:
 * - the later response does not contain the earlier visitor's query data, or
 * - reusing one QueryClient instance across server bootstraps throws an Error
 *   whose message includes "QueryClient" and "server", and no HTML is returned.
 *
 * `injectMutation` writes the same client but is not rendered by this server
 * path, so it is not covered here.
 */
import '@angular/compiler'
import {
  Component,
  InjectionToken,
  REQUEST,
  inject,
  mergeApplicationConfig,
  provideZonelessChangeDetection,
} from '@angular/core'
import { bootstrapApplication } from '@angular/platform-browser'
import {
  provideServerRendering,
  renderApplication,
} from '@angular/platform-server'
import { QueryClient, isServer } from '@tanstack/query-core'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  injectInfiniteQuery,
  injectQuery,
  provideAngularQuery,
  provideQueryClient,
  provideTanStackQuery,
} from '..'
import { injectQueries } from '../inject-queries'
import type { BootstrapContext } from '@angular/platform-browser'
import type {
  ApplicationConfig,
  ApplicationRef,
  Provider,
  Type,
} from '@angular/core'

const VISITOR_HEADER = 'x-visitor'
const VICTIM = 'visitor-a'
const OTHER = 'visitor-b'
const STALE_TIME = new InjectionToken<number>('STALE_TIME')

const fetches: Array<string> = []

@Component({
  selector: 'app-profile',
  standalone: true,
  template: `{{ profile.data() ?? '' }}`,
})
class ProfileComponent {
  readonly #request = inject(REQUEST)
  readonly #staleTime = inject(STALE_TIME, { optional: true })
  readonly profile = injectQuery(() => ({
    queryKey: ['current-user'],
    staleTime: this.#staleTime ?? undefined,
    queryFn: () => loadVisitorRecord(this.#request, 'profile'),
  }))
}

@Component({
  selector: 'app-orders',
  standalone: true,
  template: `{{ orders.data()?.pages?.[0] ?? '' }}`,
})
class OrdersComponent {
  readonly #request = inject(REQUEST)
  readonly #staleTime = inject(STALE_TIME, { optional: true })
  readonly orders = injectInfiniteQuery(() => ({
    queryKey: ['my-orders'],
    initialPageParam: 0,
    staleTime: this.#staleTime ?? undefined,
    queryFn: () => loadVisitorRecord(this.#request, 'orders'),
    getNextPageParam: () => undefined,
  }))
}

@Component({
  selector: 'app-query-list',
  standalone: true,
  template: `{{ queries()[0]?.data ?? '' }}`,
})
class QueryListComponent {
  readonly #request = inject(REQUEST)
  readonly #staleTime = inject(STALE_TIME, { optional: true })
  readonly queries = injectQueries(() => ({
    queries: [
      {
        queryKey: ['current-user'],
        staleTime: this.#staleTime ?? undefined,
        queryFn: () => loadVisitorRecord(this.#request, 'profile'),
      },
    ],
  }))
}

function loadVisitorRecord(
  request: Request | null,
  kind: 'profile' | 'orders',
): Promise<string> {
  const visitor = request?.headers.get(VISITOR_HEADER)
  fetches.push(visitor ?? 'anonymous')
  if (!visitor) {
    return Promise.reject(new Error('401'))
  }
  return Promise.resolve(`${kind}:${visitor}`)
}

function serverBootstrap(
  root: Type<unknown>,
  queryProviders: Array<Provider>,
): (context: BootstrapContext) => Promise<ApplicationRef> {
  // Same shape as Angular's generated app.config.ts + main.server.ts:
  // the config object is created once and every request calls this bootstrap.
  const appConfig: ApplicationConfig = {
    providers: [provideZonelessChangeDetection(), ...queryProviders],
  }
  const config = mergeApplicationConfig(appConfig, {
    providers: [provideServerRendering()],
  })
  return (context) => bootstrapApplication(root, config, context)
}

function documentFor(selector: string): string {
  return `<!DOCTYPE html><html><head></head><body><${selector}></${selector}></body></html>`
}

async function renderVisitor(
  bootstrap: (context: BootstrapContext) => Promise<ApplicationRef>,
  selector: string,
  visitor: string | null,
): Promise<string> {
  const headers = new Headers()
  if (visitor !== null) {
    headers.set(VISITOR_HEADER, visitor)
  }
  return renderApplication(bootstrap, {
    document: documentFor(selector),
    url: 'http://localhost/profile',
    platformProviders: [
      {
        provide: REQUEST,
        useValue: new Request('http://localhost/profile', { headers }),
      },
    ],
  })
}

type SecondRender =
  | { html: string; error?: undefined }
  | { html?: undefined; error: unknown }

async function renderSecond(
  bootstrap: (context: BootstrapContext) => Promise<ApplicationRef>,
  selector: string,
  visitor: string | null,
): Promise<SecondRender> {
  try {
    return { html: await renderVisitor(bootstrap, selector, visitor) }
  } catch (error) {
    return { error }
  }
}

function assertVictimNotExposed(
  second: SecondRender,
  victimMarker: string,
): void {
  if (second.error !== undefined) {
    expect(second.error).toBeInstanceOf(Error)
    const message = (second.error as Error).message
    expect(message).toContain('QueryClient')
    expect(message.toLowerCase()).toContain('server')
    return
  }
  expect(second.html).not.toContain(victimMarker)
}

describe('Angular server rendering does not share a QueryClient across visitors', () => {
  beforeEach(() => {
    // Node SSR: `window` is absent, so query-core's server flag is set
    // (gcTime defaults to Infinity and queries are not retried).
    if (typeof window !== 'undefined' || isServer !== true) {
      throw new Error(
        'SSR isolation tests must run in Node, where query-core isServer is true',
      )
    }
    fetches.length = 0
  })

  it('does not render a fresh current-user query from an earlier request (provideTanStackQuery)', async () => {
    const bootstrap = serverBootstrap(ProfileComponent, [
      provideTanStackQuery(new QueryClient()),
      { provide: STALE_TIME, useValue: 60_000 },
    ])

    await renderVisitor(bootstrap, 'app-profile', VICTIM)
    expect(fetches).toContain(VICTIM)

    const second = await renderSecond(bootstrap, 'app-profile', OTHER)
    assertVictimNotExposed(second, 'profile:visitor-a')
  })

  it('does not keep an earlier profile when the later visitor refetch fails (provideTanStackQuery)', async () => {
    const bootstrap = serverBootstrap(ProfileComponent, [
      provideTanStackQuery(new QueryClient()),
    ])

    await renderVisitor(bootstrap, 'app-profile', VICTIM)
    expect(fetches).toContain(VICTIM)

    const second = await renderSecond(bootstrap, 'app-profile', null)
    expect(fetches.filter((visitor) => visitor === 'anonymous')).toHaveLength(1)
    assertVictimNotExposed(second, 'profile:visitor-a')
  })

  it('does not render a fresh current-user query from an earlier request (provideQueryClient)', async () => {
    const bootstrap = serverBootstrap(ProfileComponent, [
      provideQueryClient(
        new QueryClient({
          defaultOptions: { queries: { staleTime: 60_000 } },
        }),
      ),
    ])

    await renderVisitor(bootstrap, 'app-profile', VICTIM)
    expect(fetches).toContain(VICTIM)

    const second = await renderSecond(bootstrap, 'app-profile', OTHER)
    assertVictimNotExposed(second, 'profile:visitor-a')
  })

  it('does not render a fresh current-user query from an earlier request (provideAngularQuery)', async () => {
    const bootstrap = serverBootstrap(ProfileComponent, [
      provideAngularQuery(new QueryClient()),
      { provide: STALE_TIME, useValue: 60_000 },
    ])

    await renderVisitor(bootstrap, 'app-profile', VICTIM)
    expect(fetches).toContain(VICTIM)

    const second = await renderSecond(bootstrap, 'app-profile', OTHER)
    assertVictimNotExposed(second, 'profile:visitor-a')
  })

  it('does not render a fresh current-user query when an InjectionToken always returns the same QueryClient', async () => {
    const shared = new QueryClient()
    const token = new InjectionToken<QueryClient>('SHARED_QUERY_CLIENT', {
      factory: () => shared,
    })
    const bootstrap = serverBootstrap(ProfileComponent, [
      provideTanStackQuery(token),
      { provide: STALE_TIME, useValue: 60_000 },
    ])

    await renderVisitor(bootstrap, 'app-profile', VICTIM)
    expect(fetches).toContain(VICTIM)

    const second = await renderSecond(bootstrap, 'app-profile', OTHER)
    assertVictimNotExposed(second, 'profile:visitor-a')
  })

  it('does not render another visitor orders from a fresh infinite query', async () => {
    const bootstrap = serverBootstrap(OrdersComponent, [
      provideTanStackQuery(new QueryClient()),
      { provide: STALE_TIME, useValue: 60_000 },
    ])

    await renderVisitor(bootstrap, 'app-orders', VICTIM)
    expect(fetches).toContain(VICTIM)

    const second = await renderSecond(bootstrap, 'app-orders', OTHER)
    assertVictimNotExposed(second, 'orders:visitor-a')
  })

  it('does not render another visitor from injectQueries when the shared entry is fresh', async () => {
    const bootstrap = serverBootstrap(QueryListComponent, [
      provideTanStackQuery(new QueryClient()),
      { provide: STALE_TIME, useValue: 60_000 },
    ])

    await renderVisitor(bootstrap, 'app-query-list', VICTIM)
    expect(fetches).toContain(VICTIM)

    const second = await renderSecond(bootstrap, 'app-query-list', OTHER)
    assertVictimNotExposed(second, 'profile:visitor-a')
  })

  it('keeps visitors isolated when an InjectionToken factory constructs a new QueryClient', async () => {
    const token = new InjectionToken<QueryClient>('PER_REQUEST_QUERY_CLIENT', {
      factory: () =>
        new QueryClient({
          defaultOptions: { queries: { staleTime: 60_000 } },
        }),
    })
    const bootstrap = serverBootstrap(ProfileComponent, [
      provideTanStackQuery(token),
    ])

    await renderVisitor(bootstrap, 'app-profile', VICTIM)
    expect(fetches).toContain(VICTIM)

    const second = await renderVisitor(bootstrap, 'app-profile', OTHER)
    expect(second).not.toContain('profile:visitor-a')
  })
})
