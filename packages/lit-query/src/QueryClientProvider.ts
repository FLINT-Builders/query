import { ContextProvider } from '@lit/context'
import type { QueryClient } from '@tanstack/query-core'
import type { TemplateResult } from 'lit'
import { LitElement, html } from 'lit'
import {
  createMissingQueryClientError,
  queryClientContext,
  registerDefaultQueryClient,
  unregisterDefaultQueryClient,
} from './context.js'

/**
 * Lit element that provides a `QueryClient` to descendant Lit Query
 * controllers through Lit context.
 *
 * The `client` is a property, not an attribute. When rendering this element in
 * a Lit template, bind it with property binding: `.client=${queryClient}`.
 * The provider throws if it connects without a client, or if an already
 * connected provider has its client cleared.
 *
 * This class is not registered as a custom element by the package. Applications
 * must register either a subclass or the class itself with
 * `customElements.define`.
 *
 * @example
 * ```ts
 * import { html, LitElement } from 'lit'
 * import { QueryClient, QueryClientProvider } from '@tanstack/lit-query'
 *
 * const queryClient = new QueryClient()
 *
 * class AppQueryProvider extends QueryClientProvider {
 *   constructor() {
 *     super()
 *     this.client = queryClient
 *   }
 * }
 *
 * customElements.define('app-query-provider', AppQueryProvider)
 *
 * class AppRoot extends LitElement {
 *   render() {
 *     return html`<app-query-provider><todos-view></todos-view></app-query-provider>`
 *   }
 * }
 * ```
 *
 * @example
 * ```ts
 * import { html } from 'lit'
 * import { QueryClient, QueryClientProvider } from '@tanstack/lit-query'
 *
 * const queryClient = new QueryClient()
 *
 * customElements.define('query-client-provider', QueryClientProvider)
 *
 * const view = html`
 *   <query-client-provider .client=${queryClient}>
 *     <todos-view></todos-view>
 *   </query-client-provider>
 * `
 * ```
 */
export class QueryClientProvider extends LitElement {
  /** @internal */
  static properties = {
    client: { attribute: false },
  }

  /**
   * The `QueryClient` provided to descendant controllers and global fallback
   * helpers while this provider is connected.
   *
   * During server rendering the provider is not attached to a document, so the
   * client is not registered for the global fallback helpers.
   *
   * Bind this as a property in Lit templates with `.client=${queryClient}`.
   */
  declare client: QueryClient

  private readonly contextProvider: ContextProvider<typeof queryClientContext>

  private mountedClient: QueryClient | undefined

  private registeredClient: QueryClient | undefined

  constructor() {
    super()
    this.contextProvider = new ContextProvider(this, {
      context: queryClientContext,
    })
  }

  /** @internal */
  connectedCallback(): void {
    super.connectedCallback()
    const client = this.requireClient()
    this.contextProvider.setValue(client)
    this.mountClient(client)
  }

  /** @internal */
  disconnectedCallback(): void {
    this.unmountClient(this.mountedClient)
    super.disconnectedCallback()
  }

  /** @internal */
  protected willUpdate(changedProperties: Map<PropertyKey, unknown>): void {
    if (!changedProperties.has('client')) {
      return
    }

    const nextClient = this.client
    if (!nextClient) {
      if (this.isConnected) {
        this.unmountClient(this.mountedClient)
        // Sentinel: notify active consumers that the provider is now unbound.
        this.contextProvider.setValue(undefined as unknown as QueryClient)
        throw createMissingQueryClientError()
      }

      return
    }

    const previousClient = changedProperties.get('client') as
      | QueryClient
      | undefined
    if (previousClient && previousClient !== nextClient && this.isConnected) {
      this.unmountClient(previousClient)
    }

    this.contextProvider.setValue(nextClient)

    if (this.isConnected) {
      this.mountClient(nextClient)
    }
  }

  /** @internal */
  render(): TemplateResult {
    return html`<slot></slot>`
  }

  private mountClient(client: QueryClient): void {
    if (this.mountedClient === client) {
      return
    }

    if (this.mountedClient) {
      this.unmountClient(this.mountedClient)
    }

    client.mount()
    // The default client registry is process-wide. Server renderers such as
    // Lit SSR call `connectedCallback` on elements that are not attached to a
    // document, and one process serves many requests, so only a provider in a
    // live document may register its client there.
    if (this.isConnected) {
      registerDefaultQueryClient(client)
      this.registeredClient = client
    }
    this.mountedClient = client
  }

  private unmountClient(client?: QueryClient): void {
    if (!client) {
      return
    }

    client.unmount()
    if (this.registeredClient === client) {
      unregisterDefaultQueryClient(client)
      this.registeredClient = undefined
    }

    if (this.mountedClient === client) {
      this.mountedClient = undefined
    }
  }

  private requireClient(): QueryClient {
    if (!this.client) {
      throw createMissingQueryClientError()
    }

    return this.client
  }
}
