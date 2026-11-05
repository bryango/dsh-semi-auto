import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import { approveEscalation, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime, { NO_START_CAPABILITIES, type SubagentProvider } from '@deepseek-ai/dsh-subagent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, {
  defineContentToolFixture, TOOL_RUNTIME_SCHEDULER,
  type PreToolDecision, type ToolExecutionInput, type ToolExecutionToken, type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import * as SemiAuto from '../src/index.js'
import { reviewApproval, reviewTool } from '../src/auto-review.js'
import { runPopup } from '../src/popup-runner.js'

// Only authorization I/O is mocked; native approval, dispatch and policy services are real.
vi.mock('../src/auto-review.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/auto-review.js')>(), reviewTool: vi.fn(), reviewApproval: vi.fn(),
}))
vi.mock('../src/popup-runner.js', () => ({ runPopup: vi.fn() }))
const popup = vi.mocked(runPopup)
const reviewer = vi.mocked(reviewTool)
const requestReviewer = vi.mocked(reviewApproval)
const contexts: Context[] = []
const CONFIG: SemiAuto.Config = {
  permissionPopupPath: '/test/permission-popup', popupTimeoutMs: 600000,
  processGraceMs: 1000, outputLimitBytes: 65536,
}
const WIDER = { sandbox_permissions: 'danger-full-access', justification: 'Perform the explicitly requested operation.' }
const FULL_REASON = `escalate sandbox to danger-full-access: ${WIDER.justification}`
const APPROVAL = { requestedMode: 'danger-full-access' as const, reason: FULL_REASON }
class FixtureShell extends Service {
  readonly sandboxMode = 'workspace-write'
  constructor(ctx: Context) { super(ctx, 'shell') }
}
class FixtureLlm extends Service { constructor(ctx: Context) { super(ctx, 'llm') } }
class FixtureRemoteSubprocess extends Service { constructor(ctx: Context) { super(ctx, 'subprocess') } }
class FixtureDirectory extends Service {
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  async ensure(agent: Agent, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    return agent.session.header.cwd ?? '/workspace'
  }
}
/** Structural stand-in for the web connection service collecting the plugin's /api routes. */
class FixtureConnection extends Service {
  readonly routes = new Map<string, (request: Request) => Promise<Response>>()
  constructor(ctx: Context) { super(ctx, 'connection') }
  readonly fetch = {
    register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
      this.routes.set(route.path, route.fetch)
      return async (): Promise<void> => { this.routes.delete(route.path) }
    },
  }
  async call(path: string, payload: unknown): Promise<unknown> {
    const handler = this.routes.get(path)
    if (handler === undefined) throw new Error(`no /api route ${path}`)
    const response = await handler(new Request(`http://host${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: path.slice('/api/'.length), payload }),
    }))
    const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
    if (!body.result.ok) throw new Error(body.result.error?.message ?? 'fixture rpc failed')
    return body.result.value
  }
}
interface PluginHandle { dispose(): Promise<void> }
interface Args { sandbox_permissions?: string; justification?: string }

async function harness(options: { enable?: boolean; external?: boolean; remoteSubprocess?: boolean; mode?: 'read-only' | 'workspace-write' } = {}) {
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
  await ctx.plugin(FixtureConnection)
  const connection = ctx.get('connection') as FixtureConnection
  await ctx.plugin(SandboxPolicyService, { mode: options.mode ?? 'workspace-write', workspaceRoot: '/workspace' })
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(PermissionPresetService, {
    defaultPreset: options.mode ?? 'workspace-write',
    presets: {
      'read-only': { sandbox: 'read-only', approval: 'ask' },
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    },
  })
  await ctx.plugin(SubagentRuntime, {})
  if (options.external) ctx.subagents.registerProvider(externalProvider())
  const session = ctx.sessions.create(SessionId('existing'), { meta: { cwd: '/workspace' } })
  session.append('turn/start', { turn: 1 })
  const agent = { id: session.id, session, ctx, options: { provider: 'fixture', model: 'fixture' } } as Agent
  const effect = vi.fn((_mode: string) => undefined)
  const body = vi.fn(async (args: Args, exec: ToolRunContext): Promise<ContentBlock[]> => {
    validateEscalationArgs(args.sandbox_permissions, args.justification)
    const standing = ctx.sandboxPolicy.resolve({ session }).mode
    const mode = args.sandbox_permissions !== undefined && args.justification !== undefined
      ? await approveEscalation({
        requestedMode: args.sandbox_permissions, justification: args.justification,
        effectiveMode: standing, subject: 'fixture operation',
      }, { approver: ctx.approval, agent: exec.agent, callId: exec.callId, toolName: exec.name, signal: exec.signal })
      : standing
    exec.signal.throwIfAborted()
    effect(mode)
    return [{ type: 'text', text: 'executed' }]
  })
  ctx.tools.register(defineContentToolFixture({
    name: 'probe', description: 'An operation with real native one-shot approval',
    parameters: { sandbox_permissions: { type: 'string' }, justification: { type: 'string' } },
    execute: (args, exec) => body(args, exec),
  }))
  // No permission fields in either the schema or arguments: approval is requested by the body.
  ctx.tools.register(defineContentToolFixture({
    name: 'implicit', description: 'An implicit native full-access operation', parameters: {},
    execute: (_args, exec) => body(WIDER, exec),
  }))
  const builtIn = vi.fn(async () => 'allowed-once' as const)
  ctx.on('approval/request', builtIn)
  const enable = async (): Promise<PluginHandle> => ctx.plugin(SemiAuto, CONFIG)
  const plugin = options.enable === false ? undefined : await enable()
  let call = 0
  const execute = (changes: Partial<ToolExecutionInput> = {}) => ctx.tools.execute({
    name: 'probe', arguments: {}, signal: new AbortController().signal,
    callId: ToolCallId(`call-${++call}`), agent, ...changes,
  })
  const setMode = async (enabled: boolean): Promise<void> => { await connection.call('/api/semi-auto.set', { enabled }) }
  const rpcCall = (path: string, payload: unknown): Promise<unknown> => connection.call(path, payload)
  return { ctx, session, agent, body, effect, builtIn, plugin, enable, execute, setMode, rpcCall }
}
function externalProvider(name = 'external'): SubagentProvider {
  return { name, capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
    start: vi.fn(async () => { throw new Error('External process must not start') }) }
}
function expectPolicy(h: Awaited<ReturnType<typeof harness>>, mode: string, policy = 'ask') {
  expect(h.ctx.sandboxPolicy.resolve({ session: h.session }).mode).toBe(mode)
  expect(h.ctx.approval.overrideOf(h.session)).toBe(policy)
}
function finishPrepared(h: Awaited<ReturnType<typeof harness>>, exec: ToolRunContext) {
  h.ctx.tools[TOOL_RUNTIME_SCHEDULER].finish(exec, { content: [], isError: true, error: { message: 'fixture cleanup' } })
}
function nativeRequest(h: Awaited<ReturnType<typeof harness>>, exec: ToolRunContext, reason = FULL_REASON) {
  return { agent: h.agent, toolName: exec.name, callId: exec.callId, signal: exec.signal, reason }
}
const modeHomes: string[] = []
beforeEach(async () => {
  popup.mockReset().mockResolvedValue({ kind: 'no_decision' })
  reviewer.mockReset().mockResolvedValue({ kind: 'allow' })
  requestReviewer.mockReset().mockResolvedValue({ kind: 'allow' })
  modeHomes.push(await mkdtemp(join(tmpdir(), 'semi-auto-plugin-')))
  process.env.DSH_HOME = modeHomes[modeHomes.length - 1]
})
afterEach(async () => {
  while (contexts.length) await contexts.pop()!.fiber.dispose()
  delete process.env.DSH_HOME
  while (modeHomes.length) await rm(modeHomes.pop()!, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('all native approval requests are intercepted', () => {
  it.each(['allow', 'no_decision', 'deny', 'failure'] as const)('handles public requests without call id: %s', async kind => {
    const h = await harness()
    if (kind === 'failure') popup.mockRejectedValue(new Error('failed'))
    else popup.mockResolvedValue(kind === 'deny' ? { kind, reason: 'denied' } : { kind })
    expect(await h.ctx.approval.request({ agent: h.agent, toolName: 'public' })).toBe(
      kind === 'deny' || kind === 'failure' ? 'rejected' : 'allowed-once')
    expect(popup.mock.calls[0]![1]).toMatchObject({ toolName: 'public', approval: {} })
    expect(popup.mock.calls[0]![1].args).toBeUndefined()
    expect(requestReviewer).toHaveBeenCalledTimes(kind === 'no_decision' ? 1 : 0)
    expect(reviewer).not.toHaveBeenCalled()
    expect(h.builtIn).not.toHaveBeenCalled()
  })

  it.each(['permissions', 'unload', 'agent', 'signal'] as const)('cancels an unowned request on %s', async kind => {
    const h = await harness()
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    const caller = new AbortController()
    popup.mockImplementation(async (_runtime, _request, _config, signal) => {
      entered.resolve(signal); await release.promise; return { kind: 'allow' }
    })
    const running = h.ctx.approval.request({ agent: h.agent, toolName: 'public', signal: caller.signal })
    const signal = await entered.promise
    let disposing: Promise<void> | undefined
    if (kind === 'permissions') setSandboxMode(h.session, 'read-only')
    if (kind === 'unload') disposing = h.plugin!.dispose()
    if (kind === 'agent') h.ctx.emit('agent/disposed', { agent: h.agent })
    if (kind === 'signal') caller.abort()
    await Promise.resolve()
    expect(signal.aborted).toBe(true)
    release.resolve()
    expect(await running).toBe('cancelled')
    await disposing
    expect(requestReviewer).not.toHaveBeenCalled()
  })

  it.each(['read-only', 'workspace-write'] as const)('preserves native %s and ask through enable, new session and disable', async mode => {
    const h = await harness({ enable: false, mode })
    const before = h.session.snapshotEvents().length
    const plugin = await h.enable()
    expectPolicy(h, mode)
    expect(h.ctx.permissionPresets.current(h.session)).toBe(mode)
    const fresh = h.ctx.sessions.create(SessionId('fresh'), { meta: { cwd: '/workspace' } })
    expect(h.ctx.sandboxPolicy.resolve({ session: fresh }).mode).toBe(mode)
    expect(h.ctx.approval.overrideOf(fresh)).toBe('ask')
    await plugin.dispose()
    expectPolicy(h, mode)
    expect(h.session.snapshotEvents().slice(before).filter(event => event.type === 'approval/policy' || event.type === 'sandbox/mode')).toEqual([])
  })

  it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)('passes ordinary %s calls directly without review or popup', async mode => {
    const h = await harness()
    setSandboxMode(h.session, mode)
    expect((await h.execute()).isError).toBe(false)
    expect(h.effect).toHaveBeenCalledWith(mode)
    expect(reviewer).not.toHaveBeenCalled()
    expect(popup).not.toHaveBeenCalled()
    expect(h.builtIn).not.toHaveBeenCalled()
  })

  it('does not infer approval from parameter names, extra arguments or a nested call', async () => {
    const h = await harness()
    const ordinary = vi.fn(async (): Promise<ContentBlock[]> => [])
    h.ctx.tools.register(defineContentToolFixture({ name: 'ordinary', description: 'No native approval', parameters: {}, execute: ordinary }))
    const parent = Symbol('outer') as ToolExecutionToken
    expect((await h.execute({ name: 'ordinary', arguments: WIDER })).isError).toBe(false)
    expect((await h.execute({ parent, rootCallId: ToolCallId('outer') })).isError).toBe(false)
    expect(ordinary).toHaveBeenCalledOnce()
    expect(reviewer).not.toHaveBeenCalled()
    expect(popup).not.toHaveBeenCalled()
  })

  it.each(['explicit', 'implicit'] as const)('passes complete %s approval context to popup and fourth reviewer argument, without changing execution args', async kind => {
    const h = await harness()
    const args = kind === 'explicit' ? WIDER : {}
    const name = kind === 'explicit' ? 'probe' : 'implicit'
    const before = structuredClone(args)
    const order: string[] = []
    popup.mockImplementation(async () => { order.push('human'); return { kind: 'no_decision' } })
    reviewer.mockImplementation(async () => { order.push('review'); return { kind: 'allow' } })
    h.effect.mockImplementation(() => { order.push('effect') })
    expect((await h.execute({ name, arguments: args })).isError).toBe(false)
    expect(order).toEqual(['human', 'review', 'effect'])
    expect(popup).toHaveBeenCalledOnce()
    expect(popup.mock.calls[0]?.[1]).toMatchObject({ sessionId: h.session.id, toolName: name, args, approval: APPROVAL })
    expect(reviewer).toHaveBeenCalledOnce()
    expect(reviewer.mock.calls[0]?.[1]).toMatchObject({ name, arguments: args })
    expect(reviewer.mock.calls[0]?.[3]).toEqual(APPROVAL)
    expect(args).toEqual(before)
    expect(h.effect).toHaveBeenCalledWith('danger-full-access')
    expect(h.builtIn).not.toHaveBeenCalled()
    expectPolicy(h, 'workspace-write')
    await h.execute()
    expect(h.effect).toHaveBeenLastCalledWith('workspace-write')
    expect(reviewer).toHaveBeenCalledOnce()
    expect(popup).toHaveBeenCalledOnce()
  })

  it('human allow skips review for only that native request', async () => {
    const h = await harness()
    popup.mockResolvedValue({ kind: 'allow' })
    expect((await h.execute({ name: 'implicit' })).isError).toBe(false)
    await h.execute()
    expect(popup).toHaveBeenCalledOnce()
    expect(reviewer).not.toHaveBeenCalled()
    expectPolicy(h, 'workspace-write')
  })

  it.each(['human-deny', 'human-failure', 'review-deny', 'review-failure', 'review-cancel'] as const)('fails closed at %s without native fallback', async gate => {
    const h = await harness()
    if (gate === 'human-deny') popup.mockResolvedValue({ kind: 'deny', reason: 'No permission' })
    if (gate === 'human-failure') popup.mockRejectedValue(new Error('popup unavailable'))
    if (gate === 'review-deny') reviewer.mockResolvedValue({ kind: 'deny', reason: 'No permission' })
    if (gate === 'review-failure') reviewer.mockRejectedValue(new Error('review unavailable'))
    if (gate === 'review-cancel') reviewer.mockResolvedValue({ kind: 'cancel' })
    expect((await h.execute({ name: 'implicit' })).isError).toBe(true)
    expect(h.effect).not.toHaveBeenCalled()
    expect(h.builtIn).not.toHaveBeenCalled()
    expectPolicy(h, 'workspace-write')
  })

  it('preserves never without attempting popup or review', async () => {
    const h = await harness()
    setApprovalPolicy(h.session, 'never')
    expect((await h.execute({ name: 'implicit' })).isError).toBe(true)
    expect(h.effect).not.toHaveBeenCalled()
    expect(h.builtIn).not.toHaveBeenCalled()
    expect(popup).not.toHaveBeenCalled()
    expect(reviewer).not.toHaveBeenCalled()
    await h.plugin!.dispose()
    expectPolicy(h, 'workspace-write', 'never')
  })

  it.each([
    undefined, 'general policy question', 'escalate sandbox to workspace-write: write file',
    'escalate sandbox to danger-full-access:', 'escalate sandbox to danger-full-access: ',
    ' escalate sandbox to danger-full-access: reason', 'Escalate sandbox to danger-full-access: reason',
    'escalate sandbox to danger-full-access : reason',
  ])('reviews an unowned request with reason %j without guessing tool context', async reason => {
    const h = await harness()
    expect(await h.ctx.approval.request({ agent: h.agent, toolName: 'probe', callId: ToolCallId('missing'), reason })).toBe('allowed-once')
    expect(h.builtIn).not.toHaveBeenCalled()
    expect(popup).toHaveBeenCalledOnce()
    expect(popup.mock.calls[0]![1].args).toBeUndefined()
    expect(popup.mock.calls[0]![1].approval?.reason).toBe(reason)
    expect(requestReviewer).toHaveBeenCalledOnce()
    expect(reviewer).not.toHaveBeenCalled()
  })

  it('reviews read-only to workspace-write with its actual native scope', async () => {
    const h = await harness({ mode: 'read-only' })
    expect((await h.execute({ arguments: { ...WIDER, sandbox_permissions: 'workspace-write' } })).isError).toBe(false)
    expect(h.effect).toHaveBeenCalledWith('workspace-write')
    expect(h.builtIn).not.toHaveBeenCalled()
    expect(popup).toHaveBeenCalledOnce()
    expect(reviewer).toHaveBeenCalledOnce()
    expect(popup.mock.calls[0]![1].approval).toEqual({ requestedMode: 'workspace-write',
      reason: `escalate sandbox to workspace-write: ${WIDER.justification}` })
    expectPolicy(h, 'read-only')
  })

  it.each(['allow', 'deny', 'ask'] as const)('preserves downstream ordinary %s decisions', async kind => {
    const h = await harness()
    h.ctx.on('tools/pre-execute', async (): Promise<PreToolDecision> => kind === 'ask'
      ? { kind, reason: 'independent policy question' } : kind === 'deny' ? { kind, reason: 'denied' } : { kind })
    expect((await h.execute()).isError).toBe(kind === 'deny')
    expect(h.builtIn).not.toHaveBeenCalled()
    expect(h.effect).toHaveBeenCalledTimes(kind === 'deny' ? 0 : 1)
    expect(popup).toHaveBeenCalledTimes(kind === 'ask' ? 1 : 0)
    expect(reviewer).toHaveBeenCalledTimes(kind === 'ask' ? 1 : 0)
  })

  it('does not install a guard that rejects a later prepended ordinary allow', async () => {
    const h = await harness()
    h.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' as const }), { prepend: true })
    expect((await h.execute()).isError).toBe(false)
    expect(h.effect).toHaveBeenCalledOnce()
    expect(reviewer).not.toHaveBeenCalled()
  })

  it('keeps independent monotonic guards intact', async () => {
    const h = await harness()
    h.ctx.tools.guard(() => 'another guard denied')
    expect((await h.execute({ name: 'implicit' })).isError).toBe(true)
    expect(h.body).not.toHaveBeenCalled()
    expect(popup).not.toHaveBeenCalled()
  })

  it.each(['name', 'call-id', 'agent', 'missing-id'] as const)('does not borrow arguments for unmatched %s during dispatch', async mismatch => {
    const h = await harness()
    h.body.mockImplementation(async (_args, exec) => {
      const other = { ...h.agent, id: SessionId('different-agent') } as Agent
      expect(await h.ctx.approval.request({
        ...nativeRequest(h, exec), agent: mismatch === 'agent' ? other : h.agent,
        toolName: mismatch === 'name' ? 'other-tool' : exec.name,
        callId: mismatch === 'missing-id' ? undefined : mismatch === 'call-id' ? ToolCallId('other-call') : exec.callId,
      })).toBe('allowed-once')
      return []
    })
    expect((await h.execute()).isError).toBe(false)
    expect(popup).toHaveBeenCalledOnce()
    expect(popup.mock.calls[0]![1].args).toBeUndefined()
    expect(requestReviewer).toHaveBeenCalledOnce()
    expect(reviewer).not.toHaveBeenCalled()
    expect(h.builtIn).not.toHaveBeenCalled()
  })

  it('reviews unowned requests independently before dispatch and after result cleanup', async () => {
    const h = await harness()
    const callId = ToolCallId('completed')
    const request = { agent: h.agent, toolName: 'probe', callId, reason: FULL_REASON }
    expect(await h.ctx.approval.request(request)).toBe('allowed-once')
    await h.execute({ callId })
    expect(await h.ctx.approval.request(request)).toBe('allowed-once')
    expect(popup).toHaveBeenCalledTimes(2)
    expect(requestReviewer).toHaveBeenCalledTimes(2)
    expect(h.builtIn).not.toHaveBeenCalled()
  })

  it('reviews a native pre-dispatch approval without requiring tool execution', async () => {
    const h = await harness()
    h.ctx.on('tools/pre-execute', async exec => ({ kind: 'ask', reason: FULL_REASON }))
    expect((await h.execute()).isError).toBe(false)
    expect(popup).toHaveBeenCalledOnce()
    expect(h.builtIn).not.toHaveBeenCalled()
  })

  it('supports approvals for prepared calls before dispatch', async () => {
    const h = await harness()
    const scheduler = h.ctx.tools[TOOL_RUNTIME_SCHEDULER]
    const prepared = await scheduler.prepare({ name: 'implicit', arguments: {}, signal: new AbortController().signal, callId: ToolCallId('prepared'), agent: h.agent })
    if (prepared.kind !== 'dispatch') throw new Error('Expected prepared dispatch')
    try {
      expect(await h.ctx.approval.request(nativeRequest(h, prepared.exec))).toBe('allowed-once')
      expect(popup).toHaveBeenCalledOnce()
    } finally { finishPrepared(h, prepared.exec) }
  })

  it('rejects ambiguous active dispatch identity instead of choosing either execution', async () => {
    const h = await harness()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const bothDecided = Promise.withResolvers<void>()
    let count = 0
    let decided = 0
    h.body.mockImplementation(async (_args, exec) => {
      if (++count === 2) entered.resolve()
      await release.promise
      expect(await h.ctx.approval.request(nativeRequest(h, exec))).toBe('rejected')
      if (++decided === 2) bothDecided.resolve()
      await bothDecided.promise
      return []
    })
    const callId = ToolCallId('ambiguous-live')
    const first = h.execute({ callId })
    const second = h.execute({ callId })
    try { await entered.promise } finally { release.resolve() }
    expect((await first).isError).toBe(false)
    expect((await second).isError).toBe(false)
    expect(popup).not.toHaveBeenCalled()
    expect(h.builtIn).not.toHaveBeenCalled()
  })

  it.each(['human', 'reviewer'] as const)('runs a new %s decision for every repeated approval within one dispatch', async stage => {
    const h = await harness()
    if (stage === 'human') popup.mockResolvedValueOnce({ kind: 'allow' }).mockResolvedValueOnce({ kind: 'deny', reason: 'second denied' })
    else reviewer.mockResolvedValueOnce({ kind: 'allow' }).mockResolvedValueOnce({ kind: 'deny', reason: 'second denied' })
    h.body.mockImplementation(async (_args, exec) => {
      const request = nativeRequest(h, exec)
      expect(await h.ctx.approval.request(request)).toBe('allowed-once')
      expect(await h.ctx.approval.request(request)).toBe('rejected')
      return []
    })
    expect((await h.execute()).isError).toBe(false)
    expect(popup).toHaveBeenCalledTimes(2)
    expect(reviewer).toHaveBeenCalledTimes(stage === 'human' ? 0 : 2)
    expect(h.builtIn).not.toHaveBeenCalled()
  })

  it('does not reuse a grant across calls with the same finalised call id', async () => {
    const h = await harness()
    popup.mockResolvedValueOnce({ kind: 'allow' }).mockResolvedValueOnce({ kind: 'deny', reason: 'second denied' })
    const input = { name: 'implicit', callId: ToolCallId('reused') }
    expect((await h.execute(input)).isError).toBe(false)
    expect((await h.execute(input)).isError).toBe(true)
    expect(popup).toHaveBeenCalledTimes(2)
    expect(h.effect).toHaveBeenCalledOnce()
  })

  it('rejects concurrent pending approval for the same call without sharing its decision', async () => {
    const h = await harness()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    popup.mockImplementation(async () => { entered.resolve(); await release.promise; return { kind: 'allow' } })
    h.body.mockImplementation(async (_args, exec) => {
      const request = nativeRequest(h, exec)
      const first = h.ctx.approval.request(request)
      await entered.promise
      try { expect(await h.ctx.approval.request(request)).toBe('rejected') }
      finally { release.resolve() }
      expect(await first).toBe('allowed-once')
      return []
    })
    expect((await h.execute()).isError).toBe(false)
    expect(popup).toHaveBeenCalledOnce()
    expect(h.builtIn).not.toHaveBeenCalled()
  })

  it.each(['human', 'reviewer'] as const)('permission changes permanently cancel pending %s but not the caller signal', async stage => {
    const h = await harness()
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    if (stage === 'human') popup.mockImplementation(async (_runtime, _request, _config, signal) => { entered.resolve(signal); await release.promise; return { kind: 'allow' } })
    else reviewer.mockImplementation(async (_ctx, _exec, signal) => { entered.resolve(signal); await release.promise; return { kind: 'allow' } })
    const caller = new AbortController()
    const running = h.execute({ name: 'implicit', signal: caller.signal })
    const signal = await entered.promise
    setSandboxMode(h.session, 'read-only')
    setSandboxMode(h.session, 'workspace-write')
    expect(signal.aborted).toBe(true)
    expect(caller.signal.aborted).toBe(false)
    release.resolve()
    expect((await running).isError).toBe(true)
    expect(h.effect).not.toHaveBeenCalled()
    expectPolicy(h, 'workspace-write')
  })

  it('cancels pending approval after approval policy changes without restoring ask', async () => {
    const h = await harness()
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    popup.mockImplementation(async (_runtime, _request, _config, signal) => { entered.resolve(signal); await release.promise; return { kind: 'allow' } })
    const running = h.execute({ name: 'implicit' })
    const signal = await entered.promise
    setApprovalPolicy(h.session, 'never')
    expect(signal.aborted).toBe(true)
    release.resolve()
    expect((await running).isError).toBe(true)
    await h.plugin!.dispose()
    expectPolicy(h, 'workspace-write', 'never')
  })

  it.each(['caller', 'request'] as const)('links pending cancellation to the %s signal', async source => {
    const h = await harness()
    const caller = new AbortController()
    const request = new AbortController()
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    popup.mockImplementation(async (_runtime, _request, _config, signal) => { entered.resolve(signal); await release.promise; return { kind: 'allow' } })
    h.body.mockImplementation(async (_args, exec) => {
      expect(await h.ctx.approval.request({ ...nativeRequest(h, exec), signal: request.signal })).not.toBe('allowed-once')
      return []
    })
    const running = h.execute({ signal: caller.signal })
    const signal = await entered.promise
    ;(source === 'caller' ? caller : request).abort()
    expect(signal.aborted).toBe(true)
    release.resolve()
    await running
    expect(h.builtIn).not.toHaveBeenCalled()
  })

  it.each(['human', 'reviewer'] as const)('disposal aborts and drains only pending %s work', async stage => {
    const h = await harness()
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    if (stage === 'human') popup.mockImplementation(async (_runtime, _request, _config, signal) => { entered.resolve(signal); await release.promise; return { kind: 'allow' } })
    else reviewer.mockImplementation(async (_ctx, _exec, signal) => { entered.resolve(signal); await release.promise; return { kind: 'allow' } })
    const running = h.execute({ name: 'implicit' })
    const signal = await entered.promise
    const aborted = Promise.withResolvers<void>()
    signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    let disposed = false
    const disposing = h.plugin!.dispose().then(() => { disposed = true })
    try {
      await aborted.promise
      expect(disposed).toBe(false)
      expectPolicy(h, 'workspace-write')
    } finally { release.resolve() }
    await Promise.all([running, disposing])
    expect(h.effect).not.toHaveBeenCalled()
    expect(disposed).toBe(true)
  })

  it('disposes across a prepared gap without waiting for a result or cancelling the queued body', async () => {
    const h = await harness()
    const scheduler = h.ctx.tools[TOOL_RUNTIME_SCHEDULER]
    const prepared = await scheduler.prepare({ name: 'probe', arguments: {}, signal: new AbortController().signal, callId: ToolCallId('queued'), agent: h.agent })
    if (prepared.kind !== 'dispatch') throw new Error('Expected prepared dispatch')
    await h.plugin!.dispose()
    expect(prepared.exec.signal.aborted).toBe(false)
    try {
      const dispatched = await scheduler.dispatch(prepared.exec)
      expect(dispatched.result.isError).toBe(false)
      if (dispatched.kind === 'post-result') await scheduler.finalize(prepared.exec, dispatched.result)
      else scheduler.finish(prepared.exec, dispatched.result)
    } finally { finishPrepared(h, prepared.exec) }
    expect(h.effect).toHaveBeenCalledWith('workspace-write')
  })

  it.each([false, true])('neither cancels nor joins an entered body (already approved=%s)', async approved => {
    const h = await harness()
    popup.mockResolvedValue({ kind: 'allow' })
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    h.body.mockImplementation(async (_args, exec) => {
      if (approved) expect(await h.ctx.approval.request(nativeRequest(h, exec))).toBe('allowed-once')
      entered.resolve(exec.signal)
      await release.promise
      exec.signal.throwIfAborted()
      return []
    })
    const running = h.execute()
    const signal = await entered.promise
    try {
      await h.plugin!.dispose()
      expect(signal.aborted).toBe(false)
    } finally { release.resolve() }
    expect((await running).isError).toBe(false)
  })

  it('allows an approved tool body to await its own plugin disposal', async () => {
    const h = await harness()
    popup.mockResolvedValue({ kind: 'allow' })
    h.body.mockImplementation(async (_args, exec) => {
      expect(await h.ctx.approval.request(nativeRequest(h, exec))).toBe('allowed-once')
      await h.plugin!.dispose()
      expect(exec.signal.aborted).toBe(false)
      return []
    })
    expect((await h.execute()).isError).toBe(false)
  })

  it('allows existing and late external providers without restricting registration', async () => {
    const h = await harness({ external: true })
    expect(h.ctx.subagents.getProvider('external')).toBeDefined()
    expect(() => h.ctx.subagents.registerProvider(externalProvider('late'))).not.toThrow()
    expect(h.ctx.subagents.getProvider('late')).toBeDefined()
    expect((await h.execute()).isError).toBe(false)
  })

  it('still requires local subprocess for the native popup', async () => {
    const h = await harness({ enable: false, remoteSubprocess: true })
    await expect(h.enable()).rejects.toThrow('local subprocess provider')
    expectPolicy(h, 'workspace-write')
  })
})

describe('Composer mode admission snapshot', () => {
  it('delegates all native requests while off and restores interception for new calls', async () => {
    const h = await harness()
    await h.setMode(false)
    expect((await h.execute({ name: 'implicit' })).isError).toBe(false)
    expect(h.builtIn).toHaveBeenCalledOnce()
    expect(popup).not.toHaveBeenCalled()
    expect(reviewer).not.toHaveBeenCalled()
    await h.setMode(true)
    expect((await h.execute({ name: 'implicit' })).isError).toBe(false)
    expect(popup).toHaveBeenCalledOnce()
    expect(reviewer).toHaveBeenCalledOnce()
    expect(h.builtIn).toHaveBeenCalledOnce()
  })

  it.each([false, true])('keeps entry mode %s across the prepare/dispatch gap', async initial => {
    const h = await harness()
    await h.setMode(initial)
    const scheduler = h.ctx.tools[TOOL_RUNTIME_SCHEDULER]
    const prepared = await scheduler.prepare({ name: 'implicit', arguments: {}, signal: new AbortController().signal, callId: ToolCallId('toggle-gap'), agent: h.agent })
    if (prepared.kind !== 'dispatch') throw new Error('Expected prepared dispatch')
    let finalized = false
    try {
      await h.setMode(!initial)
      const dispatched = await scheduler.dispatch(prepared.exec)
      if (dispatched.kind === 'post-result') await scheduler.finalize(prepared.exec, dispatched.result)
      else scheduler.finish(prepared.exec, dispatched.result)
      finalized = true
      expect(dispatched.result.isError).toBe(false)
      expect(reviewer).toHaveBeenCalledTimes(initial ? 1 : 0)
      expect(popup).toHaveBeenCalledTimes(initial ? 1 : 0)
      expect(h.builtIn).toHaveBeenCalledTimes(initial ? 0 : 1)
    } finally { if (!finalized) finishPrepared(h, prepared.exec) }
  })

  it.each([false, true])('keeps native pre-execute ask admission across toggle from %s', async initial => {
    const h = await harness()
    await h.setMode(initial)
    h.ctx.on('tools/pre-execute', async () => {
      await h.setMode(!initial)
      return { kind: 'ask' as const, reason: 'ordinary question' }
    })
    expect((await h.execute()).isError).toBe(false)
    expect(h.builtIn).toHaveBeenCalledTimes(initial ? 0 : 1)
    expect(popup).toHaveBeenCalledTimes(initial ? 1 : 0)
    expect(reviewer).toHaveBeenCalledTimes(initial ? 1 : 0)
  })

  it('cleans the prior mode snapshot on result before call-id reuse', async () => {
    const h = await harness()
    const callId = ToolCallId('reused-native-id')
    await h.setMode(false)
    expect((await h.execute({ name: 'implicit', callId })).isError).toBe(false)
    await h.setMode(true)
    expect((await h.execute({ name: 'implicit', callId })).isError).toBe(false)
    expect(h.builtIn).toHaveBeenCalledOnce()
    expect(popup).toHaveBeenCalledOnce()
  })

  it('persists the last concurrent toggle through restart', async () => {
    const h = await harness()
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => h.setMode(index % 2 === 0)))
    expect(results.every(result => result.status === 'fulfilled')).toBe(true)
    expect(await h.rpcCall('/api/semi-auto.get', {})).toEqual({ enabled: false })
    await h.plugin!.dispose()
    await h.enable()
    expect(await h.rpcCall('/api/semi-auto.get', {})).toEqual({ enabled: false })
    expect((await h.execute({ name: 'implicit' })).isError).toBe(false)
    expect(h.builtIn).toHaveBeenCalledOnce()
    expect(popup).not.toHaveBeenCalled()
  })

  it('rejects a nonboolean toggle and leaves admission enabled', async () => {
    const h = await harness()
    await expect(h.rpcCall('/api/semi-auto.set', { enabled: 'yes' })).rejects.toThrow('payload.enabled must be a boolean')
    expect(await h.rpcCall('/api/semi-auto.get', {})).toEqual({ enabled: true })
    expect((await h.execute({ name: 'implicit' })).isError).toBe(false)
    expect(popup).toHaveBeenCalledOnce()
  })
})
