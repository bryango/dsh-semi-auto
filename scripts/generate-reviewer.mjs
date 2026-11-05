import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = new URL('../', import.meta.url)

/** Hash exact upstream bytes, including their original newline encoding. */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before)
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`Reviewer update requires manual review: ${label} changed`)
  }
  return source.slice(0, index) + after + source.slice(index + before.length)
}

const upstreamHeader = `/**
 * LLM-backed authorization gate for the current-session-only Auto permission
 * preset. Every native call and every started PTC inner call is reviewed once
 * before its body; the outer \`run_code\` transport is deliberately excluded.
 * Under the \`ask\` approval policy a reviewer denial asks the user; under
 * \`never\` it is final.
 *
 * @module @deepseek-ai/dsh-experimental-auto-review
 */
`
const pluginExports = `/** Cordis plugin name used by loader diagnostics. */
export const name = 'experimental-auto-review'
/** Complete host services required before Auto may be advertised. */
export const inject = ['approval', 'llm', 'permissionPresets', 'sessions', 'tools', 'workingDirectory']

`
const askUser = `/**
 * Ask the user to decide one call the reviewer denied. The audited reason is
 * English; the prompt text is localized and keeps the reviewer's raw reason.
 */
function askUser(exec: ToolExecution, reason?: string): PreToolDecision {
  const denial = \`Auto review denied tool "\${exec.name}"\`
  return {
    kind: 'ask',
    reason: reason === undefined ? denial : \`\${denial}: \${reason}\`,
    displayReason: reason === undefined
      ? { en: 'Auto review denied this call.', zh: 'Auto review 拒绝了此调用。' }
      : { en: \`Auto review denied this call: \${reason}\`, zh: \`Auto review 拒绝了此调用：\${reason}\` },
  }
}

`
const lifecycleMarker = '/** Install the Auto preset and its prepended per-call review gate. */\n'
const adapter = `/**
 * Match the official reviewer surface, including started PTC inner calls.
 * @param exec - pending tool execution.
 * @returns whether the execution has an agent and is not the outer PTC transport.
 */
export function isAutoReviewCandidate(exec: ToolExecution): boolean {
  return exec.agent !== undefined && !(exec.parent === undefined && exec.name === RUN_CODE_NAME)
}

/**
 * Review one call without registering presets, executing it, or requesting human approval.
 * The caller owns the preceding popup and downstream policy/execution chain.
 * @param ctx - context providing the LLM and working-directory services.
 * @param exec - pending tool execution with its durable call history.
 * @param signal - caller's review lifetime; execution cancellation also applies.
 * @param approval - native grant context, kept separate from the logged tool arguments.
 * @returns allow, final denial, or cancellation; never an approval request.
 */
export async function reviewTool(
  ctx: Context,
  exec: ToolExecution,
  signal: AbortSignal,
  approval?: NativeApproval,
): Promise<PreToolDecision> {
  const reviewSignal = AbortSignal.any([exec.signal, signal])
  if (isAborted(reviewSignal)) return { kind: 'cancel' }
  const agent = exec.agent
  if (agent === undefined) return failed(exec, new Error('auto-review: the pending call has no agent'))
  try {
    const decision = await classifyRisk(ctx, agent, exec, reviewSignal, approval)
    if (isAborted(reviewSignal)) return { kind: 'cancel' }
    return decision.decision === 'allow' ? { kind: 'allow' } : denied(exec, decision.reason)
  } catch (error: unknown) {
    return isAborted(reviewSignal) ? { kind: 'cancel' } : failed(exec, error)
  }
}

/** Review a public native request that has no uniquely owned ToolExecution. */
export async function reviewApproval(
  ctx: Context,
  request: ApprovalRequestEvent,
  signal: AbortSignal,
  approval: NativeApproval,
): Promise<PreToolDecision> {
  if (isAborted(signal)) return { kind: 'cancel' }
  try {
    const { agent } = request
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const { session } = agent
    const header = session.requestHeader()
    if (header === undefined || !header.config.provider || !header.config.model) {
      throw new Error('auto-review: no complete request-header route is available')
    }
    const events = session.snapshotEvents()
    const initialPromptSeq = directParentInitialPromptSeq(agent, events)
    const projectInstructions: HistoricalUserMessage[] = []
    const history: HistoricalEntry[] = []
    for (const seq of session.surface.nodes) {
      const event = events[seq]!
      if (event.type !== 'user/message' || event.data.source.kind === 'tool') continue
      if (isProjectInstruction(event.data.source)) {
        projectInstructions.push({ kind: 'user-message', role: 'constraint',
          source: event.data.source, content: event.data.content })
      } else {
        history.push(...filteredUserEntries(event.seq, event.data.source,
          event.data.content, initialPromptSeq, session.header.parentSession))
      }
    }
    // No execution means no verified arguments or tool schema. Do not reconstruct
    // an action from a reused call id, the tool registry, or model-written text.
    const text = ['ENVIRONMENT', json({ cwd }),
      'PROJECT_INSTRUCTIONS', json(projectInstructions),
      'FILTERED_HISTORY', json(history),
      'PENDING_ACTION', json({ mode: 'approval-request', name: request.toolName,
        callId: request.callId ?? null, arguments: null, description: null, parameters: null,
        context: 'No owned ToolExecution is available. Arguments, schema and historical tool facts are unavailable; do not infer them.' }),
      'NATIVE_PERMISSION_REQUEST', json(approval)].join('\\n\\n')
    const options: GenerateOptions = deepFreeze({
      provider: header.config.provider, model: header.config.model, system: REVIEW_POLICY,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      reasoningEffort: ReasoningEffortId('low'), signal,
    })
    const decision = await readDecision(ctx.llm.stream(options))
    if (isAborted(signal)) return { kind: 'cancel' }
    return decision.decision === 'allow' ? { kind: 'allow' }
      : { kind: 'deny', reason: decision.reason ?? 'Auto review rejected the native permission request.' }
  } catch (error: unknown) {
    return isAborted(signal) ? { kind: 'cancel' } : {
      kind: 'deny', reason: 'Auto review of native permission request failed: '
        + (error instanceof Error ? error.message : String(error)),
    }
  }
}
`

/** Apply the complete, explicit local adaptation to the pinned upstream source. */
export function generateReviewer(sourceBytes, metadata) {
  if (sha256(sourceBytes) !== metadata.files.autoReview.sha256) {
    throw new Error('Upstream reviewer SHA-256 does not match vendor/upstream.json')
  }
  const source = sourceBytes.toString('utf8')
  const index = source.indexOf(lifecycleMarker)
  if (index < 0 || source.indexOf(lifecycleMarker, index + lifecycleMarker.length) >= 0) {
    throw new Error('Reviewer update requires manual review: lifecycle marker changed')
  }
  // Refuse a silent wider extraction on an upstream update. Revisit this check explicitly.
  if (source.slice(0, index).split('\n').length - 1 !== 674) {
    throw new Error('Reviewer update requires manual review: expected 674 lines before lifecycle')
  }
  let result = source.slice(0, index)
  result = replaceOnce(result, upstreamHeader, `/**
 * Generated from DeepSeek Harness ${metadata.version} (${metadata.commit}).
 * Copyright (c) 2026 DeepSeek; MIT license, see vendor/upstream/LICENSE.
 * Do not edit: run scripts/generate-reviewer.mjs. Local adaptation: UPDATING.md.
 * Native approval context determines the requested scope; it is not always full host access.
 * @module dsh-semi-auto/auto-review
 */
`, 'module header')
  result = replaceOnce(result, "import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'\n", '', 'preset import')
  result = replaceOnce(result, "import type {} from '@deepseek-ai/dsh-user-approval'\n", "import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'\n", 'approval type import')
  result = replaceOnce(result, pluginExports, '', 'plugin exports')
  result = replaceOnce(result, '  BlockAssembler,\n', '  BlockAssembler,\n  ReasoningEffortId,\n', 'reasoning effort import')
  result = replaceOnce(result, '    temperature: 0,\n    signal,\n', "    reasoningEffort: ReasoningEffortId('low'),\n    signal,\n", 'reviewer request options')
  result = replaceOnce(result, askUser, '', 'built-in approval helper')
  result = replaceOnce(result,
    'If you allow it, the call executes immediately with full host access and no later confirmation.',
    'If you allow it, you approve only the native permission request described in NATIVE_PERMISSION_REQUEST. A requestedMode is present only for a recognized native sandbox escalation. Otherwise the scope is unspecified: use the original reason and tool context, and do not assume full host access. This approval does not change the session permission policy.',
    'native approval scope')
  result = replaceOnce(result, "import type { Context } from '@deepseek-ai/cordis'\n",
    "import type { Context } from '@deepseek-ai/cordis'\nimport type { NativeApproval } from './native-approval.js'\n", 'native approval type')
  result = replaceOnce(result, `async function classifyRisk(
  ctx: Context,
  agent: Agent,
  exec: ToolExecution,
  signal: AbortSignal,
): Promise<AutoReviewDecision> {`, `async function classifyRisk(
  ctx: Context,
  agent: Agent,
  exec: ToolExecution,
  signal: AbortSignal,
  approval?: NativeApproval,
): Promise<AutoReviewDecision> {`, 'native approval review scope')
  result = replaceOnce(result, "content: [{ type: 'text', text: reviewUserText(snapshot) }],",
    "content: [{ type: 'text', text: reviewUserText(snapshot)\n        + (approval === undefined ? '' : '\\n\\nNATIVE_PERMISSION_REQUEST\\n' + json(approval)) }],", 'native approval facts')
  return result + adapter
}

/** Read and verify both pristine upstream snapshots before generating the adapter. */
export async function expectedReviewer() {
  const metadata = JSON.parse(await readFile(new URL('vendor/upstream.json', root), 'utf8'))
  const source = await readFile(new URL('vendor/upstream/auto-review.ts', root))
  const license = await readFile(new URL('vendor/upstream/LICENSE', root))
  if (sha256(license) !== metadata.files.license.sha256) {
    throw new Error('Upstream license SHA-256 does not match vendor/upstream.json')
  }
  return generateReviewer(source, metadata)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('Usage: node scripts/generate-reviewer.mjs [--check]')
  }
  const expected = await expectedReviewer()
  const destination = new URL('src/auto-review.ts', root)
  if (args[0] === '--check') {
    if (await readFile(destination, 'utf8') !== expected) {
      throw new Error('Generated reviewer is stale; run node scripts/generate-reviewer.mjs')
    }
    console.log('Reviewer snapshots and generated adapter match.')
  } else {
    await writeFile(destination, expected)
    console.log('Generated src/auto-review.ts from verified upstream snapshot.')
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
