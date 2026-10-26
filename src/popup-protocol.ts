/** Strict JSON protocol for the native popup's explicit DSH host adapter. */

/** Maximum complete stdin payload accepted by permission-popup. */
export const POPUP_INPUT_LIMIT_BYTES = 8 * 1024 * 1024

/** A positive decision authorizes only the corresponding caller-controlled path. */
export type HumanDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'allow_direct' }
  | { readonly kind: 'no_decision' }
  | { readonly kind: 'deny'; readonly reason: string }

/** Pending-call metadata; no conversation history or model reasoning is included. */
export interface PopupRequest {
  readonly sessionId: string
  readonly cwd: string
  readonly toolName: string
  readonly args: unknown
}

/** Exact PermissionRequest envelope supported by the popup's DSH adapter. */
export interface PopupPayload {
  readonly session_id: string
  readonly transcript_path: ''
  readonly cwd: string
  readonly permission_mode: 'auto'
  readonly hook_event_name: 'PermissionRequest'
  readonly tool_name: string
  readonly tool_input: Record<string, unknown>
  readonly permission_suggestions: readonly []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Reject values that JSON.stringify would silently omit, replace, or reinterpret. */
function assertJson(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || value === null) throw new Error('Popup arguments must contain only lossless JSON values.')
  if (ancestors.has(value)) throw new Error('Popup arguments must not contain cycles.')
  const prototype: unknown = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error('Popup arguments must contain only JSON objects and arrays.')
  }
  ancestors.add(value)
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const array = Array.isArray(value)
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') continue
      if (typeof key !== 'string') throw new Error('Popup arguments must not contain symbol keys.')
      const descriptor = descriptors[key]
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error('Popup arguments must contain ordinary enumerable JSON properties.')
      }
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
        throw new Error('Popup argument arrays must not contain additional properties.')
      }
      assertJson(descriptor.value, ancestors)
    }
    if (array) {
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) throw new Error('Popup argument arrays must not contain holes.')
      }
    }
  } finally {
    ancestors.delete(value)
  }
}

/** Build a truthful request envelope, rejecting non-object or non-JSON arguments. */
export function buildPopupPayload(request: PopupRequest): PopupPayload {
  if (request.sessionId.trim() === '' || request.cwd.trim() === '' || request.toolName.trim() === '') {
    throw new Error('Popup request requires a session id, working directory, and tool name.')
  }
  if (!isRecord(request.args)) throw new Error('Popup tool arguments must be a JSON object.')
  assertJson(request.args, new Set())
  const displayName = request.toolName === 'bash' ? 'Bash'
    : request.toolName === 'edit' ? 'Edit'
      : request.toolName === 'write' ? 'Write' : request.toolName
  return {
    session_id: request.sessionId,
    transcript_path: '',
    cwd: request.cwd,
    permission_mode: 'auto',
    hook_event_name: 'PermissionRequest',
    tool_name: displayName,
    tool_input: request.args,
    permission_suggestions: [],
  }
}

/** Encode the complete stdin payload, including framing, within the adapter's cap. */
export function encodePopupRequest(request: PopupRequest): string {
  const text = `${JSON.stringify(buildPopupPayload(request))}\n`
  if (Buffer.byteLength(text, 'utf8') > POPUP_INPUT_LIMIT_BYTES) {
    throw new Error('Popup request exceeds the 8 MiB input limit.')
  }
  return text
}

/** JSON.parse validates syntax first; this pass detects repeated keys, including escaped spellings. */
function hasDuplicateMembers(text: string): boolean {
  const containers: Array<Set<string> | undefined> = []
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '{') containers.push(new Set())
    else if (char === '[') containers.push(undefined)
    else if (char === '}' || char === ']') containers.pop()
    else if (char === '"') {
      const start = index
      for (index++; index < text.length; index++) {
        if (text[index] === '\\') index++
        else if (text[index] === '"') break
      }
      let next = index + 1
      while (/\s/.test(text[next] ?? '') && next < text.length) next++
      if (text[next] !== ':') continue
      const key: unknown = JSON.parse(text.slice(start, index + 1))
      const keys = containers.at(-1)
      if (typeof key !== 'string' || keys === undefined) continue
      if (keys.has(key)) return true
      keys.add(key)
    }
  }
  return false
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

/** Empty output abstains; malformed output, unexpected fields and repeated keys fail closed. */
export function decodePopupOutput(stdout: string): HumanDecision {
  if (stdout === '') return { kind: 'no_decision' }
  const invalid: HumanDecision = { kind: 'deny', reason: 'Permission popup returned an invalid authorization response.' }
  let value: unknown
  try {
    value = JSON.parse(stdout)
    if (hasDuplicateMembers(stdout)) return invalid
  } catch {
    return invalid
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ['hookSpecificOutput'])) return invalid
  const output = value['hookSpecificOutput']
  if (!isRecord(output) || !hasOnlyKeys(output, ['hookEventName', 'decision'])
    || output['hookEventName'] !== 'PermissionRequest') return invalid
  const decision = output['decision']
  if (!isRecord(decision) || !hasOnlyKeys(decision, ['behavior', 'message'])) return invalid
  if (Object.hasOwn(decision, 'message') && typeof decision['message'] !== 'string') return invalid
  switch (decision['behavior']) {
    case 'allow': return { kind: 'allow' }
    case 'allow_direct': return { kind: 'allow_direct' }
    case 'deny': return {
      kind: 'deny',
      reason: typeof decision['message'] === 'string' && decision['message'].trim() !== ''
        ? decision['message'] : 'Denied from the native permission popup.',
    }
    default: return invalid
  }
}
