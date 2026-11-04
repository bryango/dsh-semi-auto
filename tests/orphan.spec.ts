import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, TOOL_RUNTIME_SCHEDULER, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as SemiAuto from '../src/index.js'
import { reviewTool } from '../src/auto-review.js'
import { runPopup } from '../src/popup-runner.js'

vi.mock('../src/auto-review.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/auto-review.js')>(), reviewTool: vi.fn(),
}))
vi.mock('../src/popup-runner.js', () => ({ runPopup: vi.fn() }))
const popup = vi.mocked(runPopup)
const reviewer = vi.mocked(reviewTool)
const contexts: Context[] = []
const modeHomes: string[] = []
const FULL_REASON = 'escalate sandbox to danger-full-access: Test orphan lifecycle authorization'

class FixtureShell extends Service {
  readonly sandboxMode = 'workspace-write'
  constructor(ctx: Context) { super(ctx, 'shell') }
}
class FixtureLlm extends Service { constructor(ctx: Context) { super(ctx, 'llm') } }
class FixtureDirectory extends Service {
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  async ensure(agent: Agent, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    return agent.session.header.cwd ?? '/workspace'
  }
}

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FixtureShell)
  await ctx.plugin(FixtureLlm)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(FixtureDirectory)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/workspace' })
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(PermissionPresetService, {
    defaultPreset: 'workspace-write',
    presets: { 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } },
  })
  await ctx.plugin(SubagentRuntime, {})
  const session = ctx.sessions.create(SessionId('orphan-owner'), { meta: { cwd: '/workspace' } })
  session.append('turn/start', { turn: 1 })
  // Preparation, dispatch, approval, owner routing and disposal use real services.
  const agent = { id: session.id, session, ctx, options: { provider: 'fixture', model: 'fixture' } } as Agent
  const effects = vi.fn()
  const request = (exec: ToolRunContext) => ctx.approval.request({
    agent, toolName: exec.name, callId: exec.callId, signal: exec.signal, reason: FULL_REASON,
  })
  const body = vi.fn(async (_args: unknown, exec: ToolRunContext) => {
    if (await request(exec) !== 'allowed-once') throw new Error('Native authorization not granted')
    effects()
    return [{ type: 'text' as const, text: 'executed' }]
  })
  ctx.tools.register(defineContentToolFixture({
    name: 'probe', description: 'An implicit native approval lifecycle probe', parameters: {}, execute: body,
  }))
  const builtIn = vi.fn(async () => 'allowed-once' as const)
  ctx.on('approval/request', builtIn)
  const plugin = await ctx.plugin(SemiAuto, {
    permissionPopupPath: '/test/permission-popup', popupTimeoutMs: 600000,
    processGraceMs: 1000, outputLimitBytes: 65536,
  })
  const input = (call: string) => ({
    name: 'probe', arguments: {}, signal: new AbortController().signal,
    callId: ToolCallId(call), agent,
  })
  const settle = (event: 'idle' | 'disposed', owner = agent): void => {
    const carrier = scopeTarget(owner, owner)
    if (event === 'idle') ctx.emit(carrier, 'agent/status', { agent: owner, status: 'idle' })
    else ctx.emit(carrier, 'agent/disposed', { agent: owner })
  }
  return { ctx, session, agent, body, effects, builtIn, request, plugin, input, settle }
}

function nextTurn(): Promise<void> { return new Promise(resolve => setImmediate(resolve)) }
function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
}
beforeEach(async () => {
  popup.mockReset().mockResolvedValue({ kind: 'no_decision' })
  reviewer.mockReset().mockResolvedValue({ kind: 'allow' })
  modeHomes.push(await mkdtemp(join(tmpdir(), 'semi-auto-orphan-')))
  process.env.DSH_HOME = modeHomes[modeHomes.length - 1]
})
afterEach(async () => {
  while (contexts.length) await contexts.pop()!.fiber.dispose()
  delete process.env.DSH_HOME
  while (modeHomes.length) await rm(modeHomes.pop()!, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('native approval ownership when the scheduler owner settles', () => {
  it.each(['idle', 'disposed'] as const)('cleans an abandoned prepared record on exact owner %s without waiting for tools/result', async event => {
    const h = await harness()
    const scheduler = h.ctx.tools[TOOL_RUNTIME_SCHEDULER]
    const prepared = await scheduler.prepare(h.input('abandoned'))
    if (prepared.kind !== 'dispatch') throw new Error('Expected prepared scheduler slot')
    const results = vi.fn()
    h.ctx.on('tools/result', results)
    try {
      h.settle(event)
      expect(results).not.toHaveBeenCalled()
      expect(h.body).not.toHaveBeenCalled()
      expect(reviewer).not.toHaveBeenCalled()
      // Reuse proves the abandoned ownership record no longer creates ambiguity.
      expect((await h.ctx.tools.execute(h.input('abandoned'))).isError).toBe(false)
      expect(h.effects).toHaveBeenCalledOnce()
      expect(popup).toHaveBeenCalledOnce()
      await h.plugin.dispose()
      expect(prepared.exec.signal.aborted).toBe(false)
    } finally {
      scheduler.finish(prepared.exec, { content: [], isError: true, error: { message: 'abandoned fixture cleanup' } })
    }
  })

  it.each([
    ['idle', 'human'], ['idle', 'reviewer'], ['disposed', 'human'], ['disposed', 'reviewer'],
  ] as const)('owner %s cancels pending %s, but disposal still drains that authorization work', async (event, stage) => {
    const h = await harness()
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    if (stage === 'human') popup.mockImplementation(async (_runtime, _request, _config, signal) => { entered.resolve(signal); await release.promise; return { kind: 'allow' } })
    else reviewer.mockImplementation(async (_ctx, _exec, signal) => { entered.resolve(signal); await release.promise; return { kind: 'allow' } })
    const input = h.input('pending')
    const running = h.ctx.tools.execute(input)
    const signal = await entered.promise
    const unrelated = { ...h.agent, id: SessionId('unrelated') } as Agent
    h.settle(event, unrelated)
    expect(signal.aborted).toBe(false)
    h.settle(event)
    await whenAborted(signal)
    expect(input.signal.aborted).toBe(false)
    let disposed = false
    const disposing = h.plugin.dispose().then(() => { disposed = true })
    try {
      await nextTurn()
      expect(disposed).toBe(false)
      expect(h.effects).not.toHaveBeenCalled()
      expect(h.ctx.approval.overrideOf(h.session)).toBe('ask')
    } finally { release.resolve() }
    expect((await running).isError).toBe(true)
    await disposing
    expect(disposed).toBe(true)
    expect(h.builtIn).not.toHaveBeenCalled()
  })

  it.each(['idle', 'disposed'] as const)('owner %s and plugin unload do not abort or join an already approved body', async event => {
    const h = await harness()
    popup.mockResolvedValue({ kind: 'allow' })
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    h.body.mockImplementation(async (_args, exec) => {
      expect(await h.request(exec)).toBe('allowed-once')
      entered.resolve(exec.signal)
      await release.promise
      exec.signal.throwIfAborted()
      return [{ type: 'text', text: 'completed after unload' }]
    })
    const running = h.ctx.tools.execute(h.input('approved-body'))
    const signal = await entered.promise
    try {
      h.settle(event)
      await h.plugin.dispose()
      expect(signal.aborted).toBe(false)
    } finally { release.resolve() }
    expect((await running).isError).toBe(false)
    expect(popup).toHaveBeenCalledOnce()
    expect(reviewer).not.toHaveBeenCalled()
  })
})
