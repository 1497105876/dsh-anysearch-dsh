/** Register AnySearch as a native Provider and model-facing advanced tools. */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import {
  applyWebFetchTool,
  DEFAULT_FETCH_MAX_OUTPUT_CHARS,
  DEFAULT_WEB_TOOL_TIMEOUT_MS,
} from '@deepseek-ai/dsh-tool-web'
import type {} from '@deepseek-ai/dsh-web'
import z from '@deepseek-ai/schemastery'
import {
  ANYSEARCH_DEFAULT_BASE_URL,
  AnySearchClient,
} from './client.ts'
import { AnySearchProvider } from './provider.ts'
import { AnySearchFetchProvider } from './fetch-provider.ts'
import { registerCapabilitiesTool } from './tools/capabilities.ts'
import { DEFAULT_MAX_BATCH_SEARCH_ITEMS, registerBatchSearchTool } from './tools/batch.ts'
import {
  DEFAULT_MAX_RENDERED_CONTENT_CHARS,
  registerAdvancedSearchTool,
} from './tools/search.ts'

export {
  ANYSEARCH_DEFAULT_BASE_URL,
  AnySearchClient,
  AnySearchClientError,
} from './client.ts'
export {
  ANYSEARCH_DSH_CLIENT_ID,
  ANYSEARCH_DSH_VERSION,
} from './version.ts'
export type {
  AnySearchClientOptions,
  AnySearchOperation,
} from './client.ts'
export {
  ANYSEARCH_PROVIDER_ID,
  AnySearchProvider,
  mapAnySearchResponse,
  mapAnySearchResult,
} from './provider.ts'
export {
  ANYSEARCH_FETCH_PROVIDER_ID,
  AnySearchFetchProvider,
  mapAnySearchExtractResponse,
} from './fetch-provider.ts'
export {
  ANYSEARCH_BATCH_SEARCH_TOOL_NAME,
  executeBatchSearch,
  formatBatchSearchOutput,
  parseBatchSearchItems,
  registerBatchSearchTool,
} from './tools/batch.ts'
export type {
  AnySearchBatchFailure,
  AnySearchBatchItem,
  AnySearchBatchOutput,
  AnySearchBatchSuccess,
} from './tools/batch.ts'
export {
  ANYSEARCH_CAPABILITIES_TOOL_NAME,
  formatDomains,
  formatSubDomains,
  parseCapabilityDomains,
  registerCapabilitiesTool,
} from './tools/capabilities.ts'
export {
  ANYSEARCH_SEARCH_TOOL_NAME,
  DEFAULT_MAX_RENDERED_CONTENT_CHARS,
  formatAdvancedSearchOutput,
  parseAdvancedSearchArgs,
  registerAdvancedSearchTool,
} from './tools/search.ts'
export type {
  AnySearchDomainCapability,
  AnySearchDomainsResponse,
  AnySearchDomainSummary,
  AnySearchExtractRequest,
  AnySearchExtractResponse,
  AnySearchMetadata,
  AnySearchParamInfo,
  AnySearchParamValue,
  AnySearchResult,
  AnySearchSearchRequest,
  AnySearchSearchResponse,
  AnySearchSubDomain,
  AnySearchSubDomainsResponse,
} from './types.ts'

/** Cordis plugin name used in loader diagnostics. */
export const name = 'web-search-anysearch'

/** Capability seams required by the Providers and model-facing tools. */
export const inject = ['web', 'credentials', 'systemPrompt', 'tools']

/** Route prefix serving the settings panel's read/write calls (same-origin, no CORS). */
const CONFIG_ROUTE_PREFIX = '/gw-anysearch-dsh'

/** Hard upper bound shared by the schema and the settings route validation. */
const MAX_BATCH_SEARCHES_LIMIT = 20

/** Narrow shape of the host configEditor service used to persist panel edits. */
interface ConfigEditorEntry {
  options: { id?: unknown }
}
interface ConfigEditorService {
  entries(): ConfigEditorEntry[]
  edit(
    entry: ConfigEditorEntry,
    change: (
      current: Record<string, unknown>,
      inherited: Record<string, unknown>,
    ) => Record<string, unknown>,
  ): Promise<void>
}

/** Minimal webServer surface used for the settings data route. */
interface WebServerRouteHandlerRequest {
  method?: string
  url?: string
  on(event: 'data', listener: (chunk: unknown) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
}
interface WebServerRouteHandlerResponse {
  statusCode: number
  setHeader(name: string, value: string): unknown
  end(body?: string): unknown
}
interface WebServerRouteRegistrar {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (
      req: WebServerRouteHandlerRequest,
      res: WebServerRouteHandlerResponse,
    ) => Promise<void> | void
  }): unknown
}

/** Write one JSON response and close it. */
function respondJson(res: WebServerRouteHandlerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/** Read and parse one JSON request body; empty bodies resolve to undefined. */
function readJsonBody(req: WebServerRouteHandlerRequest): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    let text = ''
    req.on('data', chunk => {
      text += typeof chunk === 'string' ? chunk : String(chunk)
    })
    req.on('end', () => {
      if (text.length === 0) {
        resolvePromise(undefined)
        return
      }
      try {
        resolvePromise(JSON.parse(text))
      } catch (error) {
        rejectPromise(error)
      }
    })
    req.on('error', rejectPromise)
  })
}

/** Validate one client-supplied batch limit against the shared hard bound. */
function parseBatchLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_BATCH_SEARCHES_LIMIT) {
    return undefined
  }
  return value
}

/**
 * Install the settings-panel data route. GET returns the active value; POST
 * persists through the host configEditor service, whose patch reconciliation
 * hot-reloads this plugin so the next GET already observes the new value.
 */
function registerConfigRoute(ctx: Context, resolved: ResolvedConfig): void {
  // webServer is optional on purpose: headless profiles never mount it, and
  // declaring it in `inject` would fail the whole plugin there. The dynamic
  // get() mirrors how the host exposes optional services.
  const webServer = (ctx as unknown as { get?(name: string): unknown }).get?.('webServer') as WebServerRouteRegistrar | undefined
  if (webServer === undefined || typeof webServer.register !== 'function') return

  const disposer = webServer.register({
    kind: 'prefix',
    path: CONFIG_ROUTE_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname.slice(CONFIG_ROUTE_PREFIX.length) || '/'
      if (req.method === 'GET' && (path === '/config' || path === '/')) {
        respondJson(res, 200, { maxBatchSearches: resolved.maxBatchSearches })
        return
      }
      if (req.method === 'POST' && path === '/config') {
        const body = await readJsonBody(req).catch(() => undefined)
        const value = parseBatchLimit((body as { maxBatchSearches?: unknown } | undefined)?.maxBatchSearches)
        if (value === undefined) {
          respondJson(res, 400, { error: 'maxBatchSearches must be an integer from 1 to 20' })
          return
        }
        const editor = (ctx as unknown as { get?(name: string): unknown }).get?.('configEditor') as ConfigEditorService | undefined
        if (editor === undefined) {
          respondJson(res, 503, { error: 'configEditor service is not available in this profile' })
          return
        }
        const entry = editor.entries().find(candidate => candidate.options.id === name)
        if (entry === undefined) {
          respondJson(res, 404, { error: `${name} entry not found in this profile` })
          return
        }
        await editor.edit(entry, (current, inherited) => ({ ...inherited, ...current, maxBatchSearches: value }))
        respondJson(res, 200, { maxBatchSearches: value })
        return
      }
      respondJson(res, 404, { error: 'not found' })
    },
  })
  // The installer is a function-declared apply, so cordis constructs it with
  // `new` and discards return values; register the disposer through ctx.effect.
  ctx.effect(() => () => {
    if (typeof disposer === 'function') disposer()
    else if ((disposer as { dispose?: () => void })?.dispose !== undefined) (disposer as { dispose: () => void }).dispose()
  }, 'gw-anysearch-dsh: settings data route')
}

const DEFAULT_API_KEY_ENV = 'ANYSEARCH_API_KEY'

/** AnySearch plugin configuration. */
export interface Config {
  /** Credential reference resolved for each operation. Missing values use anonymous access. */
  apiKeyEnv?: string
  /** API base URL. Defaults to the public AnySearch API. */
  baseURL?: string
  /** Aggregate cleaned-content characters rendered to the model by one advanced tool operation. */
  maxRenderedContentChars?: number
  /** Maximum independent searches accepted by one batch operation. Defaults to 5. */
  maxBatchSearches?: number
}

/** Fully validated configuration consumed by the plugin runtime. */
export interface ResolvedConfig {
  /** Non-empty credential reference resolved for every operation. */
  apiKeyEnv: string
  /** Absolute HTTP or HTTPS API base URL. */
  baseURL: string
  /** Aggregate cleaned-content characters rendered by one tool operation. */
  maxRenderedContentChars: number
  /** Maximum independent searches accepted by one batch operation. */
  maxBatchSearches: number
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  maxRenderedContentChars: z.number().step(1).min(1).default(DEFAULT_MAX_RENDERED_CONTENT_CHARS),
  maxBatchSearches: z.number().step(1).min(1).max(MAX_BATCH_SEARCHES_LIMIT).default(DEFAULT_MAX_BATCH_SEARCH_ITEMS),
})

/** Resolve defaults and reject self-contained configuration errors before registration. */
export function resolveConfig(config: Config): ResolvedConfig {
  const apiKeyEnv = (config.apiKeyEnv ?? DEFAULT_API_KEY_ENV).trim()
  if (apiKeyEnv.length === 0) throw new Error('apiKeyEnv must be a non-empty credential reference')

  const baseURL = (config.baseURL ?? ANYSEARCH_DEFAULT_BASE_URL).trim()
  let parsedURL: URL
  try {
    parsedURL = new URL(baseURL)
  } catch {
    throw new Error('baseURL must be an absolute URL')
  }
  if (parsedURL.protocol !== 'http:' && parsedURL.protocol !== 'https:') {
    throw new Error('baseURL must use HTTP or HTTPS')
  }
  if (parsedURL.username.length > 0 || parsedURL.password.length > 0) {
    throw new Error('baseURL must not contain credentials')
  }

  const maxRenderedContentChars = config.maxRenderedContentChars ?? DEFAULT_MAX_RENDERED_CONTENT_CHARS
  if (!Number.isSafeInteger(maxRenderedContentChars) || maxRenderedContentChars < 1) {
    throw new Error('maxRenderedContentChars must be a positive integer')
  }
  const maxBatchSearches = config.maxBatchSearches ?? DEFAULT_MAX_BATCH_SEARCH_ITEMS
  if (!Number.isSafeInteger(maxBatchSearches) || maxBatchSearches < 1 || maxBatchSearches > MAX_BATCH_SEARCHES_LIMIT) {
    throw new Error(`maxBatchSearches must be an integer from 1 to ${MAX_BATCH_SEARCHES_LIMIT}`)
  }
  return { apiKeyEnv, baseURL, maxRenderedContentChars, maxBatchSearches }
}

/** Register the AnySearch Provider and advanced tools with their owning services. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const apiKeyEnv = credentialRef(resolved.apiKeyEnv)
  const client = new AnySearchClient({
    resolveApiKey: async () => (await ctx.credentials.resolve(apiKeyEnv))?.value,
    apiKeyReference: resolved.apiKeyEnv,
    baseURL: resolved.baseURL,
  })
  ctx.web.registerSearchProvider(new AnySearchProvider(client))
  ctx.web.registerFetchProvider(new AnySearchFetchProvider(client))
  if (ctx.tools.get('web_fetch') === undefined) {
    applyWebFetchTool(ctx, DEFAULT_WEB_TOOL_TIMEOUT_MS, DEFAULT_FETCH_MAX_OUTPUT_CHARS)
  }
  registerCapabilitiesTool(ctx, client)
  registerBatchSearchTool(ctx, client, resolved.maxRenderedContentChars, resolved.maxBatchSearches)
  registerAdvancedSearchTool(
    ctx,
    client,
    resolved.maxRenderedContentChars,
  )
  registerConfigRoute(ctx, resolved)
}
