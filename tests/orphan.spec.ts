import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  ...await importOriginal<typeof import('../src/auto-review.js')>(),
  reviewTool: vi.fn(),
}))
vi.mock('../src/popup-runner.js', () => ({ runPopup: vi.fn() }))

const popup = vi.mocked(runPopup)
const reviewer = vi.mocked(reviewTool)
const contexts: Context[] = []

class FixtureShell extends Service {
  readonly sandboxMode = 'workspace-write'
  constructor(ctx: Context) { super(ctx, 'shell') }
}
class FixtureLlm extends Service {
  constructor(ctx: Context) { super(ctx, 'llm') }
}
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
  // Only external authorization and the Agent driver are synthetic. Preparation,
  // dispatch, policy folds, lifecycle routing, and plugin disposal are real.
  const agent = { id: session.id, session, ctx, options: { provider: 'fixture', model: 'fixture' } } as Agent
  const body = vi.fn(async (_args: unknown, _exec: ToolRunContext) => [{ type: 'text' as const, text: 'executed' }])
  ctx.tools.register(defineContentToolFixture({
    name: 'probe', description: 'A deterministic orphan lifecycle probe', parameters: {}, execute: body,
  }))
  const plugin = await ctx.plugin(SemiAuto, {
    permissionPopupPath: '/test/permission-popup', popupTimeoutMs: 600000,
    processGraceMs: 1000, outputLimitBytes: 65536,
  })
  expect(ctx.approval.overrideOf(session)).toBe('ask')
  expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('workspace-write')
  const input = (call: string) => ({
    name: 'probe', arguments: {}, signal: new AbortController().signal,
    callId: ToolCallId(call), agent,
  })
  const settle = (event: 'idle' | 'disposed', owner = agent): void => {
    const carrier = scopeTarget(owner, owner)
    if (event === 'idle') ctx.emit(carrier, 'agent/status', { agent: owner, status: 'idle' })
    else ctx.emit(carrier, 'agent/disposed', { agent: owner })
  }
  return { ctx, session, agent, body, plugin, input, settle }
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
}

beforeEach(() => {
  popup.mockReset().mockRejectedValue(new Error('A sandbox-only lifecycle fixture must not open the popup'))
  reviewer.mockReset().mockResolvedValue({ kind: 'allow' })
})

afterEach(async () => {
  while (contexts.length) await contexts.pop()!.fiber.dispose()
  vi.restoreAllMocks()
})

describe('abandoned scheduler authorization ownership', () => {
  it.each(['idle', 'disposed'] as const)('releases a prepared slot without tools/result when its exact owner becomes %s', async (event) => {
    const h = await harness()
    const scheduler = h.ctx.tools[TOOL_RUNTIME_SCHEDULER]
    const prepared = await scheduler.prepare(h.input('abandoned'))
    expect(prepared.kind).toBe('dispatch')
    if (prepared.kind !== 'dispatch') throw new Error('Expected an authorized scheduler slot')
    const reviewSignal = reviewer.mock.calls[0]![2]
    const results = vi.fn()
    h.ctx.on('tools/result', results)
    let disposed = false
    const disposing = h.plugin.dispose().then(() => { disposed = true })
    try {
      await whenAborted(reviewSignal)
      await nextTurn()
      expect(disposed).toBe(false)
      expect(h.ctx.approval.overrideOf(h.session)).toBe('ask')
      const unrelated = { ...h.agent, id: SessionId('unrelated') } as Agent
      h.settle(event, unrelated)
      await nextTurn()
      expect(disposed).toBe(false)
      expect(h.body).not.toHaveBeenCalled()
      // Model exceptional scheduler abandonment: the rc3 lifecycle contract
      // guarantees no queued/active driver at idle/disposed. This is not a real
      // loop exception test, and the abandoned slot is never dispatched later.
      h.settle(event)
      await disposing
      expect(disposed).toBe(true)
      expect(results).not.toHaveBeenCalled()
      expect(h.body).not.toHaveBeenCalled()
      expect(h.ctx.approval.overrideOf(h.session)).toBe('ask')
      expect(popup).not.toHaveBeenCalled()
      expect(reviewer).toHaveBeenCalledTimes(1)
    } finally {
      h.settle(event)
      await disposing
    }
  })

  it.each(['idle', 'disposed'] as const)('still joins an entered body wrapper after a synthetic %s releases admitted records', async (event) => {
    const h = await harness()
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    h.body.mockImplementation(async (_args, exec) => {
      entered.resolve(exec.signal)
      await release.promise
      return [{ type: 'text', text: 'settled' }]
    })
    const scheduler = h.ctx.tools[TOOL_RUNTIME_SCHEDULER]
    const abandoned = await scheduler.prepare(h.input('abandoned-beside-active'))
    expect(abandoned.kind).toBe('dispatch')
    if (abandoned.kind !== 'dispatch') throw new Error('Expected an authorized scheduler slot')
    const executing = h.ctx.tools.execute(h.input('active-body'))
    const bodySignal = await entered.promise
    let disposed = false
    const disposing = h.plugin.dispose().then(() => { disposed = true })
    try {
      await whenAborted(bodySignal)
      // Deliberately stronger than the real driver contract: even an early
      // lifecycle announcement must not hide an actual entered body wrapper.
      h.settle(event)
      await nextTurn()
      expect(bodySignal.aborted).toBe(true)
      expect(disposed).toBe(false)
      expect(h.ctx.approval.overrideOf(h.session)).toBe('ask')
      expect(h.body).toHaveBeenCalledTimes(1)
    } finally {
      h.settle(event)
      release.resolve()
      await Promise.all([executing, disposing])
    }
    expect(disposed).toBe(true)
    expect(h.ctx.approval.overrideOf(h.session)).toBe('ask')
    expect(popup).not.toHaveBeenCalled()
    expect(reviewer).toHaveBeenCalledTimes(2)
  })
})
