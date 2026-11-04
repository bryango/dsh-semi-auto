import { describe, expect, it } from 'vitest'
import { fullAccessApproval, type FullAccessApproval } from '../src/native-approval.js'

describe('version-pinned native full-access approval adapter', () => {
  it.each([
    'escalate sandbox to danger-full-access: Read the protected path',
    'escalate sandbox to danger-full-access:  Preserve the exact reason\nincluding its suffix ',
  ])('keeps the complete original native reason: %s', reason => {
    const approval: FullAccessApproval = { requestedMode: 'danger-full-access', reason }
    expect(fullAccessApproval(reason)).toEqual(approval)
  })

  it.each([
    undefined, '', 'general approval',
    'escalate sandbox to workspace-write: Write in the workspace',
    'escalate sandbox to read-only: Read a file',
    'escalate sandbox to danger-full-access:',
    'escalate sandbox to danger-full-access: ',
    'escalate sandbox to danger-full-access: \t\n ',
    ' escalate sandbox to danger-full-access: reason',
    'Escalate sandbox to danger-full-access: reason',
    'escalate sandbox to danger-full-access : reason',
    'escalate sandbox to danger-full-access:\treason',
    'prefix escalate sandbox to danger-full-access: reason',
  ])('does not classify a nonmatching or empty native reason: %j', reason => {
    expect(fullAccessApproval(reason)).toBeUndefined()
  })
})
