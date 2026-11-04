import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type Entry } from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createMessage, ToolCallId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { parse, stringify } from 'yaml'

// Artifact-plane test: `pnpm test` builds lib/ before Vitest starts. Loader imports
// native ESM, not the source plugin or mocked module namespaces.
const BUILT_PLUGIN = new URL('../lib/index.js', import.meta.url).href
const SERVICES_FIXTURE = new URL('./fixtures/loader-services.mjs', import.meta.url).href
const PATCH = new URL('../cordis.patch.yml', import.meta.url)
const owned: Array<{ ctx: Context; directory: string; parent: string }> = []
const modeHomes: string[] = []

declare module '@deepseek-ai/cordis' {
  interface Context {
    loaderFixture: {
      session: Session; calls: number; reviews: number; reviewRequests: GenerateOptions[]
      afterApproval?: (exec: ToolRunContext) => Promise<void>
    }
  }
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function shippedPatch(): Promise<PatchOptions[]> {
  return parse(await readFile(PATCH, 'utf8')) as PatchOptions[]
}

async function boot(patches: PatchOptions[] = [], humanDecision: 'allow' | 'no_decision' = 'allow') {
  const parent = await realpath(tmpdir())
  const directory = await mkdtemp(join(parent, 'dsh-semi-auto-loader-'))
  const popupPath = join(directory, 'permission-popup')
  const requestsPath = join(directory, 'popup-requests.jsonl')
  const directAllow = humanDecision === 'no_decision' ? '' : JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  })
  await writeFile(popupPath, [
    '#!/bin/sh',
    '[ "$1" = "--host" ] && [ "$2" = "dsh" ] || exit 9',
    'IFS= read -r request',
    `printf '%s\\n' "$request" >> ${quoteShell(requestsPath)}`,
    humanDecision === 'no_decision' ? ':' : `printf '%s\\n' ${quoteShell(directAllow)}`,
    '',
  ].join('\n'), { mode: 0o700 })

  const warnings: string[] = []
  const rows = applyEntryPatches([
    { id: 'loader-services', name: SERVICES_FIXTURE, config: { workspace: directory } },
  ], [...await shippedPatch(), ...patches], message => { warnings.push(message) })
  expect(warnings).toEqual([])
  const semi = rows.find(row => row.id === 'semi-auto')
  expect(semi?.name).toBe('dsh-semi-auto')
  // A temporary standalone config has no profile installation resolver. Resolve
  // only this local package to the same built entry exported by its manifest.
  const configured = rows.map(row => row.id === 'semi-auto' ? { ...row, name: BUILT_PLUGIN } : row)
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, stringify(configured))

  const ctx = new Context()
  owned.push({ ctx, directory, parent })
  ctx.baseUrl = pathToFileURL(`${directory}/`).href
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // Exercise the normal native file-URL importer on every supported Node build.
  ctx.loader.internal = undefined
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'semi-auto')
  if (entry === undefined) throw new Error('Shipped bundle did not contribute a semi-auto Loader entry')
  expect(ctx.get('loaderFixture'), 'real DSH service fixture must finish mounting').toBeDefined()

  let step = 0
  const execute = (elevated: boolean | 'implicit' = false) => {
    const name = elevated === 'implicit' ? 'loader_implicit' : 'loader_probe'
    const session = ctx.loaderFixture.session
    const agent = { id: session.id, session, ctx, options: { provider: 'fixture', model: 'fixture' } } as Agent
    const callId = ToolCallId(`loader-probe-${++step}`)
    const args = elevated === true ? { sandbox_permissions: 'danger-full-access', justification: 'Test one native approval' } : {}
    const argumentsJson = JSON.stringify(args)
    if (session.requestHeader() === undefined) {
      session.append('turn/start', { turn: 1 })
      session.append('request/header', {
        header: {
          config: { provider: 'fixture', model: 'fixture' },
          tools: ['loader_probe', 'loader_implicit'].map(toolName => {
            const tool = ctx.tools.get(toolName, agent)!
            return { name: tool.name, description: tool.description, parameters: tool.parameters }
          }),
        },
        reason: 'initial',
      })
    }
    session.append('step/start', { turn: 1, step })
    session.append('assistant/message', {
      turn: 1, step, stream: [],
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
        content: [{ type: 'tool-call', id: callId, name, arguments: argumentsJson }],
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step, callId, name, arguments: argumentsJson })
    return ctx.tools.execute({
      name, arguments: args, callId,
      agent, signal: new AbortController().signal,
    })
  }
  return { ctx, entry, popupPath, requestsPath, execute, configured }
}

async function enable(entry: Entry, permissionPopupPath: string) {
  await entry.update({ disabled: false, config: { permissionPopupPath } })
  await entry.parent.tree.await()
  expect(entry.fiber?.state).toBe(2) // Cordis ACTIVE is a const enum, absent at native runtime.
}

function expectPolicy(ctx: Context, session: Session, approval: 'ask' | 'never') {
  expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('workspace-write')
  expect(ctx.approval.overrideOf(session) ?? ctx.approval.config.policy).toBe(approval)
}

beforeEach(async () => {
  modeHomes.push(await mkdtemp(join(tmpdir(), 'semi-auto-loader-mode-')))
  process.env.DSH_HOME = modeHomes[modeHomes.length - 1]
})

afterEach(async () => {
  while (owned.length) {
    const item = owned.pop()!
    try {
      await item.ctx.fiber.dispose()
    } finally {
      // Remove only the exact temporary directory this suite acquired.
      const target = await realpath(item.directory)
      if (dirname(target) !== item.parent || !target.startsWith(join(item.parent, 'dsh-semi-auto-loader-'))) {
        throw new Error(`Refusing to remove an unexpected Loader fixture directory: ${target}`)
      }
      await rm(target, { recursive: true, force: true })
    }
  }
  delete process.env.DSH_HOME
  while (modeHomes.length) await rm(modeHomes.pop()!, { recursive: true, force: true })
})

describe('built Semi Auto through real Cordis Loader and Include', () => {
  it('ships disabled and leaves the native permission policy and execution unchanged', async () => {
    const h = await boot()
    expect(h.entry.disabled).toBe(true)
    expect(h.entry.fiber).toBeUndefined()
    expectPolicy(h.ctx, h.ctx.loaderFixture.session, 'ask')
    expect(h.ctx.permissionPresets.current(h.ctx.loaderFixture.session)).toBe('workspace-write')
    expect((await h.execute()).isError).toBe(false)
    expect(h.ctx.loaderFixture.calls).toBe(1)
    expect(h.ctx.loaderFixture.reviews).toBe(0)
    await expect(readFile(h.requestsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts an explicit enabling patch and loads the built plugin with its shared DSH peers', async () => {
    const h = await boot([{
      id: 'semi-auto', name: 'dsh-semi-auto', disabled: false,
      config: { permissionPopupPath: '/test/unused-permission-popup' },
    }])
    expect(h.entry.disabled).toBe(false)
    expect(h.entry.fiber?.state).toBe(2)
    expect(h.entry.moduleNamespace).toMatchObject({ name: 'semi-auto', apply: expect.any(Function) })
    expect(h.configured.find(row => row.id === 'semi-auto')?.config).toEqual({
      permissionPopupPath: '/test/unused-permission-popup',
    })
    expectPolicy(h.ctx, h.ctx.loaderFixture.session, 'ask')
    const fresh = h.ctx.sessions.create(SessionId('loader-fresh'), {
      meta: { cwd: dirname(h.popupPath) },
    })
    expectPolicy(h.ctx, fresh, 'ask')
    await h.entry.fiber!.dispose()
    expectPolicy(h.ctx, fresh, 'ask')
    expectPolicy(h.ctx, h.ctx.loaderFixture.session, 'ask')
  })

  it('passes confined calls without popup or review across enable, disable and re-enable', async () => {
    const h = await boot()
    const session = h.ctx.loaderFixture.session
    await enable(h.entry, h.popupPath)
    expectPolicy(h.ctx, session, 'ask')
    const result = await h.execute()
    expect(result.isError, JSON.stringify(result)).toBe(false)
    expect(h.ctx.loaderFixture.calls).toBe(1)
    expect(h.ctx.loaderFixture.reviews).toBe(0)
    await expect(readFile(h.requestsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const fiber = h.entry.fiber!
    await h.entry.update({ disabled: true })
    await fiber.dispose()
    await h.entry.parent.tree.await()
    expectPolicy(h.ctx, session, 'ask')
    expect(h.ctx.permissionPresets.current(session)).toBe('workspace-write')
    expect((await h.execute()).isError).toBe(false)
    expect(h.ctx.loaderFixture.calls).toBe(2)
    expect(h.ctx.loaderFixture.reviews).toBe(0)

    await enable(h.entry, h.popupPath)
    expectPolicy(h.ctx, session, 'ask')
    expect((await h.execute()).isError).toBe(false)
    expect(h.ctx.loaderFixture.calls).toBe(3)
    expect(h.ctx.loaderFixture.reviews).toBe(0)
    await expect(readFile(h.requestsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await h.entry.fiber!.dispose()
    expectPolicy(h.ctx, session, 'ask')
  })

  it('opens the built popup adapter only for a native one-shot escalation', async () => {
    const h = await boot()
    const session = h.ctx.loaderFixture.session
    await enable(h.entry, h.popupPath)
    const elevated = await h.execute(true)
    expect(elevated.isError, JSON.stringify(elevated)).toBe(false)
    expect(h.ctx.loaderFixture.calls).toBe(1)
    expect(h.ctx.loaderFixture.reviews).toBe(0)
    expectPolicy(h.ctx, session, 'ask')
    const request = JSON.parse((await readFile(h.requestsPath, 'utf8')).trim())
    expect(request).toMatchObject({
      session_id: session.id, hook_event_name: 'PermissionRequest',
      tool_name: 'loader_probe',
      tool_input: {
        native_approval: {
          requestedMode: 'danger-full-access', reason: 'escalate sandbox to danger-full-access: Test one native approval',
        },
        tool_arguments: { sandbox_permissions: 'danger-full-access', justification: 'Test one native approval' },
      },
    })
    expect((await h.execute()).isError).toBe(false)
    expect(h.ctx.loaderFixture.calls).toBe(2)
    expect(h.ctx.loaderFixture.reviews).toBe(0)
    expect((await readFile(h.requestsPath, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('presents implicit native approval to the real popup and Auto review without permission arguments', async () => {
    const h = await boot([], 'no_decision')
    await enable(h.entry, h.popupPath)
    const result = await h.execute('implicit')
    expect(result.isError, JSON.stringify(result)).toBe(false)
    expect(h.ctx.loaderFixture.calls).toBe(1)
    expect(h.ctx.loaderFixture.reviews).toBe(1)
    const approval = {
      requestedMode: 'danger-full-access', reason: 'escalate sandbox to danger-full-access: Test implicit native approval',
    }
    const request = JSON.parse((await readFile(h.requestsPath, 'utf8')).trim())
    expect(request).toMatchObject({
      tool_name: 'loader_implicit', tool_input: { native_approval: approval, tool_arguments: {} },
    })
    const block = h.ctx.loaderFixture.reviewRequests[0]?.messages[0]?.content[0]
    if (block?.type !== 'text') throw new Error('Missing real Auto review input')
    const [action, native] = block.text.split('PENDING_ACTION\n')[1]!.split('\n\nNATIVE_PERMISSION_REQUEST\n')
    expect(JSON.parse(action!)).toMatchObject({ name: 'loader_implicit', arguments: {}, parameters: { properties: {} } })
    expect(JSON.parse(native!)).toEqual(approval)
    expectPolicy(h.ctx, h.ctx.loaderFixture.session, 'ask')
  })

  it.each(['disable', 'reload'] as const)('an implicitly approved body can await its own real Loader %s without deadlock or signal cancellation', async action => {
    const h = await boot()
    await enable(h.entry, h.popupPath)
    const originalFiber = h.entry.fiber!
    let continued = false
    let bodySignal: AbortSignal | undefined
    h.ctx.loaderFixture.afterApproval = async exec => {
      bodySignal = exec.signal
      if (action === 'disable') {
        await h.entry.update({ disabled: true })
        await originalFiber.dispose()
      } else {
        // Config updates restart the existing Fiber; disposing it would stop
        // the newly loaded epoch rather than join the configuration reload.
        await h.entry.update({ config: { permissionPopupPath: h.popupPath, popupTimeoutMs: 300000 } })
        await originalFiber.await()
      }
      await h.entry.parent.tree.await()
      expect(exec.signal.aborted).toBe(false)
      continued = true
    }
    const result = await h.execute('implicit')
    expect(result.isError, JSON.stringify(result)).toBe(false)
    expect(continued).toBe(true)
    expect(bodySignal?.aborted).toBe(false)
    expect(h.ctx.loaderFixture.calls).toBe(1)
    expect(h.ctx.loaderFixture.reviews).toBe(0)
    expectPolicy(h.ctx, h.ctx.loaderFixture.session, 'ask')
    if (action === 'disable') {
      expect(h.entry.disabled).toBe(true)
      // Entry retains the stopped Fiber handle after disabling.
      expect(originalFiber.uid).toBeNull()
      expect(originalFiber.state).toBe(4) // Cordis DISPOSED.
    } else {
      expect(h.entry.disabled).toBe(false)
      expect(h.entry.fiber?.state).toBe(2)
      expect(h.entry.fiber?.config.popupTimeoutMs).toBe(300000)
    }
    const request = JSON.parse((await readFile(h.requestsPath, 'utf8')).trim())
    expect(request.tool_input).toMatchObject({
      native_approval: { requestedMode: 'danger-full-access' }, tool_arguments: {},
    })
  })
})
