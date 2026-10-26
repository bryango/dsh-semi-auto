import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, {
  createMessage,
  createUserMessage,
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type MessageSource,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, {
  defineContentToolFixture,
  RUN_CODE_NAME,
  type PreToolDecision,
  type ToolExecution,
  type ToolExecutionInput,
  type ToolExecutionToken,
} from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { isAutoReviewCandidate, reviewTool } from '../src/auto-review.js'

const schema: ToolSchema = {
  name: 'probe',
  description: 'Logged probe description',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}

type Response = string | ((options: GenerateOptions) => AsyncIterable<StreamChunk>)

function chunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly response: Response) { super() }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (typeof this.response === 'string') yield* chunks(this.response)
    else yield* this.response(options)
  }
}

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function fixture(response: Response = '{"risk":"low","decision":"allow"}') {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRuntime)
  // Deliberately use ask: the adapted reviewer must never turn a denial into an ask.
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  const ask = vi.spyOn(ctx.approval, 'request')
  ctx.provide('workingDirectory', {
    async ensure(agent: Agent, signal: AbortSignal) {
      signal.throwIfAborted()
      return agent.session.header.cwd ?? '/workspace'
    },
  })
  const adapter = new RecordingAdapter(response)
  ctx.llm.registerAdapter(['review-provider'], adapter)
  let runs = 0
  ctx.tools.register(defineContentToolFixture({
    name: schema.name,
    description: 'Live description is not the logged schema',
    parameters: { path: { type: 'string' } },
    async execute() {
      runs += 1
      return [{ type: 'text', text: 'executed' }]
    },
  }))
  const lifetime = new AbortController()
  const decisions: PreToolDecision[] = []
  const executions: ToolExecution[] = []
  ctx.on('tools/pre-execute', async (exec, next) => {
    executions.push(exec)
    if (!isAutoReviewCandidate(exec)) return next()
    const decision = await reviewTool(ctx, exec, lifetime.signal)
    decisions.push(decision)
    return decision.kind === 'allow' ? next() : decision
  })
  const session = ctx.sessions.create(SessionId('review-fixture'), { meta: { cwd: '/workspace/project' } })
  // The reviewer reads logged Session facts, not live agent options or an agent loop.
  const agent = {
    id: session.id,
    session,
    options: { provider: 'obsolete-live-provider', model: 'obsolete-live-model' },
  } as Agent
  const execute = (input: Partial<ToolExecutionInput> = {}) => ctx.tools.execute({
    agent,
    name: schema.name,
    callId: ToolCallId('pending'),
    arguments: { path: 'inside' },
    signal: new AbortController().signal,
    ...input,
  })
  return { ctx, session, agent, adapter, ask, lifetime, decisions, executions, execute, runs: () => runs }
}

function header(session: Session, tools: ToolSchema[] = [schema], model = 'logged-model'): void {
  session.append('request/header', {
    header: { config: { provider: 'review-provider', model }, ...(tools.length === 0 ? {} : { tools }) },
    reason: session.requestHeader() === undefined ? 'initial' : 'change',
  })
}

function user(session: Session, text: string, source: MessageSource): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source }), { surfaceOp: 'append' })
}

function loggedCall(session: Session, name = schema.name, callId = ToolCallId('pending'), args = '{"path":"inside"}'): void {
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: createMessage({
      role: 'assistant',
      source: { kind: 'model', provider: 'review-provider', model: 'logged-model' },
      content: [
        { type: 'reasoning', text: 'private assistant reasoning' },
        { type: 'tool-call', id: callId, name, arguments: args },
      ],
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: args })
}

function sections(request: GenerateOptions): Record<string, unknown> {
  const body = request.messages[0]?.content[0]
  if (body?.type !== 'text') throw new Error('Missing reviewer text')
  const labels = ['ENVIRONMENT', 'PROJECT_INSTRUCTIONS', 'FILTERED_HISTORY', 'PENDING_ACTION']
  return Object.fromEntries(labels.map((label, index) => {
    const start = body.text.indexOf(`${label}\n`)
    if (start < 0) throw new Error(`Missing reviewer section ${label}`)
    const next = labels[index + 1]
    const end = next === undefined ? body.text.length : body.text.indexOf(`\n\n${next}\n`, start)
    return [label, JSON.parse(body.text.slice(start + label.length + 1, end)) as unknown]
  }))
}

describe('adapted official Auto reviewer', () => {
  it('uses the latest logged route and reconstructs native action and source roles', async () => {
    const f = await fixture()
    header(f.session, [schema], 'old-model')
    header(f.session)
    const human = { kind: 'user' as const, rpcId: 'browser-request' }
    user(f.session, 'Human authorization', human)
    user(f.session, 'Unattributed evidence', { kind: 'user' })
    user(f.session, 'Project restriction', { kind: 'agent-instructions', form: 'instructions', changes: [] })
    loggedCall(f.session)

    expect((await f.execute()).isError).toBe(false)
    expect(f.runs()).toBe(1)
    expect(f.decisions).toEqual([{ kind: 'allow' }])
    expect(f.adapter.requests).toHaveLength(1)
    const request = f.adapter.requests[0]!
    expect(request).toMatchObject({ provider: 'review-provider', model: 'logged-model', temperature: 0 })
    expect(request.tools).toBeUndefined()
    expect(request.system).toContain('REVIEW_POLICY')
    const input = sections(request)
    expect(input.ENVIRONMENT).toEqual({ cwd: '/workspace/project' })
    expect(input.PENDING_ACTION).toEqual({ mode: 'native', ...schema, arguments: { path: 'inside' } })
    expect(input.FILTERED_HISTORY).toEqual([
      expect.objectContaining({ role: 'human-instruction', content: [{ type: 'text', text: 'Human authorization' }] }),
      expect.objectContaining({ role: 'fact', content: [{ type: 'text', text: 'Unattributed evidence' }] }),
    ])
    expect(input.PROJECT_INSTRUCTIONS).toEqual([
      expect.objectContaining({ role: 'constraint', content: [{ type: 'text', text: 'Project restriction' }] }),
    ])
    expect(JSON.stringify(input)).not.toContain('private assistant reasoning')
    expect(f.ask).not.toHaveBeenCalled()
  })

  it('returns final structured denial even when built-in approval policy is ask', async () => {
    const f = await fixture('{"risk":"medium","decision":"deny","reason":"Not authorized"}')
    header(f.session)
    loggedCall(f.session)
    const result = await f.execute()
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'AUTO_REVIEW_DENIED', reason: 'Not authorized' } } })
    expect(f.decisions).toEqual([expect.objectContaining({ kind: 'deny' })])
    expect(f.runs()).toBe(0)
    expect(f.ask).not.toHaveBeenCalled()
  })

  it.each([
    'not JSON',
    '{"risk":"high","decision":"allow"}',
    '{"risk":"low","decision":"allow","reason":"extra field"}',
    '{"risk":"low","decision":"allow","decision":"allow"}',
  ])('fails closed for malformed reviewer output: %s', async (response) => {
    const f = await fixture(response)
    header(f.session)
    loggedCall(f.session)
    expect(await f.execute()).toMatchObject({ isError: true, error: { message: expect.stringContaining('Auto review of tool "probe" failed') } })
    expect(f.runs()).toBe(0)
    expect(f.ask).not.toHaveBeenCalled()
  })

  it('excludes agentless calls and outer run_code but not nested tool calls', async () => {
    const f = await fixture()
    header(f.session)
    loggedCall(f.session)
    await f.execute()
    const exec = f.executions[0]!
    expect(isAutoReviewCandidate(exec)).toBe(true)
    expect(isAutoReviewCandidate({ ...exec, agent: undefined })).toBe(false)
    expect(isAutoReviewCandidate({ ...exec, name: RUN_CODE_NAME, parent: undefined })).toBe(false)
    expect(isAutoReviewCandidate({ ...exec, name: RUN_CODE_NAME, parent: exec.token })).toBe(true)
  })

  it('reconstructs one started PTC inner call using its binding schema', async () => {
    const f = await fixture()
    header(f.session, [])
    const rootCallId = ToolCallId('outer')
    const callId = ToolCallId('outer:ptc:0')
    loggedCall(f.session, RUN_CODE_NAME, rootCallId, '{"code":"probe()"}')
    f.session.append('tool/ptc-dispatch-start', {
      rootCallId, parentCallId: rootCallId, subCallId: callId,
      name: schema.name, arguments: { path: 'inside' },
    })
    expect((await f.execute({ rootCallId, callId, parent: Symbol('outer') as ToolExecutionToken, schema })).isError).toBe(false)
    expect(f.runs()).toBe(1)
    expect(f.adapter.requests).toHaveLength(1)
    const input = sections(f.adapter.requests[0]!)
    expect(input.PENDING_ACTION).toEqual({ mode: 'ptc-inner', ...schema, arguments: { path: 'inside' } })
    expect(input.FILTERED_HISTORY).toEqual([
      expect.objectContaining({ kind: 'tool-call', role: 'fact', mode: 'native', name: RUN_CODE_NAME, arguments: '{"code":"probe()"}' }),
    ])
    expect(f.ask).not.toHaveBeenCalled()
  })

  it('rejects a PTC call whose started record does not match its actual arguments', async () => {
    const f = await fixture()
    header(f.session, [])
    const rootCallId = ToolCallId('outer')
    const callId = ToolCallId('outer:ptc:0')
    loggedCall(f.session, RUN_CODE_NAME, rootCallId, '{"code":"probe()"}')
    f.session.append('tool/ptc-dispatch-start', {
      rootCallId, parentCallId: rootCallId, subCallId: callId,
      name: schema.name, arguments: { path: 'different' },
    })
    expect((await f.execute({ rootCallId, callId, parent: Symbol('outer') as ToolExecutionToken, schema })).isError).toBe(true)
    expect(f.adapter.requests).toHaveLength(0)
    expect(f.runs()).toBe(0)
  })

  it('cancels an in-flight reviewer without asking or executing', async () => {
    const entered = Promise.withResolvers<GenerateOptions>()
    const f = await fixture(async function* (options) {
      entered.resolve(options)
      const signal = options.signal!
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      throw new Error('Adapter stopped after cancellation')
    })
    header(f.session)
    loggedCall(f.session)
    const execution = f.execute()
    const request = await entered.promise
    f.lifetime.abort(new Error('Review cancelled'))
    expect(request.signal?.aborted).toBe(true)
    expect((await execution).isError).toBe(true)
    expect(f.decisions).toEqual([{ kind: 'cancel' }])
    expect(f.runs()).toBe(0)
    expect(f.ask).not.toHaveBeenCalled()
  })
})
