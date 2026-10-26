/** Current-profile human approval and Auto review without replacing DSH services. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-working-directory'
import { isAutoReviewCandidate, reviewTool } from './auto-review.js'
import { runPopup } from './popup-runner.js'

export const name = 'semi-auto'
export const inject = ['approval', 'llm', 'permissionPresets', 'sandboxPolicy', 'sessions', 'subagents', 'subprocess', 'tools', 'workingDirectory']

/** Host-side UI configuration; no agent tool argument can change these settings. */
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

/** Install reversible permission pinning and a global native/PTC-inner authorization gate. */
export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.permissionPopupPath)) throw new Error('semi-auto: permissionPopupPath must be absolute')
  const sandbox = ctx.sandboxPolicy
  const approval = ctx.approval
  const sessions = ctx.sessions
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
  const lifecycle = new AbortController()
  const active = new Set<Promise<void>>()
  const touched = new Set<Session>()
  const authorized = new WeakSet<ToolExecution>()
  // Admitted calls remain owned through scheduler queues and tools/result, not just review.
  const admitted = new Map<ToolExecution, { controller: AbortController; done: Promise<void>; resolve: () => void }>()
  const reviewing = new Map<ToolExecution, AbortController>()
  const isConfined = (session: Session): boolean => {
    const mode = sandbox.resolve({ session }).mode
    return mode === 'read-only' || mode === 'workspace-write'
  }
  const isPinned = (session: Session): boolean => isConfined(session) && approval.overrideOf(session) === 'never'
  const pin = (session: Session): void => {
    if (!accepting) throw new Error('semi-auto: plugin is closing')
    touched.add(session)
    if (approval.overrideOf(session) !== 'never') setApprovalPolicy(session, 'never')
  }
  const policyFailure = (exec: ToolExecution): string | undefined => {
    if (!accepting || lifecycle.signal.aborted) return 'Semi Auto is stopping; retry after the plugin has finished disabling.'
    if (exec.agent === undefined) return 'Semi Auto requires an agent-owned execution.'
    if (!isPinned(exec.agent.session)) return 'Semi Auto requires read-only or workspace-write with approval never; full access is not supported while enabled.'
    if (typeof exec.arguments === 'object' && exec.arguments !== null
      && 'sandbox_permissions' in exec.arguments
      && exec.arguments.sandbox_permissions !== undefined) {
      return 'Semi Auto rejects sandbox escalation; execution must stay within workspace-write.'
    }
    return undefined
  }
  const audit = (exec: ToolExecution, result: string): void => {
    // Tool payloads and reviewer reasoning are deliberately excluded.
    ctx.logger.info('semi-auto: session=%s call=%s tool=%s result=%s', exec.agent?.session.id, exec.callId, exec.name, result)
  }

  ctx.effect(function* () {
    yield ctx.on('subagent/provider-added', assertLocalProvider, { prepend: true })
    yield tools.guard((exec) => policyFailure(exec)
      ?? (authorized.has(exec) ? undefined : 'Semi Auto authorization did not complete for this call.'))
    yield ctx.on('tools/result', (exec) => {
      const operation = admitted.get(exec)
      admitted.delete(exec)
      authorized.delete(exec)
      operation?.resolve()
    })
    // rc3 may recover a scheduler failure without emitting tools/result for every
    // prepared slot. An idle/disposed owning agent has drained its driver.
    const releaseOrphans = (agent: ToolExecution['agent']): void => {
      for (const [exec, operation] of admitted) {
        if (exec.agent !== agent) continue
        operation.controller.abort(new Error('Semi Auto owning agent settled'))
        admitted.delete(exec)
        authorized.delete(exec)
        operation.resolve()
      }
    }
    yield ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') releaseOrphans(agent) })
    yield ctx.on('agent/disposed', ({ agent }) => { releaseOrphans(agent) })
    yield ctx.on('session/event', (session, event) => {
      if (event.type !== 'sandbox/mode' && event.type !== 'approval/policy') return
      if (event.type === 'approval/policy' && event.data.policy === 'never') return
      for (const [exec, operation] of admitted) {
        if (exec.agent?.session === session) operation.controller.abort(new Error('Semi Auto permissions changed'))
      }
      for (const [exec, controller] of reviewing) {
        if (exec.agent?.session === session) controller.abort(new Error('Semi Auto permissions changed'))
      }
      // Session observers cannot append reentrantly. Repin after publication;
      // pre-execute also pins before authorization, so the microtask is not enforcement.
      if (event.type === 'approval/policy' && accepting && touched.has(session)) {
        queueMicrotask(() => {
          if (!accepting || !touched.has(session)) return
          try { pin(session) } catch (error) { ctx.logger.error('semi-auto: approval repin failed: %s', error) }
        })
      }
    })
    yield ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (accepting && exec.agent !== undefined && approval.overrideOf(exec.agent.session) !== 'never') pin(exec.agent.session)
      const failure = policyFailure(exec)
      if (failure !== undefined) return { kind: 'deny', reason: failure }
      const completed = Promise.withResolvers<void>()
      active.add(completed.promise)
      const controller = new AbortController()
      reviewing.set(exec, controller)
      try {
        const signal = AbortSignal.any([exec.signal, lifecycle.signal, controller.signal])
        if (signal.aborted) return { kind: 'cancel' }
        if (isAutoReviewCandidate(exec)) {
          const agent = exec.agent!
          const cwd = await directory.ensure(agent, signal)
          const human = await runPopup(subprocess, {
            sessionId: agent.session.id, cwd, toolName: exec.name, args: exec.arguments,
          }, {
            binaryPath: config.permissionPopupPath,
            timeoutMs: config.popupTimeoutMs,
            graceMs: config.processGraceMs,
            outputLimitBytes: config.outputLimitBytes,
          }, signal)
          audit(exec, `human-${human.kind}`)
          if (signal.aborted) return { kind: 'cancel' }
          if (human.kind === 'deny') return { kind: 'deny', reason: human.reason }
          const changed = policyFailure(exec)
          if (changed !== undefined) return { kind: 'deny', reason: changed }
          if (human.kind === 'allow') {
            const reviewed = await reviewTool(ctx, exec, signal)
            audit(exec, `auto-${reviewed.kind}`)
            if (reviewed.kind !== 'allow') return reviewed
          }
        }
        if (signal.aborted) return { kind: 'cancel' }
        const changed = policyFailure(exec)
        if (changed !== undefined) return { kind: 'deny', reason: changed }
        const downstream = await next()
        if (signal.aborted) return { kind: 'cancel' }
        if (downstream.kind === 'allow') {
          const settled = Promise.withResolvers<void>()
          admitted.set(exec, { controller, done: settled.promise, resolve: settled.resolve })
          authorized.add(exec)
        }
        return downstream
      } catch (error) {
        if (lifecycle.signal.aborted || exec.signal.aborted) return { kind: 'cancel' }
        audit(exec, 'infrastructure-error')
        return { kind: 'deny', reason: `Semi Auto failed; tool was not executed: ${error instanceof Error ? error.message : String(error)}` }
      } finally {
        reviewing.delete(exec)
        active.delete(completed.promise)
        completed.resolve()
      }
    }, { prepend: true })
    // Recheck at dispatch as well as prepare: scheduler waits may separate the stages.
    yield ctx.on('tools/execute', async (exec, next) => {
      const failure = policyFailure(exec)
      if (failure !== undefined || !authorized.has(exec)) {
        throw new Error(failure ?? 'Semi Auto authorization did not complete for this call.')
      }
      const operation = admitted.get(exec)
      if (operation === undefined) throw new Error('Semi Auto authorization record is missing.')
      const completed = Promise.withResolvers<void>()
      active.add(completed.promise)
      const previousSignal = exec.signal
      exec.signal = AbortSignal.any([previousSignal, lifecycle.signal, operation.controller.signal])
      try {
        exec.signal.throwIfAborted()
        return await next()
      } finally {
        exec.signal = previousSignal
        active.delete(completed.promise)
        completed.resolve()
      }
    })
    yield ctx.on('session/created', pin)
    yield ctx.on('session/disposed', session => { touched.delete(session) })
    // This disposer is yielded before pinning, so a partial activation rolls back too.
    yield async () => {
      accepting = false
      lifecycle.abort(new Error('semi-auto plugin disabled'))
      await Promise.allSettled([...active, ...[...admitted.values()].map(operation => operation.done)])
      const live = new Set(sessions.list())
      for (const session of touched) {
        if (live.has(session) && approval.overrideOf(session) === 'never') setApprovalPolicy(session, 'ask')
      }
      touched.clear()
    }
    for (const session of sessions.list()) pin(session)
  }, 'semi-auto lifecycle')
}
