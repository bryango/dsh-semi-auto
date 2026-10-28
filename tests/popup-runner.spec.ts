import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { runPopup, type PopupRunnerConfig } from '../src/popup-runner.js'
import type { PopupRequest } from '../src/popup-protocol.js'

const request: PopupRequest = { sessionId: 'session-1', cwd: '/workspace', toolName: 'bash', args: { command: 'pwd' } }
const config: PopupRunnerConfig = { binaryPath: '/trusted/permission-popup', timeoutMs: 600_000, graceMs: 1_000, outputLimitBytes: 16_384 }
const allow = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })

function fixture(options: {
  output?: string
  lossy?: boolean
  outcome?: SubprocessOutcome
  done?: Promise<SubprocessOutcome>
  wait?: () => Promise<boolean>
  noStdout?: boolean
} = {}) {
  const text = options.output ?? allow
  const readFrom = vi.fn(() => ({ text, nextOffset: Buffer.byteLength(text), lossy: options.lossy ?? false }))
  const terminate = vi.fn()
  const waitForExit = vi.fn(options.wait ?? (async () => true))
  const handle: SubprocessHandle = {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: options.noStdout ? {} : { stdout: { readFrom }, stderr: { readFrom } },
    done: options.done ?? Promise.resolve(options.outcome ?? { exitCode: 0, signal: null }),
    terminate, waitForExit,
  }
  const resolveExecutable = vi.fn(async (path: string) => path)
  const spawn = vi.fn((_spec: SubprocessSpawnSpec) => handle)
  const runtime: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'> = { resolveExecutable, spawn }
  return { runtime, handle, resolveExecutable, spawn, terminate, waitForExit, readFrom }
}

afterEach(() => { vi.useRealTimers() })

describe('trusted native popup runner', () => {
  it('uses direct argv, exact stdin, bounded collection and the session cwd', async () => {
    const f = fixture()
    const signal = new AbortController().signal
    expect(await runPopup(f.runtime, request, config, signal)).toEqual({ kind: 'allow' })
    expect(f.resolveExecutable).toHaveBeenCalledWith(config.binaryPath, undefined, expect.any(AbortSignal))
    expect(f.spawn).toHaveBeenCalledWith({
      argv: [config.binaryPath, '--host', 'dsh'], cwd: request.cwd, graceMs: config.graceMs,
      signal: expect.any(AbortSignal),
      stdio: {
        stdin: { data: `${JSON.stringify({
          session_id: 'session-1', transcript_path: '', cwd: '/workspace', permission_mode: 'auto',
          hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'pwd' }, permission_suggestions: [],
        })}\n` },
        stdout: { maxBytes: config.outputLimitBytes }, stderr: { maxBytes: config.outputLimitBytes },
      },
    })
    expect(f.readFrom).toHaveBeenCalledWith(0)
    expect(f.terminate).toHaveBeenCalledOnce()
    expect(f.waitForExit).toHaveBeenCalledOnce()
    expect(f.spawn.mock.calls[0]?.[0]).not.toHaveProperty('env')
  })

  it('rejects the removed allow_direct response', async () => {
    const f = fixture({ output: allow.replace('"allow"', '"allow_direct"') })
    expect(await runPopup(f.runtime, request, config, new AbortController().signal)).toEqual({ kind: 'deny', reason: expect.any(String) })
  })

  it('preserves no decision only after a successful empty helper exit and cleanup', async () => {
    const f = fixture({ output: '' })
    expect(await runPopup(f.runtime, request, config, new AbortController().signal)).toEqual({ kind: 'no_decision' })
    expect(f.terminate).toHaveBeenCalledOnce()
    expect(f.waitForExit).toHaveBeenCalledOnce()
  })

  it.each([
    { output: ' \t\r\n' }, { output: '{}' }, { output: 'garbage' }, { lossy: true }, { noStdout: true },
    { output: '', outcome: { exitCode: 1, signal: null } },
    { output: '', outcome: { exitCode: null, signal: 'SIGTERM' as const } },
    { output: '', lossy: true },
    { outcome: { exitCode: 1, signal: null } }, { outcome: { exitCode: null, signal: 'SIGTERM' as const } },
    { outcome: { exitCode: 0, signal: 'SIGTERM' as const } },
    { output: `${allow}${' '.repeat(config.outputLimitBytes)}` },
  ])('denies unsuccessful, malformed or incomplete output', async options => {
    const f = fixture(options)
    expect((await runPopup(f.runtime, request, config, new AbortController().signal)).kind).toBe('deny')
    expect(f.waitForExit).toHaveBeenCalledOnce()
  })

  it('denies invalid request data before resolving or spawning a process', async () => {
    const f = fixture()
    expect((await runPopup(f.runtime, { ...request, args: [] }, config, new AbortController().signal)).kind).toBe('deny')
    expect(f.resolveExecutable).not.toHaveBeenCalled()
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it.each([
    { ...config, binaryPath: 'permission-popup' }, { ...config, timeoutMs: 0 }, { ...config, timeoutMs: Infinity },
    { ...config, timeoutMs: 2_147_483_648 }, { ...config, graceMs: -1 }, { ...config, outputLimitBytes: 0 },
    { ...config, outputLimitBytes: 2.5 },
  ])('denies invalid runner configuration without spawning', async invalid => {
    const f = fixture()
    expect((await runPopup(f.runtime, request, invalid, new AbortController().signal)).kind).toBe('deny')
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('denies a relative session directory', async () => {
    const f = fixture()
    expect((await runPopup(f.runtime, { ...request, cwd: 'relative' }, config, new AbortController().signal)).kind).toBe('deny')
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('does not spawn after pre-cancellation', async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort()
    expect(await runPopup(f.runtime, request, config, controller.signal)).toEqual({ kind: 'deny', reason: expect.stringMatching(/cancelled/) })
    expect(f.resolveExecutable).not.toHaveBeenCalled()
  })

  it('denies executable lookup and synchronous spawn failures without leaking diagnostics', async () => {
    const f = fixture()
    f.resolveExecutable.mockRejectedValueOnce(new Error('SECRET diagnostic'))
    expect(await runPopup(f.runtime, request, config, new AbortController().signal)).toEqual({ kind: 'deny', reason: expect.not.stringContaining('SECRET') })
    f.spawn.mockImplementationOnce(() => { throw new Error('SECRET diagnostic') })
    expect(await runPopup(f.runtime, request, config, new AbortController().signal)).toEqual({ kind: 'deny', reason: expect.not.stringContaining('SECRET') })
  })

  it('drains after provider outcome rejection', async () => {
    const done = Promise.reject<SubprocessOutcome>(new Error('spawn error'))
    const f = fixture({ done })
    expect((await runPopup(f.runtime, request, config, new AbortController().signal)).kind).toBe('deny')
    expect(f.terminate).toHaveBeenCalledOnce()
    expect(f.waitForExit).toHaveBeenCalledOnce()
  })

  it.each([async () => false, async (): Promise<boolean> => { throw new Error('cannot observe process range') }])(
    'does not publish allow when process-range cleanup fails', async wait => {
      const f = fixture({ wait })
      expect((await runPopup(f.runtime, request, config, new AbortController().signal)).kind).toBe('deny')
    },
  )

  it.each([async () => false, async (): Promise<boolean> => { throw new Error('cannot observe process range') }])(
    'does not defer to Auto when an empty-response process cannot be drained', async wait => {
      const f = fixture({ output: '', wait })
      expect((await runPopup(f.runtime, request, config, new AbortController().signal)).kind).toBe('deny')
    },
  )

  it('does not defer to Auto when cancellation arrives during empty-response cleanup', async () => {
    const controller = new AbortController()
    const f = fixture({ output: '', wait: async () => { controller.abort(); return true } })
    expect(await runPopup(f.runtime, request, config, controller.signal)).toEqual({ kind: 'deny', reason: expect.stringMatching(/cancelled/) })
  })

  it('checks cancellation again after cleanup, even after a valid allow', async () => {
    const controller = new AbortController()
    const f = fixture({ wait: async () => { controller.abort(); return true } })
    expect(await runPopup(f.runtime, request, config, controller.signal)).toEqual({ kind: 'deny', reason: expect.stringMatching(/cancelled/) })
  })

  it('aborts a timed-out helper and waits for its managed range', async () => {
    vi.useFakeTimers()
    const done = Promise.withResolvers<SubprocessOutcome>()
    const f = fixture({ done: done.promise })
    f.spawn.mockImplementation(spec => {
      spec.signal?.addEventListener('abort', () => { done.resolve({ exitCode: null, signal: 'SIGTERM' }) }, { once: true })
      return f.handle
    })
    const pending = runPopup(f.runtime, request, config, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(config.timeoutMs)
    expect(await pending).toEqual({ kind: 'deny', reason: expect.stringMatching(/timed out/) })
    expect(f.terminate).toHaveBeenCalledOnce()
    expect(f.waitForExit).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels an active helper and drains without waiting for the deadline', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const done = Promise.withResolvers<SubprocessOutcome>()
    const f = fixture({ done: done.promise })
    f.spawn.mockImplementation(spec => {
      spec.signal?.addEventListener('abort', () => { done.resolve({ exitCode: null, signal: 'SIGTERM' }) }, { once: true })
      return f.handle
    })
    const pending = runPopup(f.runtime, request, config, controller.signal)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect(await pending).toEqual({ kind: 'deny', reason: expect.stringMatching(/cancelled/) })
    expect(f.waitForExit).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels executable lookup and does not spawn after it returns', async () => {
    const controller = new AbortController()
    const f = fixture()
    f.resolveExecutable.mockImplementationOnce(async path => { controller.abort(); return path })
    expect((await runPopup(f.runtime, request, config, controller.signal)).kind).toBe('deny')
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('clears its deadline after an ordinary response', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await runPopup(f.runtime, request, config, new AbortController().signal)
    expect(vi.getTimerCount()).toBe(0)
  })
})
