/** Auto-review sandboxed calls; show the native popup only for one-shot widening requests. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subprocess'
import { WIDER_MODES } from '@deepseek-ai/dsh-sandbox'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-working-directory'
import { isAutoReviewCandidate, reviewTool } from './auto-review.js'
import { readModeFileSync, writeModeFile } from './mode.js'
import { runPopup } from './popup-runner.js'
import { registerModeRpc, type ModeRpc } from './rpc.js'

export const name = 'semi-auto'
export const inject = ['approval', 'llm', 'permissionPresets', 'sandboxPolicy', 'sessions', 'subagents', 'subprocess', 'tools', 'workingDirectory']

/** Trusted host UI configuration; agent tool arguments cannot change it. */
export interface Config {
  permissionPopupPath: string
  popupTimeoutMs: number
  processGraceMs: number
  outputLimitBytes: number
}

export const Config: z<Config> = z.object({
  permissionPopupPath: z.string().required(),
  popupTimeoutMs: z.number().min(1).max(2147483647).step(1).default(600000),
  processGraceMs: z.number().min(1).max(60000).step(1).default(1000),
  outputLimitBytes: z.number().min(256).max(1048576).step(1).default(65536),
})

interface Operation {
  controller: AbortController
  done: Promise<void>
  resolve: () => void
  authorized: boolean
  phase: 'review' | 'prepared' | 'dispatch'
  wider: boolean
  approvalClaimed: boolean
}

/** Install review and an exclusive native approval answerer without changing session policy. */
export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.permissionPopupPath)) throw new Error('semi-auto: permissionPopupPath must be absolute')
  const sandbox = ctx.sandboxPolicy
  const tools = ctx.tools
  const subprocess = ctx.subprocess
  const directory = ctx.workingDirectory
  if (!(subprocess instanceof LocalSubprocessRuntime)) {
    throw new Error('semi-auto: the native popup requires the local subprocess provider')
  }
  const assertLocalProvider = (provider: { name: string; prepareContinuable?: unknown }): void => {
    if (typeof provider.prepareContinuable !== 'function') {
      throw new Error(`semi-auto: external subagent provider "${provider.name}" is not supported; disable it before enabling this plugin`)
    }
  }
  for (const providerName of ctx.subagents.list()) {
    const provider = ctx.subagents.getProvider(providerName)
    if (provider !== undefined) assertLocalProvider(provider)
  }

  let accepting = true
  let enabled = readModeFileSync()
  const rpc: ModeRpc = {
    getEnabled: () => enabled,
    // The flip applies immediately; the write settles before the RPC response,
    // so a restart after a successful toggle reads the flipped mode.
    setEnabled: value => {
      enabled = value
      return writeModeFile(value)
    },
  }
  const lifecycle = new AbortController()
  const active = new Set<Promise<void>>()
  const operations = new Map<ToolExecution, Operation>()
  const failure = (exec: ToolExecution): string | undefined => {
    if (!accepting || lifecycle.signal.aborted) return 'Semi Auto is stopping; retry after it has finished disabling.'
    if (exec.agent === undefined) return 'Semi Auto requires an agent-owned execution.'
    const mode = sandbox.resolve({ session: exec.agent.session }).mode
    if (mode !== 'read-only' && mode !== 'workspace-write') return 'Semi Auto requires a native read-only or workspace-write sandbox; standing full access is not supported.'
    return undefined
  }
  const isWidening = (exec: ToolExecution): boolean => {
    if (exec.agent === undefined || typeof exec.arguments !== 'object' || exec.arguments === null) return false
    // Root tool schemas accept unknown arguments. Only a trusted definition
    // declaring the native escalation pair can defer Auto to its approval ask.
    const parameters = tools.get(exec.name, exec.agent)?.parameters.properties
    if (typeof parameters !== 'object' || parameters === null || !Object.hasOwn(parameters, 'sandbox_permissions')
      || !Object.hasOwn(parameters, 'justification')) return false
    if (!('sandbox_permissions' in exec.arguments) || !('justification' in exec.arguments)) return false
    const { sandbox_permissions: target, justification } = exec.arguments
    const mode = sandbox.resolve({ session: exec.agent.session }).mode
    return typeof target === 'string' && typeof justification === 'string' && justification.trim() !== ''
      && (WIDER_MODES[mode]?.some(candidate => candidate === target) ?? false)
  }
  const release = (exec: ToolExecution): void => {
    const operation = operations.get(exec)
    operations.delete(exec)
    operation?.resolve()
  }
  const audit = (exec: ToolExecution, result: string): void => {
    ctx.logger.info('semi-auto: session=%s call=%s tool=%s result=%s', exec.agent?.session.id, exec.callId, exec.name, result)
  }

  ctx.effect(function* () {
    yield ctx.on('subagent/provider-added', assertLocalProvider, { prepend: true })
    yield tools.guard(exec => {
      if (!enabled) return undefined
      return failure(exec) ?? (operations.get(exec)?.authorized ? undefined : 'Semi Auto review did not complete for this call.')
    })
    yield ctx.on('tools/result', exec => { release(exec) })
    const releaseOrphans = (agent: ToolExecution['agent']): void => {
      for (const [exec, operation] of operations) {
        if (exec.agent !== agent) continue
        operation.controller.abort(new Error('Semi Auto owning agent settled'))
        release(exec)
      }
    }
    yield ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') releaseOrphans(agent) })
    yield ctx.on('agent/disposed', ({ agent }) => { releaseOrphans(agent) })
    yield ctx.on('session/event', (session, event) => {
      if (event.type !== 'sandbox/mode' && event.type !== 'approval/policy') return
      for (const [exec, operation] of operations) {
        if (exec.agent?.session === session) operation.controller.abort(new Error('Semi Auto permissions changed'))
      }
    })
    yield ctx.on('approval/request', async (request, next): Promise<ApprovalOutcome> => {
      // Off mode restores the native approval chain untouched.
      if (!enabled) return next()
      // Native ApprovalService owns the ask/decision audit and rejects never
      // before answerer dispatch. Do not call next(): there is one human UI.
      const matches = [...operations].filter(([exec, operation]) => exec.agent === request.agent
        && exec.callId === request.callId && exec.name === request.toolName && operation.phase === 'dispatch')
      const match = matches.length === 1 ? matches[0] : undefined
      if (match === undefined) return 'rejected'
      const [exec, operation] = match
      if (failure(exec) !== undefined || !operation.authorized || !operation.wider
        || !isWidening(exec) || operation.approvalClaimed) return 'rejected'
      operation.approvalClaimed = true
      const completed = Promise.withResolvers<void>()
      active.add(completed.promise)
      const signal = AbortSignal.any([exec.signal, lifecycle.signal, operation.controller.signal,
        ...request.signal === undefined ? [] : [request.signal]])
      try {
        if (signal.aborted) return 'cancelled'
        const agent = exec.agent!
        const cwd = await directory.ensure(agent, signal)
        const human = await runPopup(subprocess, {
          sessionId: agent.session.id, cwd, toolName: exec.name, args: exec.arguments,
        }, {
          binaryPath: config.permissionPopupPath, timeoutMs: config.popupTimeoutMs,
          graceMs: config.processGraceMs, outputLimitBytes: config.outputLimitBytes,
        }, signal)
        audit(exec, `human-${human.kind}`)
        if (signal.aborted) return 'cancelled'
        if (human.kind === 'deny' || failure(exec) !== undefined) return 'rejected'
        // An abstaining/disabled popup defers to Auto; it never grants execution.
        if (human.kind === 'no_decision') {
          // A wider run_code request authorizes the complete program, unlike
          // an ordinary sandboxed outer transport, and must be reviewed here.
          const reviewed = await reviewTool(ctx, exec, signal)
          audit(exec, `auto-${reviewed.kind}`)
          if (signal.aborted || reviewed.kind === 'cancel') return 'cancelled'
          if (reviewed.kind !== 'allow') return 'rejected'
        }
        return signal.aborted ? 'cancelled' : failure(exec) === undefined ? 'allowed-once' : 'rejected'
      } catch (error) {
        if (signal.aborted) return 'cancelled'
        ctx.logger.warn('semi-auto: approval failed: %s', error instanceof Error ? error.message : String(error))
        return 'rejected'
      } finally {
        active.delete(completed.promise)
        completed.resolve()
      }
    }, { prepend: true })
    yield ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      // Off mode is a pure passthrough: no operation tracking, no review.
      if (!enabled) return next()
      const reason = failure(exec)
      if (reason !== undefined) return { kind: 'deny', reason }
      const wider = isWidening(exec)
      if ([...operations.keys()].some(other => other.agent === exec.agent && other.callId === exec.callId)) {
        return { kind: 'deny', reason: 'Semi Auto cannot authorize an ambiguous tool call identity.' }
      }
      const settled = Promise.withResolvers<void>()
      const operation: Operation = {
        controller: new AbortController(), done: settled.promise, resolve: settled.resolve,
        authorized: false, phase: 'review', wider, approvalClaimed: false,
      }
      operations.set(exec, operation)
      const completed = Promise.withResolvers<void>()
      active.add(completed.promise)
      const signal = AbortSignal.any([exec.signal, lifecycle.signal, operation.controller.signal])
      try {
        if (signal.aborted) return { kind: 'cancel' }
        if (!wider && isAutoReviewCandidate(exec)) {
          const reviewed = await reviewTool(ctx, exec, signal)
          audit(exec, `auto-${reviewed.kind}`)
          if (signal.aborted) return { kind: 'cancel' }
          if (reviewed.kind !== 'allow') return reviewed
        }
        const downstream = await next()
        if (signal.aborted) return { kind: 'cancel' }
        const changed = failure(exec)
        if (changed !== undefined) return { kind: 'deny', reason: changed }
        if (downstream.kind === 'allow') {
          operation.authorized = true
          operation.phase = 'prepared'
        }
        return downstream
      } catch (error) {
        if (signal.aborted) return { kind: 'cancel' }
        return { kind: 'deny', reason: `Semi Auto review failed; tool was not executed: ${error instanceof Error ? error.message : String(error)}` }
      } finally {
        if (!operation.authorized) release(exec)
        active.delete(completed.promise)
        completed.resolve()
      }
    }, { prepend: true })
    yield ctx.on('tools/execute', async (exec, next) => {
      if (!enabled) return next()
      const operation = operations.get(exec)
      const reason = failure(exec)
      if (reason !== undefined || operation?.authorized !== true) throw new Error(reason ?? 'Semi Auto review did not complete for this call.')
      const completed = Promise.withResolvers<void>()
      active.add(completed.promise)
      const previousSignal = exec.signal
      exec.signal = AbortSignal.any([previousSignal, lifecycle.signal, operation.controller.signal])
      operation.phase = 'dispatch'
      try {
        exec.signal.throwIfAborted()
        return await next()
      } finally {
        exec.signal = previousSignal
        active.delete(completed.promise)
        completed.resolve()
      }
    })
    yield async () => {
      accepting = false
      lifecycle.abort(new Error('semi-auto plugin disabled'))
      await Promise.allSettled([...active, ...[...operations.values()].map(operation => operation.done)])
    }
  }, 'semi-auto lifecycle')

  // The composer toggle rides the shared /api channel; headless compositions
  // without a connection service simply get no routes.
  registerModeRpc(ctx, rpc)
}
