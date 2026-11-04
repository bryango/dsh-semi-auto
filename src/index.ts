/** Route native full-access approval requests through the popup and optional Auto review. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-working-directory'
import { reviewTool } from './auto-review.js'
import { readModeFileSync, writeModeFile } from './mode.js'
import { fullAccessApproval } from './native-approval.js'
import { runPopup } from './popup-runner.js'
import { registerModeRpc, type ModeRpc } from './rpc.js'

export const name = 'semi-auto'
export const inject = ['approval', 'llm', 'sandboxPolicy', 'subprocess', 'tools', 'workingDirectory']

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

interface Call {
  enabled: boolean
  phase: 'preparing' | 'prepared' | 'dispatch'
}

interface PendingApproval {
  controller: AbortController
  done: Promise<void>
}

/** Install an approval answerer without reviewing ordinary calls or changing native permissions. */
export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.permissionPopupPath)) throw new Error('semi-auto: permissionPopupPath must be absolute')
  const sandbox = ctx.sandboxPolicy
  const subprocess = ctx.subprocess
  const directory = ctx.workingDirectory
  if (!(subprocess instanceof LocalSubprocessRuntime)) {
    throw new Error('semi-auto: the native popup requires the local subprocess provider')
  }

  let enabled = readModeFileSync()
  const rpc: ModeRpc = {
    getEnabled: () => enabled,
    setEnabled: value => {
      enabled = value
      return writeModeFile(value)
    },
  }
  let accepting = true
  const lifecycle = new AbortController()
  // Admission is fixed per call so a toggle cannot change an already-running call's answerer.
  const calls = new Map<ToolExecution, Call>()
  const pending = new Map<ToolExecution, PendingApproval>()
  const audit = (exec: ToolExecution, result: string): void => {
    ctx.logger.info('semi-auto: session=%s call=%s tool=%s result=%s', exec.agent?.session.id, exec.callId, exec.name, result)
  }
  const release = (exec: ToolExecution): void => {
    calls.delete(exec)
    pending.get(exec)?.controller.abort(new Error('Semi Auto owning call settled'))
  }

  ctx.effect(function* () {
    yield ctx.on('tools/pre-execute', async (exec, next) => {
      const call: Call = { enabled, phase: 'preparing' }
      calls.set(exec, call)
      try {
        const decision = await next()
        if (decision.kind === 'allow' || decision.kind === 'ask') call.phase = 'prepared'
        else calls.delete(exec)
        return decision
      } catch (error) {
        calls.delete(exec)
        throw error
      }
    }, { prepend: true })
    yield ctx.on('tools/execute', async (exec, next) => {
      const call = calls.get(exec)
      if (call !== undefined) call.phase = 'dispatch'
      // Do not fuse the plugin lifetime into the tool signal or join this body on
      // unload: a granted plugin_manager call may itself await this fiber's disposal.
      try {
        return await next()
      } finally {
        release(exec)
      }
    })
    yield ctx.on('tools/result', exec => { release(exec) })
    const releaseOwner = (agent: ToolExecution['agent']): void => {
      for (const exec of calls.keys()) {
        if (exec.agent === agent) release(exec)
      }
    }
    yield ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') releaseOwner(agent) })
    yield ctx.on('agent/disposed', ({ agent }) => { releaseOwner(agent) })
    yield ctx.on('session/event', (session, event) => {
      if (event.type !== 'sandbox/mode' && event.type !== 'approval/policy') return
      for (const [exec, operation] of pending) {
        if (exec.agent?.session === session) operation.controller.abort(new Error('Semi Auto permissions changed'))
      }
    })
    yield ctx.on('approval/request', async (request, next): Promise<ApprovalOutcome> => {
      const approval = fullAccessApproval(request.reason)
      // General asks and read-only -> workspace-write escalation remain native.
      if (approval === undefined) return next()
      const matches = [...calls].filter(([exec]) => exec.agent === request.agent
        && exec.callId === request.callId && exec.name === request.toolName)
      if (matches.length === 1 && !matches[0]![1].enabled) return next()
      if (matches.length === 0 && !enabled) return next()
      if (!accepting) return 'cancelled'
      const match = matches.length === 1 ? matches[0] : undefined
      if (match === undefined || match[1].phase !== 'dispatch') return 'rejected'
      const [exec] = match
      // Concurrent asks cannot borrow a pending decision. A later ask starts a
      // fresh popup/review; no allow is cached or reused across native requests.
      if (pending.has(exec)) return 'rejected'
      const mode = sandbox.resolve({ session: request.agent.session }).mode
      if (mode !== 'read-only' && mode !== 'workspace-write') return 'rejected'
      const completed = Promise.withResolvers<void>()
      const controller = new AbortController()
      pending.set(exec, { controller, done: completed.promise })
      const signal = AbortSignal.any([exec.signal, lifecycle.signal, controller.signal,
        ...request.signal === undefined ? [] : [request.signal]])
      try {
        if (signal.aborted) return 'cancelled'
        const cwd = await directory.ensure(request.agent, signal)
        const human = await runPopup(subprocess, {
          sessionId: request.agent.session.id, cwd, toolName: exec.name, args: exec.arguments, approval,
        }, {
          binaryPath: config.permissionPopupPath, timeoutMs: config.popupTimeoutMs,
          graceMs: config.processGraceMs, outputLimitBytes: config.outputLimitBytes,
        }, signal)
        audit(exec, `human-${human.kind}`)
        if (signal.aborted) return 'cancelled'
        if (human.kind === 'deny') return 'rejected'
        if (human.kind === 'no_decision') {
          const reviewed = await reviewTool(ctx, exec, signal, approval)
          audit(exec, `auto-${reviewed.kind}`)
          if (signal.aborted || reviewed.kind === 'cancel') return 'cancelled'
          if (reviewed.kind !== 'allow') return 'rejected'
        }
        return signal.aborted ? 'cancelled' : 'allowed-once'
      } catch (error) {
        if (signal.aborted) return 'cancelled'
        ctx.logger.warn('semi-auto: approval failed: %s', error instanceof Error ? error.message : String(error))
        return 'rejected'
      } finally {
        pending.delete(exec)
        completed.resolve()
      }
    }, { prepend: true })
    yield async () => {
      accepting = false
      lifecycle.abort(new Error('semi-auto plugin disabled'))
      // Only authorization I/O belongs to this plugin. Native executors own a
      // tool after its single-use grant, including a tool that reloads this plugin.
      await Promise.allSettled([...pending.values()].map(operation => operation.done))
      calls.clear()
    }
  }, 'semi-auto lifecycle')

  registerModeRpc(ctx, rpc)
}
