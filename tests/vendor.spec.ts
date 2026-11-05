import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { expectedReviewer, generateReviewer, sha256, type UpstreamMetadata } from '../scripts/generate-reviewer.mjs'

const root = new URL('../', import.meta.url)
const snapshot = () => readFile(new URL('vendor/upstream/auto-review.ts', root))
const metadata = async () => JSON.parse(await readFile(new URL('vendor/upstream.json', root), 'utf8')) as UpstreamMetadata

function policy(source: string): string {
  const start = source.indexOf('const REVIEW_POLICY = `')
  const end = source.indexOf('\n\n/** A parsed reviewer risk classification and decision. */', start)
  if (start < 0 || end < 0) throw new Error('Missing reviewer policy')
  return source.slice(start, end)
}

describe('official reviewer snapshot and deterministic adaptation', () => {
  it('records the exact rc5 baseline and complete upstream bytes', async () => {
    const upstream = await metadata()
    const original = await snapshot()
    expect(upstream.version).toBe('0.2.1-rc.5')
    expect(upstream.commit).toBe('b830ec950faba0a46dda564be3e2d854afed94f1')
    expect(upstream.files.autoReview.path).toBe('packages/experimental/auto-review/src/index.ts')
    expect(upstream.files.autoReview.sha256).toBe('1b0ebf6539f2f412c012eadf8049d19f711267040423d7800b3c4f06809413a7')
    expect(upstream.files.license.sha256).toBe('ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be')
    expect(sha256(original)).toBe(upstream.files.autoReview.sha256)
    expect(original.toString('utf8').split('\n')).toHaveLength(739)
    expect(original.toString('utf8')).toContain('export function apply(ctx: Context): void')
    const license = await readFile(new URL('vendor/upstream/LICENSE', root))
    expect(sha256(license)).toBe(upstream.files.license.sha256)
    expect(license.toString('utf8')).toContain('Copyright (c) 2026 DeepSeek')
  })

  it('matches checked-in generated content without generating files', async () => {
    const generated = await expectedReviewer()
    expect(await readFile(new URL('src/auto-review.ts', root), 'utf8')).toBe(generated)
    expect(policy(generated)).toBe(policy((await snapshot()).toString('utf8')).replace(
      'If you allow it, the call executes immediately with full host access and no later confirmation.',
      'If you allow it, you approve only the native permission request described in NATIVE_PERMISSION_REQUEST. A requestedMode is present only for a recognized native sandbox escalation. Otherwise the scope is unspecified: use the original reason and tool context, and do not assume full host access. This approval does not change the session permission policy.',
    ))
    expect(generated).not.toContain('registerAuto')
    expect(generated).not.toContain('AUTO_PRESET')
    expect(generated).not.toContain('function apply(')
    expect(generated).not.toContain('askUser')
    expect(generated).not.toContain("kind: 'ask'")
    expect(generated).toContain('export function isAutoReviewCandidate(')
    expect(generated).toContain('export async function reviewTool(')
  })

  it('retains upstream classification and denial code except explicit thinking options and native approval facts', async () => {
    const original = (await snapshot()).toString('utf8')
    const generated = await expectedReviewer()
    const classificationStart = '/** Return JSON text for one immutable logged value. */'
    const approvalStart = '/**\n * Ask the user to decide one call the reviewer denied.'
    const retained = original.slice(original.indexOf(classificationStart), original.indexOf(approvalStart))
    const adapted = retained.replace(
      '    temperature: 0,\n    signal,',
      "    reasoningEffort: ReasoningEffortId('low'),\n    signal,",
    ).replace(
      'async function classifyRisk(\n  ctx: Context,\n  agent: Agent,\n  exec: ToolExecution,\n  signal: AbortSignal,\n): Promise<AutoReviewDecision> {',
      'async function classifyRisk(\n  ctx: Context,\n  agent: Agent,\n  exec: ToolExecution,\n  signal: AbortSignal,\n  approval?: NativeApproval,\n): Promise<AutoReviewDecision> {',
    ).replace(
      "content: [{ type: 'text', text: reviewUserText(snapshot) }],",
      "content: [{ type: 'text', text: reviewUserText(snapshot)\n        + (approval === undefined ? '' : '\\n\\nNATIVE_PERMISSION_REQUEST\\n' + json(approval)) }],",
    )
    expect(generated).toContain(adapted)
    expect(generated).toContain(original.slice(
      original.indexOf('/** Materialize a reviewer failure as its own error rather than a denial. */'),
      original.indexOf('/** Install the Auto preset and its prepended per-call review gate. */'),
    ))
  })

  it('refuses source hash mismatches', async () => {
    const upstream = await metadata()
    expect(() => generateReviewer(Buffer.from('changed'), upstream)).toThrow('SHA-256')
  })

  it('requires manual review when an upstream extraction marker changes', async () => {
    const changed = Buffer.from((await snapshot()).toString('utf8').replace(
      '/** Install the Auto preset and its prepended per-call review gate. */',
      '/** Changed upstream lifecycle. */',
    ))
    const upstream = await metadata()
    upstream.files.autoReview.sha256 = sha256(changed)
    expect(() => generateReviewer(changed, upstream)).toThrow('lifecycle marker changed')
  })
})
