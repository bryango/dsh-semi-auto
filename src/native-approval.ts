/** Version-pinned adapter for the rc.3/rc.5 native sandbox approval reason. */

/** The exact full-access request presented to the human and model reviewer. */
export interface FullAccessApproval {
  readonly requestedMode: 'danger-full-access'
  readonly reason: string
}

// approveEscalation writes this prefix before the caller-controlled justification.
// ApprovalRequestEvent has no structured target mode in the supported releases.
const FULL_ACCESS_PREFIX = 'escalate sandbox to danger-full-access: '

/** Identify native full-access asks without interpreting model-supplied tool arguments. */
export function fullAccessApproval(reason: string | undefined): FullAccessApproval | undefined {
  if (reason === undefined || !reason.startsWith(FULL_ACCESS_PREFIX)
    || reason.slice(FULL_ACCESS_PREFIX.length).trim() === '') return undefined
  return { requestedMode: 'danger-full-access', reason }
}
