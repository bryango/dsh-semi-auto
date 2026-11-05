/** Native approval facts; only recognized sandbox reasons supply a target mode. */

/** Native request facts presented to the human and model reviewer. */
export interface NativeApproval {
  readonly requestedMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly reason?: string
}

// approveEscalation writes this prefix before the caller-controlled justification.
// ApprovalRequestEvent has no structured target mode in the supported releases.
const ESCALATION_PREFIX = /^escalate sandbox to (read-only|workspace-write|danger-full-access): (\s*\S[\s\S]*)$/

/** Preserve native reasons without interpreting model-supplied tool arguments. */
export function nativeApproval(reason: string | undefined): NativeApproval {
  if (reason === undefined) return {}
  const match = ESCALATION_PREFIX.exec(reason)
  return match === null ? { reason }
    : { requestedMode: match[1] as NonNullable<NativeApproval['requestedMode']>, reason }
}
