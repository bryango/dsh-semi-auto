import { describe, expect, it } from 'vitest'
import {
  buildPopupPayload,
  decodePopupOutput,
  encodePopupRequest,
  POPUP_INPUT_LIMIT_BYTES,
  type PopupRequest,
} from '../src/popup-protocol.js'

const request: PopupRequest = {
  sessionId: 'session-1', cwd: '/workspace', toolName: 'bash', args: { command: 'pwd' },
}

function output(behavior: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior, ...extra } } })
}

describe('popup request protocol', () => {
  it('includes only truthful pending-call metadata and exact arguments', () => {
    expect(buildPopupPayload(request)).toEqual({
      session_id: 'session-1', transcript_path: '', cwd: '/workspace', permission_mode: 'auto',
      hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'pwd' }, permission_suggestions: [],
    })
    expect(encodePopupRequest(request)).toMatch(/\n$/)
  })

  it.each([['bash', 'Bash'], ['edit', 'Edit'], ['write', 'Write'], ['mcp/server/tool', 'mcp/server/tool']])(
    'maps only presentation names: %s', (toolName, expected) => {
      expect(buildPopupPayload({ ...request, toolName }).tool_name).toBe(expected)
    },
  )

  it.each([undefined, null, [], 'raw args', 42])('rejects non-object tool arguments: %s', args => {
    expect(() => encodePopupRequest({ ...request, args })).toThrow()
  })

  it.each([{ a: undefined }, { a: Number.NaN }, { a: Infinity }, { a: BigInt(1) }, { a: () => 1 }, { a: new Date() }, { a: [,] }])(
    'rejects lossy or non-JSON argument values', args => {
      expect(() => encodePopupRequest({ ...request, args })).toThrow()
    },
  )

  it('rejects cycles but permits repeated non-cyclic object references', () => {
    const cycle: Record<string, unknown> = {}
    cycle['self'] = cycle
    expect(() => encodePopupRequest({ ...request, args: cycle })).toThrow(/cycles/)
    const shared = { a: 1 }
    expect(() => encodePopupRequest({ ...request, args: { first: shared, second: shared } })).not.toThrow()
  })

  it('rejects accessors, hidden/symbol keys and extra array properties without invoking getters', () => {
    let read = false
    const accessor = Object.defineProperty({}, 'command', { enumerable: true, get: () => { read = true; return 'pwd' } })
    const hidden = Object.defineProperty({}, 'command', { value: 'pwd', enumerable: false })
    const extra = Object.assign(['a'], { extra: 'hidden from JSON arrays' })
    for (const args of [accessor, hidden, { [Symbol('command')]: 'pwd' }, { list: extra }]) {
      expect(() => encodePopupRequest({ ...request, args })).toThrow()
    }
    expect(read).toBe(false)
  })

  it.each(['sessionId', 'cwd', 'toolName'] as const)('requires nonblank %s', field => {
    expect(() => encodePopupRequest({ ...request, [field]: '  ' })).toThrow()
  })

  it('applies the byte cap to the complete UTF-8 envelope including newline', () => {
    const emptySize = Buffer.byteLength(encodePopupRequest({ ...request, args: { text: '' } }))
    const exact = { ...request, args: { text: 'a'.repeat(POPUP_INPUT_LIMIT_BYTES - emptySize) } }
    expect(Buffer.byteLength(encodePopupRequest(exact))).toBe(POPUP_INPUT_LIMIT_BYTES)
    expect(() => encodePopupRequest({ ...request, args: { text: `${exact.args.text}a` } })).toThrow(/8 MiB/)
    expect(() => encodePopupRequest({ ...request, args: { text: '界'.repeat(Math.ceil(POPUP_INPUT_LIMIT_BYTES / 3)) } })).toThrow()
  })
})

describe('popup response protocol', () => {
  it.each(['allow'] as const)('accepts only explicit %s', behavior => {
    expect(decodePopupOutput(`${output(behavior)}\n`)).toEqual({ kind: behavior })
  })

  it('retains an explicit human denial reason', () => {
    expect(decodePopupOutput(output('deny', { message: 'No, not this action.' }))).toEqual({ kind: 'deny', reason: 'No, not this action.' })
    expect(decodePopupOutput(output('deny'))).toEqual({ kind: 'deny', reason: expect.any(String) })
  })

  it('treats exactly empty stdout as no decision rather than approval or denial', () => {
    expect(decodePopupOutput('')).toEqual({ kind: 'no_decision' })
  })

  it.each([
    ' ', '\t\r\n', 'not json', '{}', 'null', '[]', 'true',
    `${output('allow')}\n${output('allow')}`,
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', decision: { behavior: 'allow' } } }),
    JSON.stringify({ hookSpecificOutput: { decision: { behavior: 'allow' } } }),
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: null } }),
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' }, extra: true } }),
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } }, continue: true }),
    output('allow_direct'), output('continue'), output('ALLOW'), output('allow', { message: false }),
    output('allow', { updatedInput: { command: 'different' } }), output('allow', { permissionDecision: 'deny' }),
  ])('fails closed for malformed or unsupported responses: %s', text => {
    expect(decodePopupOutput(text)).toEqual({ kind: 'deny', reason: 'Permission popup returned an invalid authorization response.' })
  })

  it.each([
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","behavior":"allow"}}}',
    '{"hookSpecificOutput":{"hookEventName":"Wrong","hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","behav\\u0069or":"allow"}}}',
    `{"hookSpecificOutput":null,"hookSpecificOutput":${JSON.stringify(JSON.parse(output('allow')).hookSpecificOutput)}}`,
  ])('rejects repeated JSON members instead of selecting the last decision', text => {
    expect(decodePopupOutput(text).kind).toBe('deny')
  })

  it('does not confuse punctuation in a message with repeated JSON members', () => {
    expect(decodePopupOutput(output('deny', { message: '{"behavior":"allow"}: [] \\"' }))).toEqual({
      kind: 'deny', reason: '{"behavior":"allow"}: [] \\"',
    })
  })
})
