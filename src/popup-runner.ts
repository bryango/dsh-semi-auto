/** Run the trusted native authorization UI without a shell or tool sandbox bypass. */

import { isAbsolute } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { decodePopupOutput, encodePopupRequest, type HumanDecision, type PopupRequest } from './popup-protocol.js'

/** Explicit runner limits supplied by the plugin's validated configuration. */
export interface PopupRunnerConfig {
  readonly binaryPath: string
  readonly timeoutMs: number
  readonly graceMs: number
  readonly outputLimitBytes: number
}

function deny(reason: string): HumanDecision {
  return { kind: 'deny', reason }
}

/**
 * Execute the trusted host UI and drain its complete managed process range.
 * The pending agent tool remains independently sandboxed; a popup allow never executes it.
 */
export async function runPopup(
  runtime: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>,
  request: PopupRequest,
  config: PopupRunnerConfig,
  signal: AbortSignal,
): Promise<HumanDecision> {
  let stdin: string
  try {
    if (!isAbsolute(config.binaryPath) || !isAbsolute(request.cwd)) {
      return deny('Permission popup requires absolute binary and working-directory paths.')
    }
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 2_147_483_647
      || !Number.isSafeInteger(config.graceMs) || config.graceMs <= 0 || config.graceMs > 2_147_483_647
      || !Number.isSafeInteger(config.outputLimitBytes) || config.outputLimitBytes <= 0) {
      return deny('Permission popup runner limits are invalid.')
    }
    stdin = encodePopupRequest(request)
  } catch {
    return deny('Permission popup request is invalid or exceeds its input limit.')
  }
  if (signal.aborted) return deny('Permission popup was cancelled.')

  const deadline = new AbortController()
  const combined = AbortSignal.any([signal, deadline.signal])
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    deadline.abort(new Error('Permission popup timed out.'))
  }, config.timeoutMs)
  timer.unref()
  let handle: SubprocessHandle | undefined
  let decision: HumanDecision = deny('Permission popup could not complete authorization.')
  try {
    const binary = await runtime.resolveExecutable(config.binaryPath, undefined, combined)
    combined.throwIfAborted()
    handle = runtime.spawn({
      argv: [binary, '--host', 'dsh'],
      cwd: request.cwd,
      stdio: {
        stdin: { data: stdin },
        stdout: { maxBytes: config.outputLimitBytes },
        stderr: { maxBytes: config.outputLimitBytes },
      },
      graceMs: config.graceMs,
      signal: combined,
    })
    const outcome = await handle.done
    if (outcome.exitCode !== 0 || outcome.signal !== null) {
      decision = deny('Permission popup exited unsuccessfully.')
    } else {
      const output = handle.collected.stdout?.readFrom(0)
      decision = output === undefined || output.lossy
        || Buffer.byteLength(output.text, 'utf8') > config.outputLimitBytes
        ? deny('Permission popup returned missing or truncated output.')
        : decodePopupOutput(output.text)
    }
  } catch {
    decision = deny('Permission popup failed to start or complete authorization.')
  } finally {
    if (handle !== undefined) {
      // The UI is trusted infrastructure, not the pending tool. Leave no surviving helper work.
      try {
        handle.terminate()
        await handle.done.catch(() => undefined)
        if (!await handle.waitForExit()) decision = deny('Permission popup cleanup did not complete.')
      } catch {
        decision = deny('Permission popup cleanup failed.')
      }
    }
    clearTimeout(timer)
  }
  // Cancellation during decoding or cleanup must never publish an earlier allow.
  if (signal.aborted) return deny('Permission popup was cancelled.')
  if (timedOut) return deny('Permission popup timed out.')
  return decision
}
