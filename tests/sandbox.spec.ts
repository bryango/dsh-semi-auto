import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FsError } from '@deepseek-ai/dsh-fs'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as SemiAuto from '../src/index.js'
import { reviewTool } from '../src/auto-review.js'
import { runPopup } from '../src/popup-runner.js'

// Only external authorization is mocked; tool dispatch, policy and filesystem enforcement are real.
vi.mock('../src/auto-review.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/auto-review.js')>(),
  reviewTool: vi.fn(),
}))
vi.mock('../src/popup-runner.js', () => ({ runPopup: vi.fn() }))

const popup = vi.mocked(runPopup)
const reviewer = vi.mocked(reviewTool)
const contexts: Context[] = []
const directories: Array<{ root: string; parent: string }> = []
const CONFIG: SemiAuto.Config = {
  permissionPopupPath: '/test/permission-popup',
  popupTimeoutMs: 600000,
  processGraceMs: 1000,
  outputLimitBytes: 65536,
}

class FixtureShell extends Service {
  readonly sandboxMode = 'workspace-write'
  constructor(ctx: Context) { super(ctx, 'shell') }
}
class FixtureLlm extends Service {
  constructor(ctx: Context) { super(ctx, 'llm') }
}
class FixtureDirectory extends Service {
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  async ensure(agent: Agent, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    if (agent.session.header.cwd === undefined) throw new Error('Sandbox fixture requires a session cwd')
    return agent.session.header.cwd
  }
}

function contains(root: string, target: string): boolean {
  const suffix = relative(root, target)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

async function harness(mode: 'read-only' | 'workspace-write' = 'workspace-write') {
  // /tmp and os.tmpdir() are explicitly writable. Use siblings inside this project,
  // outside those grants, so an outside-workspace denial actually tests containment.
  const parent = await realpath(process.cwd())
  expect(parent).toBe(await realpath(fileURLToPath(new URL('../', import.meta.url))))
  const root = await mkdtemp(join(parent, '.test-sandbox-'))
  directories.push({ root, parent })
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  await mkdir(workspace)
  await mkdir(outside)

  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FixtureShell)
  await ctx.plugin(FixtureLlm)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(FixtureDirectory)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(PermissionPresetService, {
    defaultPreset: 'workspace-write',
    presets: {
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    },
  })
  await ctx.plugin(SubagentRuntime, {})
  const session = ctx.sessions.create(SessionId('sandbox-fixture'), { meta: { cwd: workspace } })
  if (mode === 'read-only') setSandboxMode(session, mode)
  // The real ToolRuntime requires an agent scope, Session and Context, not a running LLM loop.
  const agent = { id: session.id, session, ctx, options: { provider: 'fixture', model: 'fixture' } } as Agent
  const builtInApproval = vi.fn()
  ctx.on('approval/request', async () => { builtInApproval(); return 'allowed-once' })
  const policies: ReturnType<typeof ctx.sandboxPolicy.resolve>[] = []
  const failures: unknown[] = []
  const body = vi.fn(async (path: string, content: string, signal: AbortSignal) => {
    const policy = ctx.sandboxPolicy.resolve({ session })
    policies.push(policy)
    const target = await ctx.fs.resolve(path, { cwd: workspace, signal })
    try {
      // This is the actual rc3 filesystem mutation, not a simulated tool result.
      await ctx.fs.writeText(target, content, undefined, signal, policy)
    } catch (error) {
      failures.push(error)
      throw error
    }
    return [{ type: 'text' as const, text: 'File written' }]
  })
  ctx.tools.register(defineContentToolFixture({
    name: 'sandbox_write',
    description: 'Write through the real sandbox-enforcing filesystem',
    parameters: {
      path: { type: 'string', required: true },
      content: { type: 'string', required: true },
      sandbox_permissions: { type: 'string' },
    },
    execute: async (args, exec) => body(args.path, args.content, exec.signal),
  }))
  await ctx.plugin(SemiAuto, CONFIG)

  const policy = ctx.sandboxPolicy.resolve({ session })
  expect(policy.mode).toBe(mode)
  expect(policy.workspaceRoot).toBe(workspace)
  // The backend default stays workspace-write; the session's effective policy wins.
  expect(ctx.fs.sandboxMode).toBe('workspace-write')
  expect(ctx.approval.overrideOf(session)).toBe('never')
  for (const granted of writableRoots(policy)) {
    expect(contains(await realpath(granted), outside), `outside fixture must not be granted by ${granted}`).toBe(false)
  }
  let call = 0
  const execute = (path: string, content: string, sandbox_permissions?: string) => ctx.tools.execute({
    name: 'sandbox_write',
    arguments: { path, content, ...sandbox_permissions === undefined ? {} : { sandbox_permissions } },
    signal: new AbortController().signal,
    callId: ToolCallId(`sandbox-${++call}`),
    agent,
  })
  return { workspace, outside, execute, body, failures, policies, builtInApproval }
}

beforeEach(() => {
  popup.mockReset().mockResolvedValue({ kind: 'allow' })
  reviewer.mockReset().mockResolvedValue({ kind: 'allow' })
})

afterEach(async () => {
  try {
    while (contexts.length) await contexts.pop()!.fiber.dispose()
  } finally {
    while (directories.length) {
      const { root, parent } = directories.pop()!
      // Verify the exact canonical, session-created target before recursive deletion.
      expect(await realpath(root)).toBe(root)
      expect(dirname(root)).toBe(parent)
      expect(basename(root)).toMatch(/^\.test-sandbox-[A-Za-z0-9]+$/)
      await rm(root, { recursive: true, force: true })
    }
    vi.restoreAllMocks()
  }
})

describe('Semi Auto with real rc3 sandboxed filesystem execution', () => {
  it.each(['allow', 'allow_direct'] as const)('human %s permits an actual workspace-local write', async (kind) => {
    const h = await harness()
    popup.mockResolvedValue({ kind })
    const path = join(h.workspace, 'created.txt')
    const result = await h.execute(path, 'workspace content')
    expect(result.isError).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('workspace content')
    expect(h.body).toHaveBeenCalledTimes(1)
    expect(h.failures).toEqual([])
    expect(h.policies).toEqual([expect.objectContaining({ mode: 'workspace-write', workspaceRoot: h.workspace })])
    expect(popup).toHaveBeenCalledTimes(1)
    expect(reviewer).toHaveBeenCalledTimes(kind === 'allow' ? 1 : 0)
    expect(h.builtInApproval).not.toHaveBeenCalled()
  })

  it.each(['allow', 'allow_direct'] as const)('human %s cannot write inside a read-only workspace', async (kind) => {
    const h = await harness('read-only')
    popup.mockResolvedValue({ kind })
    const existing = join(h.workspace, 'existing.txt')
    const missing = join(h.workspace, 'not-created.txt')
    await writeFile(existing, 'original content')
    for (const path of [existing, missing]) {
      const result = await h.execute(path, 'must not be written')
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).toContain('file access denied under read-only mode')
    }
    expect(await readFile(existing, 'utf8')).toBe('original content')
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
    // Both authorization routes reach the real backend with read-only unchanged.
    expect(h.body).toHaveBeenCalledTimes(2)
    expect(h.failures).toHaveLength(2)
    for (const error of h.failures) {
      expect(error).toBeInstanceOf(FsError)
      expect(error).toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    }
    expect(h.policies).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ mode: 'read-only', workspaceRoot: h.workspace })))
    expect(popup).toHaveBeenCalledTimes(2)
    expect(reviewer).toHaveBeenCalledTimes(kind === 'allow' ? 2 : 0)
    expect(h.builtInApproval).not.toHaveBeenCalled()
  })

  it.each(['allow', 'allow_direct'] as const)('human %s cannot bypass the filesystem fence outside the workspace', async (kind) => {
    const h = await harness()
    popup.mockResolvedValue({ kind })
    const existing = join(h.outside, 'existing.txt')
    const missing = join(h.outside, 'not-created.txt')
    await writeFile(existing, 'original content')
    for (const path of [existing, missing]) {
      const result = await h.execute(path, 'must not be written')
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).toContain('file access denied under workspace-write mode')
    }
    expect(await readFile(existing, 'utf8')).toBe('original content')
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
    // The body and real backend were reached after approval; enforcement, not an
    // earlier mocked denial, is what prevented both mutations.
    expect(h.body).toHaveBeenCalledTimes(2)
    expect(h.failures).toHaveLength(2)
    for (const error of h.failures) {
      expect(error).toBeInstanceOf(FsError)
      expect(error).toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    }
    expect(h.policies).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ mode: 'workspace-write', workspaceRoot: h.workspace })))
    expect(popup).toHaveBeenCalledTimes(2)
    expect(reviewer).toHaveBeenCalledTimes(kind === 'allow' ? 2 : 0)
    expect(h.builtInApproval).not.toHaveBeenCalled()
  })

  it.each(['danger-full-access', 'workspace-write'])('rejects explicit %s escalation before popup, approval or mutation', async (mode) => {
    const h = await harness()
    const path = join(h.outside, 'protected.txt')
    await writeFile(path, 'unchanged')
    const result = await h.execute(path, 'escalated write', mode)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('rejects sandbox escalation')
    expect(await readFile(path, 'utf8')).toBe('unchanged')
    expect(h.body).not.toHaveBeenCalled()
    expect(h.policies).toEqual([])
    expect(popup).not.toHaveBeenCalled()
    expect(reviewer).not.toHaveBeenCalled()
    expect(h.builtInApproval).not.toHaveBeenCalled()
  })
})
