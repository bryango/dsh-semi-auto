import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

interface ModeProps {
  loadMode(): Promise<boolean>
  setMode(enabled: boolean): Promise<boolean>
}

interface Registration {
  name: string
  id: string
  inject(): ModeProps
}

async function mountClient() {
  let plugin: { apply(ctx: unknown): void } | undefined
  const register = vi.fn((_options: Registration, _component?: unknown) => () => {})
  const inject = vi.fn((_name: string, setup: () => unknown) => setup())
  const call = vi.fn(async (_channel: string, _method: string, _payload: unknown) => ({
    ok: true, value: { enabled: true },
  }))
  const require = vi.fn((name: string) => {
    expect(name).toBe('react')
    // Registration-only test: no React component or DOM is rendered here.
    return {}
  })
  const load = vi.fn((module: { id: string; factory(require: unknown): typeof plugin }) => {
    expect(module.id).toBe('dsh-semi-auto')
    plugin = module.factory(require)
  })
  runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load } },
  })
  expect(load).toHaveBeenCalledOnce()
  plugin!.apply({
    get: () => ({ rpc: { call } }),
    effect: (setup: () => unknown) => setup(),
    locale: { register: vi.fn(() => () => {}) },
    slots: { inject, register },
  })
  return { register, inject, call }
}

describe('composer client registration', () => {
  it('passes the toggle component to register, not to inject', async () => {
    const { register, inject } = await mountClient()
    expect(inject).toHaveBeenCalledWith('conversation.input.left', expect.any(Function))
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'conversation.input.left', id: 'semi-auto-toggle',
    }), expect.any(Function))
  })

  it('connects the registered props to the mode get/set endpoints', async () => {
    const { register, call } = await mountClient()
    const props = register.mock.calls[0]![0].inject()
    await expect(props.loadMode()).resolves.toBe(true)
    expect(call).toHaveBeenLastCalledWith('/api', 'semi-auto.get', {})
    call.mockResolvedValueOnce({ ok: true, value: { enabled: false } })
    await expect(props.setMode(false)).resolves.toBe(false)
    expect(call).toHaveBeenLastCalledWith('/api', 'semi-auto.set', { enabled: false })
  })
})
