import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readModeFileSync, writeModeFile } from '../src/mode.js'
import { BadRequest, dispatchMode, fetchRouteFor, readEnabled, type ModeRpc } from '../src/rpc.js'

const homes: string[] = []

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), 'semi-auto-mode-'))
  homes.push(home)
  process.env.DSH_HOME = home
})

afterEach(async () => {
  delete process.env.DSH_HOME
  while (homes.length) await rm(homes.pop()!, { recursive: true, force: true })
})

function rpc(state: { enabled: boolean }): ModeRpc {
  return { getEnabled: () => state.enabled, setEnabled: value => { state.enabled = value } }
}

describe('durable mode state', () => {
  it('defaults to enabled when no state file exists', () => {
    expect(readModeFileSync()).toBe(true)
  })

  it('persists a flip and reads it back', async () => {
    await writeModeFile(false)
    expect(readModeFileSync()).toBe(false)
    await writeModeFile(true)
    expect(readModeFileSync()).toBe(true)
  })

  it('defaults to enabled on a corrupt state file instead of failing activation', async () => {
    await writeModeFile(false)
    await writeFile(join(process.env.DSH_HOME!, 'plugins', 'semi-auto', 'mode.json'), 'not json', 'utf8')
    expect(readModeFileSync()).toBe(true)
  })
})

describe('mode RPC dispatcher', () => {
  it('reports the current mode for get', async () => {
    const state = { enabled: false }
    await expect(dispatchMode(rpc(state), 'get', {})).resolves.toEqual({ ok: true, value: { enabled: false } })
  })

  it('flips the mode for a boolean set', async () => {
    const state = { enabled: true }
    const store = rpc(state)
    await expect(dispatchMode(store, 'set', { enabled: false })).resolves.toEqual({ ok: true, value: { enabled: false } })
    expect(store.getEnabled()).toBe(false)
  })

  it.each([[undefined], ['yes'], [1], [{}]])('rejects a non-boolean set payload of %j', async payload => {
    const store = rpc({ enabled: true })
    await expect(dispatchMode(store, 'set', payload)).rejects.toBeInstanceOf(BadRequest)
    expect(store.getEnabled()).toBe(true)
  })

  it('keeps get independent of the payload', async () => {
    const store = rpc({ enabled: true })
    await expect(dispatchMode(store, 'get', { enabled: false })).resolves.toEqual({ ok: true, value: { enabled: true } })
  })

  it('validates the set payload strictly', () => {
    expect(() => readEnabled({ enabled: false })).not.toThrow()
    expect(() => readEnabled('false')).toThrow(BadRequest)
    expect(() => readEnabled({})).toThrow(BadRequest)
  })
})

interface Envelope { type: string; rpcId: string; result: { ok: boolean; value?: unknown; error?: { code: string; message: string } } }

async function readEnvelope(response: Response): Promise<Envelope> {
  return await response.json() as Envelope
}

describe('mode RPC fetch route', () => {
  const route = (store: { enabled: boolean }) => fetchRouteFor('set', rpc(store))

  async function post(route: ReturnType<typeof fetchRouteFor>, body: unknown): Promise<Response> {
    return route.fetch(new Request('http://host/api/semi-auto.set', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))
  }

  it('answers a client-request envelope with the matching server-response', async () => {
    const state = { enabled: true }
    const response = await post(route(state), {
      type: 'client-request', rpcId: 'r-1', method: 'semi-auto.set', payload: { enabled: false },
    })
    expect(response.status).toBe(200)
    await expect(readEnvelope(response)).resolves.toEqual({
      type: 'server-response', rpcId: 'r-1', result: { ok: true, value: { enabled: false } },
    })
    expect(state.enabled).toBe(false)
  })

  it('answers a method mismatch with a bad-request branch', async () => {
    const response = await post(route({ enabled: true }), {
      type: 'client-request', rpcId: 'r-2', method: 'semi-auto.other', payload: {},
    })
    const body = await readEnvelope(response)
    expect(body.rpcId).toBe('r-2')
    expect(body.result.ok).toBe(false)
    expect(body.result.error?.code).toBe('gateway/bad-request')
  })

  it('answers a malformed body without throwing', async () => {
    const response = await post(route({ enabled: true }), { rpcId: 'r-3' })
    const body = await readEnvelope(response)
    expect(body.rpcId).toBe('r-3')
    expect(body.result.ok).toBe(false)
  })

  it('rejects a non-JSON content type with 415', async () => {
    const response = await route({ enabled: true }).fetch(new Request('http://host/api/semi-auto.set', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x',
    }))
    expect(response.status).toBe(415)
  })

  it('maps a dispatcher failure to an internal branch', async () => {
    const response = await post(route({ enabled: true }), {
      type: 'client-request', rpcId: 'r-4', method: 'semi-auto.set', payload: { enabled: 'nope' },
    })
    const body = await readEnvelope(response)
    expect(body.result.ok).toBe(false)
    expect(body.result.error?.code).toBe('bad-request')
  })

  it('writes the state file the plugin reads at activation', async () => {
    await writeModeFile(false)
    const file = join(process.env.DSH_HOME!, 'plugins', 'semi-auto', 'mode.json')
    await expect(readFile(file, 'utf8')).resolves.toBe('{"enabled":false}\n')
  })
})
