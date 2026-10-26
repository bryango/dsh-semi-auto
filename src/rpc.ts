/**
 * The `/api` RPC endpoints the composer toggle calls to read and flip the mode.
 * Mounted as exact POST Fetch routes on the shared `/api` channel
 * (`/api/semi-auto.<endpoint>`) when a host `connection` service exists; the
 * web browser reaches them through `rpc.call('/api', 'semi-auto.<endpoint>', payload)`.
 */
import type { Context } from '@deepseek-ai/cordis'

/** Endpoint-name prefix under the shared `/api` channel. */
export const SEMI_AUTO_PREFIX = 'semi-auto.'

/** Every endpoint this module answers; keeps the route table and the switch together. */
export const SEMI_AUTO_ENDPOINTS = ['get', 'set'] as const

export type SemiAutoEndpoint = (typeof SEMI_AUTO_ENDPOINTS)[number]

/** Wire result of every endpoint: success value or a business error branch. */
export type RpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** The connection service face this module needs (structural; no runtime import). */
interface ConnectionLike {
  fetch: { register: (route: FetchRoute) => () => Promise<void> }
}

interface FetchRoute {
  path: string
  methods: string[]
  requestBody: 'buffered'
  fetch: (request: Request) => Promise<Response>
}

/** Business error carried back to the browser as a `bad-request` branch. */
export class BadRequest extends Error {}

/** Read and flip the mode behind the endpoints; implemented by the plugin's apply closure. */
export interface ModeRpc {
  getEnabled(): boolean
  /** Flips the mode immediately; the returned promise settles with persistence. */
  setEnabled(enabled: boolean): void | Promise<void>
}

/** Connection `client-request` envelope, as the browser rpc caller sends it. */
interface ClientRequestEnvelope {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

function readEnvelope(body: unknown): ClientRequestEnvelope | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  if (record.type !== 'client-request' || typeof record.rpcId !== 'string' || typeof record.method !== 'string') {
    return undefined
  }
  return { type: 'client-request', rpcId: record.rpcId, method: record.method, payload: record.payload }
}

function serverResponse(rpcId: string, result: RpcResult): Response {
  return Response.json({ type: 'server-response', rpcId, result })
}

/** Validate the `set` endpoint's payload; the mode is strictly boolean. */
export function readEnabled(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) throw new BadRequest('payload must be an object')
  const enabled = (payload as Record<string, unknown>).enabled
  if (typeof enabled !== 'boolean') throw new BadRequest('payload.enabled must be a boolean')
  return enabled
}

/**
 * Answer one endpoint against the plugin's mode. Exported so tests drive the
 * same dispatcher the wire route runs.
 */
export async function dispatchMode(rpc: ModeRpc, endpoint: SemiAutoEndpoint, payload: unknown): Promise<RpcResult> {
  switch (endpoint) {
    case 'get':
      return { ok: true, value: { enabled: rpc.getEnabled() } }
    case 'set': {
      const enabled = readEnabled(payload)
      await rpc.setEnabled(enabled)
      return { ok: true, value: { enabled: rpc.getEnabled() } }
    }
  }
}

function failure(error: unknown): RpcResult {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof BadRequest) {
    return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
  }
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

/**
 * Wrap one endpoint as an exact Fetch route: decode the `client-request`
 * envelope the browser rpc caller posts and answer with the matching
 * `server-response` envelope.
 */
export function fetchRouteFor(endpoint: SemiAutoEndpoint, rpc: ModeRpc): FetchRoute {
  const method = `${SEMI_AUTO_PREFIX}${endpoint}`
  return {
    path: `/api/${method}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const envelope = readEnvelope(body)
      if (envelope === undefined) {
        const rawId = (body as Record<string, unknown> | null)?.rpcId
        return serverResponse(typeof rawId === 'string' ? rawId : 'invalid-request', {
          ok: false,
          error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } },
        })
      }
      if (envelope.method !== method) {
        return serverResponse(envelope.rpcId, {
          ok: false,
          error: {
            code: 'gateway/bad-request',
            message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(method)}`,
            details: { issues: [] },
          },
        })
      }
      return serverResponse(envelope.rpcId, await dispatchMode(rpc, endpoint, envelope.payload).catch(failure))
    },
  }
}
/**
 * Register the `/api` routes when a host connection exists. `connection` is
 * not in the plugin's inject list (headless compositions lack it), so its
 * startup order is unconstrained: defer registration until the service exists.
 */
export function registerModeRpc(ctx: Context, rpc: ModeRpc): void {
  ctx.inject(['connection'], scope => {
    const connection = scope.get('connection') as ConnectionLike
    for (const endpoint of SEMI_AUTO_ENDPOINTS) {
      scope.effect(
        () => connection.fetch.register(fetchRouteFor(endpoint, rpc)),
        `dsh-semi-auto: /api/${SEMI_AUTO_PREFIX}${endpoint} route`,
      )
    }
  })
}
