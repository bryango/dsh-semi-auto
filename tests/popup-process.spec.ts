import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { runPopup, type PopupRunnerConfig } from '../src/popup-runner.js'
import type { PopupRequest } from '../src/popup-protocol.js'

const contexts: Context[] = []
const directories: Array<{ root: string; parent: string }> = []

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  } finally {
    for (const { root, parent } of directories.splice(0)) {
      // Only remove the exact canonical, project-local directory this fixture created.
      const target = await realpath(root)
      expect(target).toBe(root)
      expect(dirname(target)).toBe(parent)
      expect(basename(target)).toMatch(/^\.test-popup-process-/)
      await rm(target, { recursive: true })
    }
  }
})

async function fixture(behavior: string, toolName = 'bash') {
  const parent = await realpath(process.cwd())
  expect(parent).toBe(await realpath(fileURLToPath(new URL('../', import.meta.url))))
  const root = await mkdtemp(join(parent, '.test-popup-process-'))
  directories.push({ root, parent })
  const binaryPath = join(root, 'permission-popup.cjs')
  const readyPath = join(root, 'ready.json')
  const stoppedPath = join(root, 'stopped')
  const request: PopupRequest = {
    sessionId: 'managed-popup-fixture',
    cwd: root,
    toolName,
    args: {
      behavior,
      command: 'printf "fixture only"',
      nested: { literal: 'spaces; $(not-a-command)', enabled: true },
    },
  }
  // Construct the expected wire data independently of the production encoder.
  const expected = {
    session_id: request.sessionId,
    transcript_path: '',
    cwd: root,
    permission_mode: 'auto',
    hook_event_name: 'PermissionRequest',
    tool_name: toolName === 'bash' ? 'Bash' : toolName === 'edit' ? 'Edit' : toolName === 'write' ? 'Write' : toolName,
    tool_input: request.args,
    permission_suggestions: [],
  }
  await writeFile(binaryPath, `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const expected = ${JSON.stringify(expected)};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    assert.deepEqual(process.argv.slice(2), ['--host', 'dsh']);
    assert.equal(process.cwd(), expected.cwd);
    assert.equal(input, JSON.stringify(expected) + '\\n');
    const payload = JSON.parse(input);
    assert.deepEqual(payload, expected);
    const behavior = payload.tool_input.behavior;
    if (!['allow', 'allow_direct', 'deny', 'no_decision', 'empty_nonzero', 'nonzero', 'malformed', 'sleep'].includes(behavior)) throw new Error('unsupported fixture behavior');
    if (behavior === 'sleep') {
      process.on('SIGTERM', () => {
        fs.writeFileSync(${JSON.stringify(stoppedPath)}, 'terminated');
        // Keep the process alive briefly: returning before draining is observable.
        setTimeout(() => process.exit(0), 50);
      });
      setInterval(() => {}, 1000);
      fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ pid: process.pid }));
      return;
    }
    fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ pid: process.pid }));
    if (behavior === 'malformed') {
      process.stdout.write('not authorization JSON\\n');
      return;
    }
    if (behavior === 'no_decision' || behavior === 'empty_nonzero') {
      process.exitCode = behavior === 'empty_nonzero' ? 7 : 0;
      return;
    }
    const decision = { behavior: behavior === 'nonzero' ? 'allow' : behavior };
    if (behavior === 'deny') decision.message = 'Fixture human denied.';
    process.exitCode = behavior === 'nonzero' ? 7 : 0;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }) + '\\n');
  } catch {
    process.stderr.write('Fixture argv or stdin validation failed.\\n');
    process.exitCode = 23;
  }
});
`)
  await chmod(binaryPath, 0o700)

  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  const handles: SubprocessHandle[] = []
  const drained: boolean[] = []
  // Instrument only range observation; every lookup, spawn, signal and wait is real.
  const runtime: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'> = {
    resolveExecutable: (path, env, signal) => ctx.subprocess.resolveExecutable(path, env, signal),
    spawn: spec => {
      const handle = ctx.subprocess.spawn(spec)
      handles.push(handle)
      return {
        ...handle,
        waitForExit: async signal => {
          const exited = await handle.waitForExit(signal)
          drained.push(exited)
          return exited
        },
      }
    },
  }
  const config: PopupRunnerConfig = {
    binaryPath,
    timeoutMs: 10_000,
    graceMs: 500,
    outputLimitBytes: 16_384,
  }
  async function ready(): Promise<number> {
    await expect.poll(async () => {
      try { return JSON.parse(await readFile(readyPath, 'utf8')) as { pid: number } }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    }, { timeout: 5_000 }).toEqual({ pid: expect.any(Number) })
    const value = JSON.parse(await readFile(readyPath, 'utf8')) as { pid: number }
    expect(Number.isSafeInteger(value.pid) && value.pid > 0).toBe(true)
    return value.pid
  }
  async function assertDrained(pid: number): Promise<void> {
    expect(handles).toHaveLength(1)
    expect(drained).toEqual([true])
    await expect(handles[0]!.waitForExit(AbortSignal.timeout(2_000))).resolves.toBe(true)
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  }
  return { request, runtime, config, ready, assertDrained, stoppedPath, handles }
}

describe('popup runner with managed local processes', () => {
  it.each([
    ['allow', 'bash'],
    ['allow_direct', 'edit'],
    ['allow', 'write'],
    ['allow', 'mcp__fixture__inspect'],
  ])('preserves %s for %s only after exact argv and stdin validation', async (behavior, toolName) => {
    const f = await fixture(behavior, toolName)
    const result = await runPopup(f.runtime, f.request, f.config, new AbortController().signal)
    expect(result).toEqual({ kind: behavior })
    await f.assertDrained(await f.ready())
  })

  it('preserves a disabled helper no-decision result only after successful exit and drain', async () => {
    const f = await fixture('no_decision')
    expect(await runPopup(f.runtime, f.request, f.config, new AbortController().signal))
      .toEqual({ kind: 'no_decision' })
    await expect(f.handles[0]!.done).resolves.toEqual({ exitCode: 0, signal: null })
    await f.assertDrained(await f.ready())
  })

  it('does not treat a real empty-output process failure as no decision', async () => {
    const f = await fixture('empty_nonzero')
    expect(await runPopup(f.runtime, f.request, f.config, new AbortController().signal))
      .toEqual({ kind: 'deny', reason: 'Permission popup exited unsuccessfully.' })
    await expect(f.handles[0]!.done).resolves.toEqual({ exitCode: 7, signal: null })
    await f.assertDrained(await f.ready())
  })

  it('preserves an explicit human denial', async () => {
    const f = await fixture('deny')
    expect(await runPopup(f.runtime, f.request, f.config, new AbortController().signal))
      .toEqual({ kind: 'deny', reason: 'Fixture human denied.' })
    await f.assertDrained(await f.ready())
  })

  it.each(['nonzero', 'malformed'])('rejects %s output even after valid request delivery', async behavior => {
    const f = await fixture(behavior)
    const result = await runPopup(f.runtime, f.request, f.config, new AbortController().signal)
    expect(result).toEqual({ kind: 'deny', reason: expect.any(String) })
    if (behavior === 'nonzero') await expect(f.handles[0]!.done).resolves.toEqual({ exitCode: 7, signal: null })
    await f.assertDrained(await f.ready())
  })

  it('terminates and drains a sleeping helper before returning timeout denial', async () => {
    const f = await fixture('sleep')
    // Leave room for real Node startup and assert the helper was actually running.
    const pending = runPopup(f.runtime, f.request, { ...f.config, timeoutMs: 2_000 }, new AbortController().signal)
    const pid = await f.ready()
    expect(await pending).toEqual({ kind: 'deny', reason: 'Permission popup timed out.' })
    expect(await readFile(f.stoppedPath, 'utf8')).toBe('terminated')
    await f.assertDrained(pid)
  })

  it('cancels only after the helper handshake and drains before returning', async () => {
    const f = await fixture('sleep')
    const controller = new AbortController()
    const pending = runPopup(f.runtime, f.request, f.config, controller.signal)
    const pid = await f.ready()
    controller.abort()
    expect(await pending).toEqual({ kind: 'deny', reason: 'Permission popup was cancelled.' })
    expect(await readFile(f.stoppedPath, 'utf8')).toBe('terminated')
    await f.assertDrained(pid)
  })
})
