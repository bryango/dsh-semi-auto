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
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime, { NO_START_CAPABILITIES, type SubagentProvider } from '@deepseek-ai/dsh-subagent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, {
  defineContentToolFixture, RUN_CODE_NAME, TOOL_RUNTIME_SCHEDULER,
  type PreToolDecision, type ToolExecution, type ToolExecutionInput, type ToolExecutionToken, type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import * as SemiAuto from '../src/index.js'
import { isAutoReviewCandidate, reviewTool } from '../src/auto-review.js'
import { runPopup } from '../src/popup-runner.js'

// Only authorization I/O is mocked; candidate selection and all policy/execution services are real.
vi.mock('../src/auto-review.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/auto-review.js')>(), reviewTool: vi.fn(),
}))
vi.mock('../src/popup-runner.js', () => ({ runPopup: vi.fn() }))
const popup = vi.mocked(runPopup)
const reviewer = vi.mocked(reviewTool)
const contexts: Context[] = []
const CONFIG: SemiAuto.Config = {
  permissionPopupPath: '/test/permission-popup', popupTimeoutMs: 600000,
  processGraceMs: 1000, outputLimitBytes: 65536,
}
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
const WIDER = { sandbox_permissions: 'danger-full-access', justification: 'Perform the explicitly requested operation.' }

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
  // Match upstream executor tests: no full loop is needed for scoped identity or this fixture's open turn.
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
  const builtIn = vi.fn(async () => 'allowed-once' as const)
  ctx.on('approval/request', builtIn)
  const enable = async (): Promise<PluginHandle> => ctx.plugin(SemiAuto, CONFIG)
  const plugin = options.enable === false ? undefined : await enable()
  let call = 0
  const execute = (changes: Partial<ToolExecutionInput> = {}) => ctx.tools.execute({
    name: 'probe', arguments: {}, signal: new AbortController().signal,
    callId: ToolCallId(`call-${++call}`), agent, ...changes,
  })
  const setMode = async (enabled: boolean): Promise<void> => {
    await connection.call('/api/semi-auto.set', { enabled })
  }
  const rpcCall = (path: string, payload: unknown): Promise<unknown> => connection.call(path, payload)
  return { ctx, session, agent, body, effect, builtIn, plugin, enable, execute, setMode, rpcCall }
}
function externalProvider(name = 'external'): SubagentProvider {
  return { name, capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
    start: vi.fn(async () => { throw new Error('External process must not start') }) }
}
function decisionExecution(agent: Agent, name: string, args: Args = {}, parent?: ToolExecutionToken): ToolExecution {
  return {
    name, agent, callId: ToolCallId('waterfall'), rootCallId: ToolCallId('waterfall'),
    token: Symbol('waterfall fixture') as ToolExecutionToken,
    arguments: args, signal: new AbortController().signal, ...parent === undefined ? {} : { parent },
  }
}
function expectPolicy(h: Awaited<ReturnType<typeof harness>>, mode: string, policy = 'ask') {
  expect(h.ctx.sandboxPolicy.resolve({ session: h.session }).mode).toBe(mode)
  expect(h.ctx.approval.overrideOf(h.session)).toBe(policy)
}
function finishPrepared(h: Awaited<ReturnType<typeof harness>>, exec: ToolRunContext) {
  h.ctx.tools[TOOL_RUNTIME_SCHEDULER].finish(exec, { content: [], isError: true, error: { message: 'fixture cleanup' } })
}
const modeHomes: string[] = []
beforeEach(async () => {
  popup.mockReset().mockResolvedValue({ kind: 'allow' }); reviewer.mockReset().mockResolvedValue({ kind: 'allow' })
  // Keep the mode state off the developer's real ~/.dsh for every test here.
  modeHomes.push(await mkdtemp(join(tmpdir(), 'semi-auto-plugin-')))
  process.env.DSH_HOME = modeHomes[modeHomes.length - 1]
})
afterEach(async () => {
  delete process.env.DSH_HOME
  while (modeHomes.length) await rm(modeHomes.pop()!, { recursive: true, force: true })
  while (contexts.length) await contexts.pop()!.fiber.dispose(); vi.restoreAllMocks()
})

describe('Auto within the standing sandbox and popup only for native widening approval', () => {
  it.each(['read-only', 'workspace-write'] as const)('preserves native %s and ask through enable, new session and disable', async (mode) => {
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
  it('preserves a native never policy instead of enabling approval', async () => {
    const h = await harness({ enable: false })
    setApprovalPolicy(h.session, 'never')
    const plugin = await h.enable()
    expect((await h.execute({ arguments: WIDER })).isError).toBe(true)
    expect(popup).not.toHaveBeenCalled()
    expect(reviewer).not.toHaveBeenCalled()
    expect(h.builtIn).not.toHaveBeenCalled()
    expect(h.effect).not.toHaveBeenCalled()
    await plugin.dispose()
    expectPolicy(h, 'workspace-write', 'never')
  })
  it.each(['read-only', 'workspace-write'] as const)('Auto reviews normal %s calls without popup', async (mode) => {
    const h = await harness({ mode })
    expect((await h.execute()).isError).toBe(false)
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(popup).not.toHaveBeenCalled()
    expect(h.effect).toHaveBeenCalledWith(mode)
  })
  it.each([
    ['no escalation fields', {}],
    ['only sandbox_permissions', { sandbox_permissions: { type: 'string' as const } }],
    ['only justification', { justification: { type: 'string' as const } }],
  ] as const)('does not let wider extras bypass Auto on an ordinary tool declaring %s', async (_label, parameters) => {
    const h = await harness()
    const ordinaryBody = vi.fn(async (): Promise<ContentBlock[]> => [{ type: 'text', text: 'ordinary effect' }])
    h.ctx.tools.register(defineContentToolFixture({
      name: 'ordinary', description: 'Ignores unknown root arguments', parameters, execute: ordinaryBody,
    }))
    // Root schemas accept extra keys. Their names do not turn this tool into a
    // native widening operation or authorize skipping its ordinary Auto review.
    reviewer.mockResolvedValue({ kind: 'deny', reason: 'ordinary action rejected' })
    const result = await h.execute({ name: 'ordinary', arguments: WIDER })
    expect(result.isError).toBe(true)
    expect(reviewer).toHaveBeenCalledOnce()
    expect(reviewer.mock.calls[0]?.[1]).toMatchObject({ name: 'ordinary', arguments: WIDER })
    expect(ordinaryBody).not.toHaveBeenCalled()
    expect(popup).not.toHaveBeenCalled()
    expect(h.builtIn).not.toHaveBeenCalled()
  })
  it('allows an ordinary open-schema tool with wider extras only after Auto, without popup', async () => {
    const h = await harness()
    const ordinaryBody = vi.fn(async (): Promise<ContentBlock[]> => [{ type: 'text', text: 'ordinary effect' }])
    h.ctx.tools.register(defineContentToolFixture({
      name: 'ordinary', description: 'Ignores unknown root arguments', parameters: {}, execute: ordinaryBody,
    }))
    const result = await h.execute({ name: 'ordinary', arguments: WIDER })
    expect(result.isError).toBe(false)
    expect(reviewer).toHaveBeenCalledOnce()
    expect(ordinaryBody).toHaveBeenCalledOnce()
    expect(popup).not.toHaveBeenCalled()
    expect(h.builtIn).not.toHaveBeenCalled()
    expectPolicy(h, 'workspace-write')
  })
  it('Auto reviews native and PTC inner calls independently without popup', async () => {
    const h = await harness()
    await h.execute()
    const parent = Symbol('outer transport') as ToolExecutionToken
    await h.execute({ parent, rootCallId: ToolCallId('outer') })
    expect(reviewer).toHaveBeenCalledTimes(2)
    expect(reviewer.mock.calls[1]?.[1].parent).toBe(parent)
    expect(popup).not.toHaveBeenCalled()
  })
  it('skips only ordinary root run_code, including in the actual pre-execute waterfall', async () => {
    const h = await harness()
    const exec = decisionExecution(h.agent, RUN_CODE_NAME)
    const downstream = vi.fn(async (): Promise<PreToolDecision> => ({ kind: 'allow' }))
    expect(isAutoReviewCandidate(exec)).toBe(false)
    expect(await h.ctx.waterfall('tools/pre-execute', exec, downstream)).toEqual({ kind: 'allow' })
    h.ctx.emit('tools/result', exec, { content: [], value: null, isError: false })
    expect(popup).not.toHaveBeenCalled()
    expect(reviewer).not.toHaveBeenCalled()
    expect(downstream).toHaveBeenCalledOnce()
  })
  it('reviews the complete wider outer run_code after human approval, unlike ordinary outer transport', async () => {
    const h = await harness()
    // run_code is reserved and this harness has no PTC runtime. Supply only its
    // trusted schema lookup while exercising the real public waterfalls below.
    const get = h.ctx.tools.get.bind(h.ctx.tools)
    const transportDefinition = {
      ...get('probe', h.agent)!, name: RUN_CODE_NAME,
      parameters: {
        type: 'object',
        properties: { sandbox_permissions: { type: 'string' }, justification: { type: 'string' } },
      },
    }
    vi.spyOn(h.ctx.tools, 'get').mockImplementation((name, agent) => name === RUN_CODE_NAME
      ? transportDefinition : get(name, agent))
    const exec = decisionExecution(h.agent, RUN_CODE_NAME, WIDER)
    try {
      expect(await h.ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' }))).toEqual({ kind: 'allow' })
      const result = await h.ctx.waterfall('tools/execute', exec, async () => {
        const mode = await approveEscalation({
          requestedMode: WIDER.sandbox_permissions, justification: WIDER.justification,
          effectiveMode: 'workspace-write', subject: 'program',
        }, { approver: h.ctx.approval, agent: h.agent, callId: exec.callId, toolName: exec.name, signal: exec.signal })
        h.effect(mode)
        return { content: [], value: null, isError: false as const }
      })
      expect(result.isError).toBe(false)
      expect(popup).toHaveBeenCalledOnce()
      expect(reviewer).toHaveBeenCalledOnce()
      expect(reviewer.mock.calls[0]?.[1].name).toBe(RUN_CODE_NAME)
      expect(reviewer.mock.calls[0]?.[1].parent).toBeUndefined()
      expect(h.effect).toHaveBeenCalledWith('danger-full-access')
      expectPolicy(h, 'workspace-write')
    } finally {
      h.ctx.emit('tools/result', exec, { content: [], value: null, isError: false })
    }
  })
  it('makes ordinary Auto denial final without native or built-in approval', async () => {
    const h = await harness()
    reviewer.mockResolvedValue({ kind: 'deny', reason: 'reviewer refused' })
    expect((await h.execute()).isError).toBe(true)
    expect(h.body).not.toHaveBeenCalled()
    expect(h.builtIn).not.toHaveBeenCalled()
    expect(popup).not.toHaveBeenCalled()
  })
  it('defers wider-call review until native popup allows, then grants only the requested call', async () => {
    const h = await harness()
    const order: string[] = []
    popup.mockImplementation(async () => { order.push('human'); return { kind: 'allow' } })
    reviewer.mockImplementation(async () => { order.push('reviewer'); return { kind: 'allow' } })
    h.effect.mockImplementation(() => { order.push('effect') })
    expect((await h.execute({ arguments: WIDER })).isError).toBe(false)
    expect(order).toEqual(['human', 'reviewer', 'effect'])
    expect(reviewer).toHaveBeenCalledOnce()
    expect(popup).toHaveBeenCalledOnce()
    expect(h.effect).toHaveBeenCalledWith('danger-full-access')
    expectPolicy(h, 'workspace-write')
    expect(h.builtIn).not.toHaveBeenCalled()
    expect(h.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data)).toEqual([
      expect.objectContaining({ outcome: 'allowed-once' }),
    ])
    await h.execute()
    expect(h.effect).toHaveBeenLastCalledWith('workspace-write')
    expect(popup).toHaveBeenCalledOnce()
    expect(reviewer).toHaveBeenCalledTimes(2)
  })
  it('defers an abstaining popup to Auto and grants only the reviewed call', async () => {
    const h = await harness()
    popup.mockResolvedValue({ kind: 'no_decision' })
    expect((await h.execute({ arguments: WIDER })).isError).toBe(false)
    expect(reviewer).toHaveBeenCalledOnce()
    expect(h.effect).toHaveBeenCalledWith('danger-full-access')
    expect(h.builtIn).not.toHaveBeenCalled()
    expectPolicy(h, 'workspace-write')
    expect(h.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data)).toEqual([
      expect.objectContaining({ outcome: 'allowed-once' }),
    ])
    await h.execute({ arguments: WIDER })
    expect(reviewer).toHaveBeenCalledTimes(2)
    expect(popup).toHaveBeenCalledTimes(2)
    await h.execute()
    expect(h.effect).toHaveBeenLastCalledWith('workspace-write')
    expect(reviewer).toHaveBeenCalledTimes(3)
    expect(popup).toHaveBeenCalledTimes(2)
    expect(h.builtIn).not.toHaveBeenCalled()
  })
  it.each(['deny', 'failure', 'cancel'] as const)('does not grant an abstaining popup when Auto returns %s', async outcome => {
    const h = await harness()
    popup.mockResolvedValue({ kind: 'no_decision' })
    if (outcome === 'failure') reviewer.mockRejectedValue(new Error('review unavailable'))
    else if (outcome === 'cancel') reviewer.mockResolvedValue({ kind: 'cancel' })
    else reviewer.mockResolvedValue({ kind: 'deny', reason: 'review rejected' })
    expect((await h.execute({ arguments: WIDER })).isError).toBe(true)
    expect(reviewer).toHaveBeenCalledOnce()
    expect(h.effect).not.toHaveBeenCalled()
    expect(h.builtIn).not.toHaveBeenCalled()
    expectPolicy(h, 'workspace-write')
  })
  it('Authorize skips Auto for that wider call only, not future sandbox calls', async () => {
    const h = await harness()
    popup.mockResolvedValue({ kind: 'allow_direct' })
    expect((await h.execute({ arguments: WIDER })).isError).toBe(false)
    expect(reviewer).not.toHaveBeenCalled()
    expect(h.effect).toHaveBeenCalledWith('danger-full-access')
    await h.execute()
    expect(reviewer).toHaveBeenCalledOnce()
    expect(popup).toHaveBeenCalledOnce()
    expect(h.builtIn).not.toHaveBeenCalled()
  })
  it('handles read-only to workspace-write as a native strictly wider one-shot grant', async () => {
    const h = await harness({ mode: 'read-only' })
    expect((await h.execute({ arguments: { ...WIDER, sandbox_permissions: 'workspace-write' } })).isError).toBe(false)
    expect(h.effect).toHaveBeenCalledWith('workspace-write')
    expectPolicy(h, 'read-only')
    expect(popup).toHaveBeenCalledOnce()
    expect(reviewer).toHaveBeenCalledOnce()
  })
  it.each(['human', 'reviewer'] as const)('%s denial prevents the wider effect and built-in approval fallback', async (stage) => {
    const h = await harness()
    if (stage === 'human') popup.mockResolvedValue({ kind: 'deny', reason: 'no human authorization' })
    else reviewer.mockResolvedValue({ kind: 'deny', reason: 'no model authorization' })
    expect((await h.execute({ arguments: WIDER })).isError).toBe(true)
    expect(h.effect).not.toHaveBeenCalled()
    expect(h.builtIn).not.toHaveBeenCalled()
    expect(reviewer).toHaveBeenCalledTimes(stage === 'human' ? 0 : 1)
    expectPolicy(h, 'workspace-write')
  })
  it.each(['human', 'reviewer'] as const)('%s failure denies without falling through to built-in approval', async (stage) => {
    const h = await harness()
    if (stage === 'human') popup.mockRejectedValue(new Error('UI failed'))
    else reviewer.mockRejectedValue(new Error('review failed'))
    expect((await h.execute({ arguments: WIDER })).isError).toBe(true)
    expect(h.effect).not.toHaveBeenCalled()
    expect(h.builtIn).not.toHaveBeenCalled()
  })
  it('does not cache grants across calls, including reused call-id after final result', async () => {
    const h = await harness()
    popup.mockResolvedValueOnce({ kind: 'allow_direct' }).mockResolvedValueOnce({ kind: 'deny', reason: 'deny second' })
    const same = { arguments: WIDER, callId: ToolCallId('reused-id') }
    expect((await h.execute(same)).isError).toBe(false)
    expect((await h.execute(same)).isError).toBe(true)
    expect(popup).toHaveBeenCalledTimes(2)
    expect(h.effect).toHaveBeenCalledOnce()
  })
  it.each([
    { sandbox_permissions: 'workspace-write', justification: 'same mode' },
    { sandbox_permissions: 'read-only', justification: 'narrower mode' },
    { sandbox_permissions: 'danger-full-access' },
    { sandbox_permissions: 'danger-full-access', justification: '' },
  ])('does not popup for a nonwidening or invalid request %j', async (args) => {
    const h = await harness()
    await h.execute({ arguments: args })
    expect(popup).not.toHaveBeenCalled()
    expect(reviewer).toHaveBeenCalledOnce()
    expect(h.builtIn).not.toHaveBeenCalled()
  })
  it('rejects unmatched native approval rather than displaying a second built-in dialog', async () => {
    const h = await harness()
    expect(await h.ctx.approval.request({ agent: h.agent, toolName: 'probe', callId: ToolCallId('missing') })).toBe('rejected')
    expect(popup).not.toHaveBeenCalled()
    expect(reviewer).not.toHaveBeenCalled()
    expect(h.builtIn).not.toHaveBeenCalled()
  })
  it.each(['name', 'call-id', 'agent', 'missing-id'] as const)('rejects a mismatched %s approval during an escalating dispatch', async (mismatch) => {
    const h = await harness()
    h.body.mockImplementation(async (_args, exec) => {
      const other = { ...h.agent, id: SessionId('different-agent') } as Agent
      const outcome = await h.ctx.approval.request({
        agent: mismatch === 'agent' ? other : h.agent,
        toolName: mismatch === 'name' ? 'different-tool' : exec.name,
        ...mismatch === 'missing-id' ? {} : { callId: mismatch === 'call-id' ? ToolCallId('different-call') : exec.callId },
        signal: exec.signal,
      })
      expect(outcome).toBe('rejected')
      return []
    })
    expect((await h.execute({ arguments: WIDER })).isError).toBe(false)
    expect(popup).not.toHaveBeenCalled()
    expect(reviewer).not.toHaveBeenCalled()
    expect(h.builtIn).not.toHaveBeenCalled()
  })
  it('rejects an approval from an ordinary nonwidening dispatch without opening popup', async () => {
    const h = await harness()
    h.body.mockImplementation(async (_args, exec) => {
      expect(await h.ctx.approval.request({ agent: h.agent, toolName: exec.name, callId: exec.callId, signal: exec.signal })).toBe('rejected')
      return []
    })
    expect((await h.execute()).isError).toBe(false)
    expect(reviewer).toHaveBeenCalledOnce()
    expect(popup).not.toHaveBeenCalled()
    expect(h.builtIn).not.toHaveBeenCalled()
  })
  it('rejects a native approval before actual dispatch even for a valid wider call', async () => {
    const h = await harness()
    const scheduler = h.ctx.tools[TOOL_RUNTIME_SCHEDULER]
    const prepared = await scheduler.prepare({ name: 'probe', arguments: WIDER, signal: new AbortController().signal, callId: ToolCallId('prepared'), agent: h.agent })
    if (prepared.kind !== 'dispatch') throw new Error('Expected deferred-review dispatch')
    try {
      expect(await h.ctx.approval.request({ agent: h.agent, toolName: 'probe', callId: prepared.exec.callId })).toBe('rejected')
      expect(popup).not.toHaveBeenCalled()
    } finally { finishPrepared(h, prepared.exec) }
  })
  it('rejects an ambiguous in-flight call identity before a second tool can dispatch', async () => {
    const h = await harness()
    const scheduler = h.ctx.tools[TOOL_RUNTIME_SCHEDULER]
    const input = { name: 'probe', arguments: WIDER, signal: new AbortController().signal, callId: ToolCallId('shared-live-id'), agent: h.agent }
    const first = await scheduler.prepare(input)
    if (first.kind !== 'dispatch') throw new Error('Expected first valid deferred-review dispatch')
    try {
      expect((await h.execute(input)).isError).toBe(true)
      expect(h.body).not.toHaveBeenCalled()
      expect(popup).not.toHaveBeenCalled()
    } finally { finishPrepared(h, first.exec) }
  })
  it('does not reuse a grant for a second approval from the same dispatch', async () => {
    const h = await harness()
    popup.mockResolvedValue({ kind: 'allow_direct' })
    h.body.mockImplementation(async (_args, exec) => {
      const request = { agent: h.agent, toolName: exec.name, callId: exec.callId, signal: exec.signal }
      expect(await h.ctx.approval.request(request)).toBe('allowed-once')
      expect(await h.ctx.approval.request(request)).toBe('rejected')
      return []
    })
    expect((await h.execute({ arguments: WIDER })).isError).toBe(false)
    expect(popup).toHaveBeenCalledOnce()
    expect(h.builtIn).not.toHaveBeenCalled()
  })
  it('rejects duplicate simultaneous native approval requests rather than reusing an in-flight decision', async () => {
    const h = await harness()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    popup.mockImplementation(async () => { entered.resolve(); await release.promise; return { kind: 'allow_direct' } })
    h.body.mockImplementation(async (_args, exec) => {
      const request = { agent: h.agent, toolName: exec.name, callId: exec.callId, signal: exec.signal }
      const first = h.ctx.approval.request(request)
      await entered.promise
      try { expect(await h.ctx.approval.request(request)).toBe('rejected') }
      finally { release.resolve() }
      expect(await first).toBe('allowed-once')
      return []
    })
    expect((await h.execute({ arguments: WIDER })).isError).toBe(false)
    expect(popup).toHaveBeenCalledOnce()
    expect(h.builtIn).not.toHaveBeenCalled()
  })
  it('does not permit a later prepended allow listener to bypass Auto admission', async () => {
    const h = await harness()
    h.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })
    expect((await h.execute()).isError).toBe(true)
    expect(h.body).not.toHaveBeenCalled()
    expect(reviewer).not.toHaveBeenCalled()
  })
  it.each(['allow', 'deny'] as const)('preserves downstream %s policy without adding a popup', async (decision) => {
    const h = await harness()
    h.ctx.on('tools/pre-execute', async (): Promise<PreToolDecision> => decision === 'allow' ? { kind: 'allow' } : { kind: 'deny', reason: 'downstream denied' })
    expect((await h.execute()).isError).toBe(decision === 'deny')
    expect(reviewer).toHaveBeenCalledOnce()
    expect(popup).not.toHaveBeenCalled()
    expect(h.effect).toHaveBeenCalledTimes(decision === 'allow' ? 1 : 0)
  })
  it('denies a downstream ask without creating popup or falling back to built-in UI', async () => {
    const h = await harness()
    h.ctx.on('tools/pre-execute', async (): Promise<PreToolDecision> => ({ kind: 'ask', reason: 'independent policy question' }))
    expect((await h.execute()).isError).toBe(true)
    expect(reviewer).toHaveBeenCalledOnce()
    expect(popup).not.toHaveBeenCalled()
    expect(h.builtIn).not.toHaveBeenCalled()
    expect(h.body).not.toHaveBeenCalled()
  })
  it('rejects an agentless call before any authorization or body', async () => {
    const h = await harness()
    expect((await h.execute({ agent: undefined })).isError).toBe(true)
    expect(reviewer).not.toHaveBeenCalled()
    expect(popup).not.toHaveBeenCalled()
    expect(h.body).not.toHaveBeenCalled()
  })
  it('still applies independent monotonic guards to an escalating call', async () => {
    const h = await harness()
    h.ctx.tools.guard(() => 'another guard denied')
    expect((await h.execute({ arguments: WIDER })).isError).toBe(true)
    expect(popup).not.toHaveBeenCalled()
    expect(reviewer).not.toHaveBeenCalled()
    expect(h.body).not.toHaveBeenCalled()
  })
  it('rejects standing full access before Auto, popup or tool execution', async () => {
    const h = await harness()
    setSandboxMode(h.session, 'danger-full-access')
    expect((await h.execute()).isError).toBe(true)
    expect(popup).not.toHaveBeenCalled()
    expect(reviewer).not.toHaveBeenCalled()
    expect(h.body).not.toHaveBeenCalled()
  })
  it.each(['human', 'reviewer'] as const)('permission changes permanently cancel a pending %s decision', async (stage) => {
    const h = await harness()
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    if (stage === 'human') popup.mockImplementation(async (_runtime, _request, _config, signal) => { entered.resolve(signal); await release.promise; return { kind: 'allow' } })
    else reviewer.mockImplementation(async (_ctx, _exec, signal) => { entered.resolve(signal); await release.promise; return { kind: 'allow' } })
    const running = h.execute(stage === 'human' ? { arguments: WIDER } : {})
    const signal = await entered.promise
    setSandboxMode(h.session, 'read-only')
    setSandboxMode(h.session, 'workspace-write')
    expect(signal.aborted).toBe(true)
    release.resolve()
    expect((await running).isError).toBe(true)
    expect(h.effect).not.toHaveBeenCalled()
    expectPolicy(h, 'workspace-write')
  })
  it('an approval-policy switch cancels pending human authorization without restoring ask', async () => {
    const h = await harness()
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    popup.mockImplementation(async (_runtime, _request, _config, signal) => { entered.resolve(signal); await release.promise; return { kind: 'allow_direct' } })
    const running = h.execute({ arguments: WIDER })
    const signal = await entered.promise
    setApprovalPolicy(h.session, 'never')
    expect(signal.aborted).toBe(true)
    release.resolve()
    expect((await running).isError).toBe(true)
    expect(h.effect).not.toHaveBeenCalled()
    expectPolicy(h, 'workspace-write', 'never')
    await h.plugin!.dispose()
    expectPolicy(h, 'workspace-write', 'never')
  })
  it('rechecks policy changes in an earlier execute wrapper before entering the tool body', async () => {
    const h = await harness({ enable: false })
    h.ctx.on('tools/execute', async (_exec, next) => {
      setSandboxMode(h.session, 'danger-full-access')
      return next()
    })
    const plugin = await h.enable()
    expect((await h.execute()).isError).toBe(true)
    expect(h.body).not.toHaveBeenCalled()
    expect(popup).not.toHaveBeenCalled()
    await plugin.dispose()
    expectPolicy(h, 'danger-full-access')
  })
  it.each(['human', 'reviewer'] as const)('disposal cancels and drains pending %s before removing enforcement', async (stage) => {
    const h = await harness()
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    if (stage === 'human') popup.mockImplementation(async (_runtime, _request, _config, signal) => { entered.resolve(signal); await release.promise; return { kind: 'allow_direct' } })
    else reviewer.mockImplementation(async (_ctx, _exec, signal) => { entered.resolve(signal); await release.promise; return { kind: 'allow' } })
    const running = h.execute(stage === 'human' ? { arguments: WIDER } : {})
    const signal = await entered.promise
    const aborted = Promise.withResolvers<void>()
    signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    let disposed = false
    const disposing = h.plugin!.dispose().then(() => { disposed = true })
    await aborted.promise
    expect(signal.aborted).toBe(true)
    expect(disposed).toBe(false)
    expectPolicy(h, 'workspace-write')
    release.resolve()
    await Promise.all([running, disposing])
    expect(h.effect).not.toHaveBeenCalled()
    expect(disposed).toBe(true)
    expectPolicy(h, 'workspace-write')
  })
  it('keeps caller cancellation attached to pending native approval', async () => {
    const h = await harness()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    popup.mockImplementation(async () => { entered.resolve(); await release.promise; return { kind: 'allow_direct' } })
    const controller = new AbortController()
    const running = h.execute({ arguments: WIDER, signal: controller.signal })
    await entered.promise
    controller.abort()
    release.resolve()
    expect((await running).isError).toBe(true)
    expect(h.effect).not.toHaveBeenCalled()
    expect(h.builtIn).not.toHaveBeenCalled()
  })
  it('holds disposal across the real scheduler prepare/dispatch gap until the final result', async () => {
    const h = await harness()
    const scheduler = h.ctx.tools[TOOL_RUNTIME_SCHEDULER]
    const prepared = await scheduler.prepare({ name: 'probe', arguments: {}, signal: new AbortController().signal, callId: ToolCallId('queued'), agent: h.agent })
    if (prepared.kind !== 'dispatch') throw new Error('Expected authorized dispatch')
    let disposed = false
    const disposing = h.plugin!.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    let finalized = false
    try {
      const dispatched = await scheduler.dispatch(prepared.exec)
      expect(dispatched.result.isError).toBe(true)
      if (dispatched.kind === 'post-result') await scheduler.finalize(prepared.exec, dispatched.result)
      else scheduler.finish(prepared.exec, dispatched.result)
      finalized = true
    } finally {
      if (!finalized) finishPrepared(h, prepared.exec)
      await disposing
    }
    expect(h.effect).not.toHaveBeenCalled()
    expectPolicy(h, 'workspace-write')
  })
  it('fuses cancellation into actual body and waits for cooperative body settlement', async () => {
    const h = await harness()
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    h.body.mockImplementation(async (_args, exec) => { entered.resolve(exec.signal); await release.promise; return [] })
    const running = h.execute()
    const signal = await entered.promise
    let disposed = false
    const disposing = h.plugin!.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(signal.aborted).toBe(true)
    expect(disposed).toBe(false)
    release.resolve()
    await Promise.all([running, disposing])
    expect(disposed).toBe(true)
    expectPolicy(h, 'workspace-write')
  })
  it('does not write native policies when the plugin is removed after an independent selection', async () => {
    const h = await harness()
    h.ctx.permissionPresets.set(h.session, 'read-only')
    const before = h.session.snapshotEvents().length
    await h.plugin!.dispose()
    expectPolicy(h, 'read-only')
    expect(h.session.snapshotEvents().length).toBe(before)
  })
  it('refuses nonlocal subprocess activation before changing any policies', async () => {
    const h = await harness({ enable: false, remoteSubprocess: true })
    await expect(h.enable()).rejects.toThrow('local subprocess provider')
    expectPolicy(h, 'workspace-write')
  })
  it('refuses existing external providers and rolls back late external provider registration', async () => {
    const disabled = await harness({ enable: false, external: true })
    await expect(disabled.enable()).rejects.toThrow('external subagent provider')
    expectPolicy(disabled, 'workspace-write')
    const h = await harness()
    expect(() => h.ctx.subagents.registerProvider(externalProvider('late'))).toThrow('external subagent provider')
    expect(h.ctx.subagents.getProvider('late')).toBeUndefined()
    await h.plugin!.dispose()
    expect(() => h.ctx.subagents.registerProvider(externalProvider('after-disable'))).not.toThrow()
  })
})

describe('Composer mode toggle', () => {
  it('passes every call through the native approval without popup or review while off', async () => {
    const h = await harness()
    await h.setMode(false)
    popup.mockImplementation(async () => { throw new Error('popup must not run while off') })
    reviewer.mockImplementation(async () => { throw new Error('reviewer must not run while off') })
    expect((await h.execute({ arguments: WIDER })).isError).toBe(false)
    expect(h.effect).toHaveBeenCalledWith('danger-full-access')
    expect(h.builtIn).toHaveBeenCalledOnce()
    expectPolicy(h, 'workspace-write')
    await h.execute()
    expect(h.effect).toHaveBeenLastCalledWith('workspace-write')
  })

  it('flipping the mode back on restores popup and review for new calls', async () => {
    const h = await harness()
    await h.setMode(false)
    expect((await h.execute({ arguments: WIDER })).isError).toBe(false)
    expect(h.builtIn).toHaveBeenCalledOnce()
    await h.setMode(true)
    expect((await h.execute({ arguments: WIDER })).isError).toBe(false)
    expect(popup).toHaveBeenCalledOnce()
    expect(reviewer).toHaveBeenCalledOnce()
    expect(h.builtIn).toHaveBeenCalledOnce()
  })

  it('reports the current mode through the get endpoint', async () => {
    const h = await harness()
    await h.setMode(false)
    expect(await h.rpcCall('/api/semi-auto.get', {})).toEqual({ enabled: false })
    await h.setMode(true)
    expect(await h.rpcCall('/api/semi-auto.get', {})).toEqual({ enabled: true })
  })

  it('rejects a non-boolean set payload and keeps the current mode', async () => {
    const h = await harness()
    await expect(h.rpcCall('/api/semi-auto.set', { enabled: 'yes' }))
      .rejects.toThrow('payload.enabled must be a boolean')
    expect((await h.execute({ arguments: WIDER })).isError).toBe(false)
    expect(popup).toHaveBeenCalledOnce()
  })

  it('survives a plugin restart with the persisted off mode', async () => {
    const h = await harness()
    await h.setMode(false)
    await h.plugin!.dispose()
    await h.enable()
    popup.mockImplementation(async () => { throw new Error('popup must not run while off') })
    expect((await h.execute({ arguments: WIDER })).isError).toBe(false)
    expect(h.builtIn).toHaveBeenCalledOnce()
    expect(h.effect).toHaveBeenCalledWith('danger-full-access')
  })
})
