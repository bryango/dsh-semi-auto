import { describe, expect, it } from 'vitest'
import { nativeApproval, type NativeApproval } from '../src/native-approval.js'

describe('version-pinned native full-access approval adapter', () => {
  it.each([
    'escalate sandbox to danger-full-access: Read the protected path',
    'escalate sandbox to danger-full-access:  Preserve the exact reason\nincluding its suffix ',
  ])('keeps the complete original native reason: %s', reason => {
    const approval: NativeApproval = { requestedMode: 'danger-full-access', reason }
    expect(nativeApproval(reason)).toEqual(approval)
  })

  it.each([
    undefined, '', 'general approval',
    'escalate sandbox to danger-full-access:',
    'escalate sandbox to danger-full-access: ',
    'escalate sandbox to danger-full-access: \t\n ',
    ' escalate sandbox to danger-full-access: reason',
    'Escalate sandbox to danger-full-access: reason',
    'escalate sandbox to danger-full-access : reason',
    'escalate sandbox to danger-full-access:\treason',
    'prefix escalate sandbox to danger-full-access: reason',
  ])('does not classify a nonmatching or empty native reason: %j', reason => {
    expect(nativeApproval(reason)).toEqual(reason === undefined ? {} : { reason })
  })
  it.each(['read-only', 'workspace-write'] as const)('recognizes %s native scope', requestedMode => {
    const reason = `escalate sandbox to ${requestedMode}: requested operation`
    expect(nativeApproval(reason)).toEqual({ requestedMode, reason })
  })
})
