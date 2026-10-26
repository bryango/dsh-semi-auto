import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId, SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime, { NO_START_CAPABILITIES, type SubagentProvider } from '@deepseek-ai/dsh-subagent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, {
  defineContentToolFixture,
  RUN_CODE_NAME,
  TOOL_RUNTIME_SCHEDULER,
  type PreToolDecision,
  type ToolExecution,
  type ToolExecutionInput,
  type ToolExecutionToken,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import * as SemiAuto from '../src/index.js'
import { isAutoReviewCandidate, reviewTool } from '../src/auto-review.js'
import { runPopup } from '../src/popup-runner.js'

// Keep the real native/PTC candidate predicate; isolate only external authorization.
vi.mock('../src/auto-review.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/auto-review.js')>(),
  reviewTool: vi.fn(),
}))
vi.mock('../src/popup-runner.js', () => ({ runPopup: vi.fn() }))

const popup = vi.mocked(runPopup)
const reviewer = vi.mocked(reviewTool)
const contexts: Context[] = []
const CONFIG: SemiAuto.Config = {
  permissionPopupPath: '/test/permission-popup',
  popupTimeoutMs: 600000,
  processGraceMs: 1000,
  outputLimitBytes: 65536,
}

// These trusted services are unused beyond readiness/working-directory lookup:
// popup and reviewer I/O are mocked, while policy, sessions and tools are real.
class FixtureShell extends Service {
  readonly sandboxMode = 'workspace-write'
  constructor(ctx: Context) { super(ctx, 'shell') }
}
class FixtureLlm extends Service {
  constructor(ctx: Context) { super(ctx, 'llm') }
}
class FixtureRemoteSubprocess extends Service {
  constructor(ctx: Context) { super(ctx, 'subprocess') }
}
class FixtureDirectory extends Service {
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  async ensure(agent: Agent, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    return agent.session.header.cwd ?? '/workspace'
  }
}

interface PluginHandle { dispose(): Promise<void> }

async function harness(options: { enable?: boolean; external?: boolean; remoteSubprocess?: boolean } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FixtureShell)
  await ctx.plugin(FixtureLlm)
  if (options.remoteSubprocess) await ctx.plugin(FixtureRemoteSubprocess)
  else await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(FixtureDirectory)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/workspace' })
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(PermissionPresetService, {
    defaultPreset: 'workspace-write',
    presets: {
      'read-only': { sandbox: 'read-only', approval: 'ask' },
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    },
  })
  await ctx.plugin(SubagentRuntime, {})
  if (options.external) ctx.subagents.registerProvider(externalProvider())
  const session = ctx.sessions.create(SessionId('existing'), { meta: { cwd: '/workspace' } })
  // A full loop is unnecessary: real ToolRuntime only needs the scope identity,
  // Session and Context here; reviewer execution is separately mocked.
  const agent = { id: session.id, session, ctx, options: { provider: 'fixture', model: 'fixture' } } as Agent
  const body = vi.fn(async (_args: unknown, _exec: ToolRunContext) => [{ type: 'text' as const, text: 'executed' }])
  ctx.tools.register(defineContentToolFixture({
    name: 'probe', description: 'A deterministic body counter', parameters: {}, execute: body,
  }))
  const enable = async (): Promise<PluginHandle> => ctx.plugin(SemiAuto, CONFIG)
  const plugin = options.enable === false ? undefined : await enable()
  let call = 0
  const execute = (changes: Partial<ToolExecutionInput> = {}) => ctx.tools.execute({
    name: 'probe', arguments: {}, signal: new AbortController().signal,
    callId: ToolCallId(`call-${++call}`), agent, ...changes,
  })
  return { ctx, session, agent, body, plugin, enable, execute }
}

function externalProvider(name = 'external'): SubagentProvider {
  return {
    name, capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
    start: vi.fn(async () => { throw new Error('External process must not start') }),
  }
}

function pending<T>() {
  return Promise.withResolvers<T>()
}

function decisionExecution(agent: Agent, name: string, parent?: ToolExecutionToken): ToolExecution {
  // Opaque execution tokens are normally assigned by ToolRuntime; this helper
  // is only for the real waterfall's outer-transport exclusion case.
  const token = Symbol('waterfall fixture') as ToolExecutionToken
  return {
    name, agent, callId: ToolCallId('waterfall'), rootCallId: ToolCallId('waterfall'),
    token, arguments: {}, signal: new AbortController().signal, ...parent === undefined ? {} : { parent },
  }
}

beforeEach(() => {
  popup.mockReset().mockResolvedValue({ kind: 'allow' })
  reviewer.mockReset().mockResolvedValue({ kind: 'allow' })
})

afterEach(async () => {
  while (contexts.length) await contexts.pop()!.fiber.dispose()
  vi.restoreAllMocks()
})

describe('Semi Auto with real Cordis and DSH policy/tool services', () => {
  it('pins only approval for existing and new sessions, then restores ask on disable', async () => {
    const h = await harness({ enable: false })
    const plugin = await h.enable()
    const fresh = h.ctx.sessions.create(SessionId('fresh'), { meta: { cwd: '/workspace/fresh' } })
    for (const session of [h.session, fresh]) {
      expect(h.ctx.sandboxPolicy.resolve({ session }).mode).toBe('workspace-write')
      expect(h.ctx.approval.overrideOf(session)).toBe('never')
    }
    await plugin.dispose()
    for (const session of [h.session, fresh]) {
      expect(h.ctx.sandboxPolicy.resolve({ session }).mode).toBe('workspace-write')
      expect(h.ctx.approval.overrideOf(session)).toBe('ask')
      expect(h.ctx.permissionPresets.current(session)).toBe('workspace-write')
    }
    expect((await h.execute()).isError).toBe(false)
    expect(popup).not.toHaveBeenCalled()
  })

  it('preserves an initial read-only sandbox on enable, normal review and disable', async () => {
    const h = await harness({ enable: false })
    h.ctx.permissionPresets.set(h.session, 'read-only')
    const sandboxEvents = vi.fn()
    h.ctx.on('session/event', (_session, event) => {
      if (event.type === 'sandbox/mode') sandboxEvents()
    })
    const plugin = await h.enable()
    expect(h.ctx.sandboxPolicy.resolve({ session: h.session }).mode).toBe('read-only')
    expect(h.ctx.approval.overrideOf(h.session)).toBe('never')
    expect((await h.execute()).isError).toBe(false)
    expect(popup).toHaveBeenCalledTimes(1)
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(h.body).toHaveBeenCalledTimes(1)
    await plugin.dispose()
    expect(h.ctx.sandboxPolicy.resolve({ session: h.session }).mode).toBe('read-only')
    expect(h.ctx.approval.overrideOf(h.session)).toBe('ask')
    expect(h.ctx.permissionPresets.current(h.session)).toBe('read-only')
    expect(sandboxEvents).not.toHaveBeenCalled()
  })

  it.each(['read-only', 'workspace-write'] as const)('native %s selection preserves its sandbox and keeps approval never', async (initial) => {
    const h = await harness()
    const alternate = initial === 'read-only' ? 'workspace-write' : 'read-only'
    for (const mode of [initial, alternate, initial]) {
      h.ctx.permissionPresets.set(h.session, mode)
      await Promise.resolve()
      expect(h.ctx.sandboxPolicy.resolve({ session: h.session }).mode).toBe(mode)
      expect(h.ctx.approval.overrideOf(h.session)).toBe('never')
      expect((await h.execute()).isError).toBe(false)
    }
    expect(popup).toHaveBeenCalledTimes(3)
    expect(reviewer).toHaveBeenCalledTimes(3)
    expect(h.body).toHaveBeenCalledTimes(3)
    await h.plugin!.dispose()
    expect(h.ctx.sandboxPolicy.resolve({ session: h.session }).mode).toBe(initial)
    expect(h.ctx.approval.overrideOf(h.session)).toBe('ask')
  })

  it.each(['before-enable', 'while-enabled'] as const)('preserves a user-selected full-access sandbox %s but never executes tools until disabled', async (selection) => {
    const h = await harness({ enable: false })
    if (selection === 'before-enable') h.ctx.permissionPresets.set(h.session, 'danger-full-access')
    const plugin = await h.enable()
    if (selection === 'while-enabled') h.ctx.permissionPresets.set(h.session, 'danger-full-access')
    expect(h.ctx.sandboxPolicy.resolve({ session: h.session }).mode).toBe('danger-full-access')
    expect(h.ctx.approval.overrideOf(h.session)).toBe('never')
    expect((await h.execute()).isError).toBe(true)
    expect(popup).not.toHaveBeenCalled()
    expect(reviewer).not.toHaveBeenCalled()
    expect(h.body).not.toHaveBeenCalled()
    await plugin.dispose()
    expect(h.ctx.sandboxPolicy.resolve({ session: h.session }).mode).toBe('danger-full-access')
    expect(h.ctx.approval.overrideOf(h.session)).toBe('ask')
  })

  it('preserves a seeded full-access child but denies its tools, then restores only ask on disable', async () => {
    const h = await harness()
    const child = h.ctx.sessions.prepare(SessionId('seeded-child'), {
      seed: [], inheritedEventCount: SessionLogOffset(0),
      meta: { cwd: '/workspace/child', origin: 'subagent', parentSession: h.session.id, isSeeded: true },
    })
    child.append('permission/preset', { preset: 'danger-full-access' })
    child.append('sandbox/mode', { mode: 'danger-full-access', source: 'delegation' })
    child.append('approval/policy', { policy: 'never', source: 'delegation' })
    const detach = h.ctx.sessions.enter(child)
    try {
      h.ctx.sessions.announce(child)
      expect(h.ctx.sandboxPolicy.resolve({ session: child }).mode).toBe('danger-full-access')
      expect(h.ctx.approval.overrideOf(child)).toBe('never')
      const childAgent = { ...h.agent, id: child.id, session: child } as Agent
      expect((await h.execute({ agent: childAgent })).isError).toBe(true)
      expect(popup).not.toHaveBeenCalled()
      expect(reviewer).not.toHaveBeenCalled()
      expect(h.body).not.toHaveBeenCalled()
      await h.plugin!.dispose()
      expect(h.ctx.sandboxPolicy.resolve({ session: child }).mode).toBe('danger-full-access')
      expect(h.ctx.approval.overrideOf(child)).toBe('ask')
    } finally {
      detach()
    }
  })

  it('runs human, reviewer, downstream policy and tool body in that order', async () => {
    const h = await harness()
    const order: string[] = []
    popup.mockImplementation(async () => { order.push('human'); return { kind: 'allow' } })
    reviewer.mockImplementation(async () => { order.push('reviewer'); return { kind: 'allow' } })
    h.ctx.on('tools/pre-execute', async (_exec, next) => { order.push('downstream'); return next() })
    h.body.mockImplementation(async () => { order.push('body'); return [{ type: 'text', text: 'ran' }] })
    expect((await h.execute()).isError).toBe(false)
    expect(order).toEqual(['human', 'reviewer', 'downstream', 'body'])
    expect(popup).toHaveBeenCalledExactlyOnceWith(
      expect.anything(), { sessionId: h.session.id, cwd: '/workspace', toolName: 'probe', args: {} },
      { binaryPath: '/test/permission-popup', timeoutMs: 600000, graceMs: 1000, outputLimitBytes: 65536 },
      expect.any(AbortSignal),
    )
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(h.body).toHaveBeenCalledTimes(1)
  })

  it('Authorize skips only Auto review, not downstream policy or tool guards', async () => {
    const h = await harness()
    popup.mockResolvedValue({ kind: 'allow_direct' })
    const downstream = vi.fn()
    h.ctx.on('tools/pre-execute', async (_exec, next) => { downstream(); return next() })
    h.ctx.tools.guard(() => 'Independent final guard denied')
    const result = await h.execute()
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('Independent final guard denied')
    expect(downstream).toHaveBeenCalledTimes(1)
    expect(reviewer).not.toHaveBeenCalled()
    expect(h.body).not.toHaveBeenCalled()
  })

  it('Authorize executes after downstream allows without a reviewer request', async () => {
    const h = await harness()
    popup.mockResolvedValue({ kind: 'allow_direct' })
    expect((await h.execute()).isError).toBe(false)
    expect(popup).toHaveBeenCalledTimes(1)
    expect(reviewer).not.toHaveBeenCalled()
    expect(h.body).toHaveBeenCalledTimes(1)
  })

  it('human denial prevents reviewer, downstream and body', async () => {
    const h = await harness()
    popup.mockResolvedValue({ kind: 'deny', reason: 'User denied' })
    const downstream = vi.fn()
    h.ctx.on('tools/pre-execute', async (_exec, next) => { downstream(); return next() })
    const result = await h.execute()
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('User denied')
    expect(reviewer).not.toHaveBeenCalled()
    expect(downstream).not.toHaveBeenCalled()
    expect(h.body).not.toHaveBeenCalled()
  })

  it('Auto denial is final and does not reach downstream or built-in approval', async () => {
    const h = await harness()
    reviewer.mockResolvedValue({ kind: 'deny', reason: 'Model denied' })
    const downstream = vi.fn()
    const builtInApproval = vi.fn()
    h.ctx.on('tools/pre-execute', async (_exec, next) => { downstream(); return next() })
    h.ctx.on('approval/request', async () => { builtInApproval(); return 'allowed-once' })
    const result = await h.execute()
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('Model denied')
    expect(popup).toHaveBeenCalledTimes(1)
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(downstream).not.toHaveBeenCalled()
    expect(builtInApproval).not.toHaveBeenCalled()
    expect(h.body).not.toHaveBeenCalled()
  })

  it.each(['allow', 'allow_direct'] as const)('preserves downstream denial after human %s', async (kind) => {
    const h = await harness()
    popup.mockResolvedValue({ kind })
    h.ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'Downstream rejected' }))
    const result = await h.execute()
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('Downstream rejected')
    expect(h.body).not.toHaveBeenCalled()
  })

  it.each(['popup', 'reviewer'] as const)('%s infrastructure failure fails closed', async (source) => {
    const h = await harness()
    if (source === 'popup') popup.mockRejectedValue(new Error('helper failed'))
    else reviewer.mockRejectedValue(new Error('review failed'))
    const result = await h.execute()
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('Semi Auto failed')
    expect(h.body).not.toHaveBeenCalled()
  })

  it('blocks a changed full-access sandbox before any popup', async () => {
    const h = await harness()
    setSandboxMode(h.session, 'danger-full-access')
    const result = await h.execute()
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('requires read-only or workspace-write with approval never')
    expect(popup).not.toHaveBeenCalled()
    expect(reviewer).not.toHaveBeenCalled()
    expect(h.body).not.toHaveBeenCalled()
  })

  it('re-pins a native ask selection after its session event has finished', async () => {
    const h = await harness()
    setApprovalPolicy(h.session, 'ask')
    expect(h.ctx.approval.overrideOf(h.session)).toBe('ask')
    await Promise.resolve()
    expect(h.ctx.approval.overrideOf(h.session)).toBe('never')
    expect((await h.execute()).isError).toBe(false)
    expect(popup).toHaveBeenCalledTimes(1)
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(h.body).toHaveBeenCalledTimes(1)
  })

  it('re-pins ask before reviewing an immediate call without waiting for the queued repin', async () => {
    const h = await harness()
    const queuedRepins: Array<() => void> = []
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(callback => { queuedRepins.push(callback) })
    setApprovalPolicy(h.session, 'ask')
    expect(h.ctx.approval.overrideOf(h.session)).toBe('ask')
    expect(queuedRepins).toHaveLength(1)
    const result = await h.execute()
    expect(queuedRepins).toHaveLength(1)
    expect(h.ctx.approval.overrideOf(h.session)).toBe('never')
    expect(result.isError).toBe(false)
    expect(popup).toHaveBeenCalledTimes(1)
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(h.body).toHaveBeenCalledTimes(1)
    queuedRepins[0]!()
    expect(h.ctx.approval.overrideOf(h.session)).toBe('never')
  })

  it('rechecks policy after the human allows', async () => {
    const h = await harness()
    popup.mockImplementation(async () => {
      setSandboxMode(h.session, 'danger-full-access')
      return { kind: 'allow' }
    })
    expect((await h.execute()).isError).toBe(true)
    expect(reviewer).not.toHaveBeenCalled()
    expect(h.body).not.toHaveBeenCalled()
  })

  it('a full-access then workspace-write race permanently cancels a pending popup allow', async () => {
    const h = await harness()
    const entered = pending<AbortSignal>()
    const release = pending<void>()
    popup.mockImplementation(async (_runtime, _request, _config, signal) => {
      entered.resolve(signal)
      await release.promise
      return { kind: 'allow' }
    })
    const executing = h.execute()
    const signal = await entered.promise
    setSandboxMode(h.session, 'danger-full-access')
    setSandboxMode(h.session, 'workspace-write')
    expect(h.ctx.sandboxPolicy.resolve({ session: h.session }).mode).toBe('workspace-write')
    expect(signal.aborted).toBe(true)
    release.resolve()
    expect((await executing).isError).toBe(true)
    expect(reviewer).not.toHaveBeenCalled()
    expect(h.body).not.toHaveBeenCalled()
  })

  it('a confined sandbox change invalidates a call in the real scheduler prepare/dispatch gap', async () => {
    const h = await harness()
    const scheduler = h.ctx.tools[TOOL_RUNTIME_SCHEDULER]
    const prepared = await scheduler.prepare({
      name: 'probe', arguments: {}, signal: new AbortController().signal,
      callId: ToolCallId('sandbox-switch-queued'), agent: h.agent,
    })
    expect(prepared.kind).toBe('dispatch')
    if (prepared.kind !== 'dispatch') throw new Error('Expected an authorized scheduled dispatch')
    setSandboxMode(h.session, 'read-only')
    expect(h.ctx.approval.overrideOf(h.session)).toBe('never')
    const dispatched = await scheduler.dispatch(prepared.exec)
    const result = dispatched.kind === 'post-result'
      ? await scheduler.finalize(prepared.exec, dispatched.result)
      : scheduler.finish(prepared.exec, dispatched.result)
    expect(result.isError).toBe(true)
    expect(h.body).not.toHaveBeenCalled()
    expect((await h.execute()).isError).toBe(false)
    expect(h.ctx.sandboxPolicy.resolve({ session: h.session }).mode).toBe('read-only')
    expect(popup).toHaveBeenCalledTimes(2)
    expect(reviewer).toHaveBeenCalledTimes(2)
    expect(h.body).toHaveBeenCalledTimes(1)
  })

  it.each(['human', 'reviewer'] as const)('a native read-only/workspace switch during %s cancels authorization but not the next call', async (stage) => {
    const h = await harness()
    h.ctx.permissionPresets.set(h.session, 'read-only')
    const entered = pending<AbortSignal>()
    const release = pending<void>()
    if (stage === 'human') {
      popup.mockImplementationOnce(async (_runtime, _request, _config, signal) => {
        entered.resolve(signal)
        await release.promise
        return { kind: 'allow' }
      })
    } else {
      reviewer.mockImplementationOnce(async (_ctx, _exec, signal) => {
        entered.resolve(signal)
        await release.promise
        return { kind: 'allow' }
      })
    }
    const executing = h.execute()
    const signal = await entered.promise
    h.ctx.permissionPresets.set(h.session, 'workspace-write')
    expect(signal.aborted).toBe(true)
    expect(h.ctx.sandboxPolicy.resolve({ session: h.session }).mode).toBe('workspace-write')
    await Promise.resolve()
    expect(h.ctx.approval.overrideOf(h.session)).toBe('never')
    release.resolve()
    expect((await executing).isError).toBe(true)
    expect(h.body).not.toHaveBeenCalled()
    if (stage === 'human') expect(reviewer).not.toHaveBeenCalled()
    expect((await h.execute()).isError).toBe(false)
    expect(h.body).toHaveBeenCalledTimes(1)
  })

  it('an approval change during Auto review cancels authorization even after queued repinning', async () => {
    const h = await harness()
    let reviewSignal: AbortSignal | undefined
    reviewer.mockImplementation(async (_ctx, _exec, signal) => {
      reviewSignal = signal
      setApprovalPolicy(h.session, 'ask')
      expect(signal.aborted).toBe(true)
      expect(h.ctx.approval.overrideOf(h.session)).toBe('ask')
      await Promise.resolve()
      expect(h.ctx.approval.overrideOf(h.session)).toBe('never')
      expect(signal.aborted).toBe(true)
      return { kind: 'allow' }
    })
    expect((await h.execute()).isError).toBe(true)
    expect(reviewSignal?.aborted).toBe(true)
    expect(h.body).not.toHaveBeenCalled()
  })

  it.each(['danger-full-access', 'workspace-write'])('rejects an explicit %s escalation without prompting', async (mode) => {
    const h = await harness()
    const result = await h.execute({ arguments: { sandbox_permissions: mode } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('rejects sandbox escalation')
    expect(popup).not.toHaveBeenCalled()
    expect(h.body).not.toHaveBeenCalled()
  })

  it('rejects agentless execution before popup or body', async () => {
    const h = await harness()
    const result = await h.execute({ agent: undefined })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('agent-owned')
    expect(popup).not.toHaveBeenCalled()
    expect(h.body).not.toHaveBeenCalled()
  })

  it('a later prepended allow cannot bypass the monotonic authorization guard', async () => {
    const h = await harness()
    h.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })
    const result = await h.execute()
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('authorization did not complete')
    expect(popup).not.toHaveBeenCalled()
    expect(reviewer).not.toHaveBeenCalled()
    expect(h.body).not.toHaveBeenCalled()
  })

  it('the final guard catches policy changes made by a downstream listener', async () => {
    const h = await harness()
    h.ctx.on('tools/pre-execute', async (_exec, next) => {
      const result = await next()
      setApprovalPolicy(h.session, 'ask')
      return result
    })
    expect((await h.execute()).isError).toBe(true)
    expect(h.body).not.toHaveBeenCalled()
  })

  it.each(['sandbox', 'approval'] as const)('rechecks a %s change in an earlier execute wrapper before the body', async (policy) => {
    const h = await harness({ enable: false })
    const order: string[] = []
    // This wrapper must be registered before Semi Auto so its mutation happens
    // after the monotonic guard, but before Semi Auto's dispatch-time check.
    h.ctx.on('tools/execute', async (_exec, next) => {
      order.push('earlier-wrapper')
      if (policy === 'sandbox') setSandboxMode(h.session, 'danger-full-access')
      else setApprovalPolicy(h.session, 'ask')
      return next()
    })
    await h.enable()
    popup.mockImplementation(async () => { order.push('human'); return { kind: 'allow' } })
    reviewer.mockImplementation(async () => { order.push('reviewer'); return { kind: 'allow' } })
    const result = await h.execute()
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('requires read-only or workspace-write with approval never')
    expect(order).toEqual(['human', 'reviewer', 'earlier-wrapper'])
    expect(h.body).not.toHaveBeenCalled()
  })

  it('fuses policy cancellation through a later execute wrapper even after policy returns to normal', async () => {
    const h = await harness()
    let downstreamSignal: AbortSignal | undefined
    h.ctx.on('tools/execute', async (exec, next) => {
      downstreamSignal = exec.signal
      setSandboxMode(h.session, 'danger-full-access')
      setSandboxMode(h.session, 'workspace-write')
      expect(exec.signal.aborted).toBe(true)
      return next()
    })
    const result = await h.execute()
    expect(result.isError).toBe(true)
    expect(downstreamSignal?.aborted).toBe(true)
    expect(h.body).not.toHaveBeenCalled()
    expect(popup).toHaveBeenCalledTimes(1)
    expect(reviewer).toHaveBeenCalledTimes(1)
  })

  it('fuses lifecycle cancellation into the actual body and disposal waits for body settlement', async () => {
    const h = await harness()
    const entered = pending<AbortSignal>()
    const release = pending<void>()
    const caller = new AbortController()
    const order: string[] = []
    // A later wrapper observes the dispatch signal delivered by Semi Auto.
    h.ctx.on('tools/execute', async (exec, next) => {
      order.push('later-wrapper')
      const result = await next()
      expect(exec.signal.aborted).toBe(true)
      order.push('later-wrapper-settled')
      return result
    })
    h.body.mockImplementation(async (_args, exec) => {
      order.push('body')
      entered.resolve(exec.signal)
      await release.promise
      order.push('body-settled')
      return [{ type: 'text', text: 'settled' }]
    })
    const executing = h.execute({ signal: caller.signal })
    const bodySignal = await entered.promise
    expect(bodySignal).not.toBe(caller.signal)
    const aborted = pending<void>()
    bodySignal.addEventListener('abort', () => aborted.resolve(), { once: true })
    let disposed = false
    const disposing = h.plugin!.dispose().then(() => { disposed = true; order.push('disposed') })
    try {
      await aborted.promise
      expect(bodySignal.aborted).toBe(true)
      expect(caller.signal.aborted).toBe(false)
      expect(disposed).toBe(false)
      expect(h.ctx.approval.overrideOf(h.session)).toBe('never')
    } finally {
      // Release before awaiting either promise: disposal intentionally joins
      // the tool body, even when it does not stop immediately on cancellation.
      release.resolve()
      await Promise.all([executing, disposing])
    }
    expect(disposed).toBe(true)
    expect(order).toEqual(['later-wrapper', 'body', 'body-settled', 'later-wrapper-settled', 'disposed'])
    expect(h.ctx.approval.overrideOf(h.session)).toBe('ask')
  })

  it('blocks dispatch resumed after disposal even when authorization already allowed', async () => {
    const h = await harness({ enable: false })
    const entered = pending<void>()
    const release = pending<void>()
    // Hold dispatch outside the plugin's body wrapper; authorization has
    // finished but the invocation has not entered Semi Auto's dispatch scope.
    h.ctx.on('tools/execute', async (_exec, next) => {
      entered.resolve()
      await release.promise
      return next()
    })
    const plugin = await h.enable()
    const executing = h.execute()
    await entered.promise
    expect(popup).toHaveBeenCalledTimes(1)
    expect(reviewer).toHaveBeenCalledTimes(1)
    let disposed = false
    const disposing = plugin.dispose().then(() => { disposed = true })
    try {
      await Promise.resolve()
      expect(disposed).toBe(false)
      expect(h.ctx.approval.overrideOf(h.session)).toBe('never')
      expect(h.body).not.toHaveBeenCalled()
    } finally {
      release.resolve()
    }
    const result = await executing
    await disposing
    expect(disposed).toBe(true)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('Semi Auto is stopping')
    expect(h.body).not.toHaveBeenCalled()
  })

  it('holds disposal across the real scheduler prepare/dispatch gap until its final result', async () => {
    const h = await harness()
    // Pinned rc3's symbol-keyed scheduler is the same staged API used by the loop.
    const scheduler = h.ctx.tools[TOOL_RUNTIME_SCHEDULER]
    const prepared = await scheduler.prepare({
      name: 'probe', arguments: {}, signal: new AbortController().signal,
      callId: ToolCallId('queued-call'), agent: h.agent,
    })
    expect(prepared.kind).toBe('dispatch')
    if (prepared.kind !== 'dispatch') throw new Error('Expected an authorized scheduled dispatch')
    const results = vi.fn()
    h.ctx.on('tools/result', results)
    let disposed = false
    const disposing = h.plugin!.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(h.ctx.approval.overrideOf(h.session)).toBe('never')
    let notified = false
    try {
      const dispatched = await scheduler.dispatch(prepared.exec)
      expect(dispatched.result.isError).toBe(true)
      expect(JSON.stringify(dispatched.result)).toContain('Semi Auto is stopping')
      expect(results).not.toHaveBeenCalled()
      expect(disposed).toBe(false)
      const result = dispatched.kind === 'post-result'
        ? await scheduler.finalize(prepared.exec, dispatched.result)
        : scheduler.finish(prepared.exec, dispatched.result)
      notified = true
      expect(result.isError).toBe(true)
      expect(results).toHaveBeenCalledTimes(1)
      expect(results.mock.calls[0]?.[0]).toBe(prepared.exec)
    } finally {
      // Complete the real scheduler result path even if an assertion fails.
      if (!notified) scheduler.finish(prepared.exec, { content: [], isError: true, error: { message: 'test cleanup' } })
      await disposing
    }
    expect(disposed).toBe(true)
    expect(h.ctx.approval.overrideOf(h.session)).toBe('ask')
    expect(popup).toHaveBeenCalledTimes(1)
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(h.body).not.toHaveBeenCalled()
  })

  it('native and PTC inner calls are each human-gated and reviewed once', async () => {
    const h = await harness()
    expect((await h.execute()).isError).toBe(false)
    const parent = Symbol('outer transport') as ToolExecutionToken
    expect((await h.execute({ parent, rootCallId: ToolCallId('outer') })).isError).toBe(false)
    expect(popup).toHaveBeenCalledTimes(2)
    expect(reviewer).toHaveBeenCalledTimes(2)
    expect(h.body).toHaveBeenCalledTimes(2)
    expect(reviewer.mock.calls[1]?.[1].parent).toBe(parent)
  })

  it('the actual predicate skips only root run_code and the real waterfall still delegates', async () => {
    const h = await harness()
    const exec = decisionExecution(h.agent, RUN_CODE_NAME)
    expect(isAutoReviewCandidate(exec)).toBe(false)
    expect(isAutoReviewCandidate({ ...exec, parent: Symbol('parent') as ToolExecutionToken })).toBe(true)
    const downstream = vi.fn(async (): Promise<PreToolDecision> => ({ kind: 'allow' }))
    expect(await h.ctx.waterfall('tools/pre-execute', exec, downstream)).toEqual({ kind: 'allow' })
    // This predicate-only fixture bypasses ToolRuntime's scheduler; settle its
    // admitted call explicitly so the plugin does not wait for a missing result.
    h.ctx.emit('tools/result', exec, { content: [], value: null, isError: false })
    expect(downstream).toHaveBeenCalledTimes(1)
    expect(popup).not.toHaveBeenCalled()
    expect(reviewer).not.toHaveBeenCalled()
    // Transport exclusion must not exempt the root from its sandbox check.
    setSandboxMode(h.session, 'danger-full-access')
    const denied = await h.ctx.waterfall('tools/pre-execute', exec, downstream)
    expect(denied.kind).toBe('deny')
    expect(downstream).toHaveBeenCalledTimes(1)
  })

  it.each(['human', 'reviewer'] as const)('disposal aborts a pending %s and a late allow cannot execute', async (stage) => {
    const h = await harness()
    const entered = pending<AbortSignal>()
    const release = pending<void>()
    if (stage === 'human') {
      popup.mockImplementation(async (_runtime, _request, _config, signal) => {
        entered.resolve(signal)
        await release.promise
        return { kind: 'allow' }
      })
    } else {
      reviewer.mockImplementation(async (_ctx, _exec, signal) => {
        entered.resolve(signal)
        await release.promise
        return { kind: 'allow' }
      })
    }
    const executing = h.execute()
    const signal = await entered.promise
    const aborted = pending<void>()
    signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    let disposed = false
    const disposing = h.plugin!.dispose().then(() => { disposed = true })
    await aborted.promise
    expect(signal.aborted).toBe(true)
    expect(disposed).toBe(false)
    expect(h.body).not.toHaveBeenCalled()
    release.resolve()
    const result = await executing
    await disposing
    expect(result.isError).toBe(true)
    expect(h.body).not.toHaveBeenCalled()
    if (stage === 'human') expect(reviewer).not.toHaveBeenCalled()
    expect(h.ctx.approval.overrideOf(h.session)).toBe('ask')
  })

  it('caller cancellation during a popup prevents a late human allow from executing', async () => {
    const h = await harness()
    const entered = pending<void>()
    const release = pending<void>()
    popup.mockImplementation(async () => { entered.resolve(); await release.promise; return { kind: 'allow_direct' } })
    const controller = new AbortController()
    const executing = h.execute({ signal: controller.signal })
    await entered.promise
    controller.abort(new Error('caller canceled'))
    release.resolve()
    expect((await executing).isError).toBe(true)
    expect(reviewer).not.toHaveBeenCalled()
    expect(h.body).not.toHaveBeenCalled()
  })

  it('refuses activation with a nonlocal subprocess provider before pinning sessions', async () => {
    const h = await harness({ enable: false, remoteSubprocess: true })
    await expect(h.enable()).rejects.toThrow('native popup requires the local subprocess provider')
    expect(h.ctx.approval.overrideOf(h.session)).toBe('ask')
    expect(h.ctx.sandboxPolicy.resolve({ session: h.session }).mode).toBe('workspace-write')
    expect(popup).not.toHaveBeenCalled()
  })

  it('rejects enabling when an external provider is already registered', async () => {
    const h = await harness({ enable: false, external: true })
    await expect(h.enable()).rejects.toThrow('external subagent provider')
    expect(h.ctx.approval.overrideOf(h.session)).toBe('ask')
    expect(h.ctx.sandboxPolicy.resolve({ session: h.session }).mode).toBe('workspace-write')
  })

  it('rejects and rolls back a newly registered external provider', async () => {
    const h = await harness()
    expect(() => h.ctx.subagents.registerProvider(externalProvider('late-external'))).toThrow('external subagent provider')
    expect(h.ctx.subagents.getProvider('late-external')).toBeUndefined()
  })

  it('allows local providers and removes the provider veto when disabled', async () => {
    const h = await harness()
    h.ctx.subagents.registerProvider({
      name: 'local', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
      prepareContinuable: async () => ({}),
    })
    expect(h.ctx.subagents.getProvider('local')).toBeDefined()
    await h.plugin!.dispose()
    expect(() => h.ctx.subagents.registerProvider(externalProvider('after-disable'))).not.toThrow()
  })
})
