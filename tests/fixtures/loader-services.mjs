/** Real DSH services for the built-plugin Loader smoke; only the LLM is external-fixtured. */
import { Service } from '@deepseek-ai/cordis'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'

export const name = 'loader-services-fixture'

class FixtureState extends Service {
  calls = 0
  reviews = 0
  session
  constructor(ctx) { super(ctx, 'loaderFixture') }
}

class FixtureLlm extends Service {
  constructor(ctx) {
    super(ctx, 'llm')
    this.state = ctx.get('loaderFixture')
  }
  stream() {
    this.state.reviews++
    throw new Error('Direct authorization must not call the reviewer')
  }
}

export async function apply(ctx, config) {
  const state = new FixtureState(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: config.workspace })
  await ctx.plugin(LocalSandbox, {})
  await ctx.plugin(SandboxBashExecutor, { cwd: config.workspace })
  await ctx.plugin(SandboxedFileSystem, { cwd: config.workspace })
  await ctx.plugin(WorkingDirectoryService, { defaultDirectory: config.workspace })
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(PermissionPresetService, {
    defaultPreset: 'workspace-write',
    presets: {
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    },
  })
  state.session = ctx.get('sessions').create(SessionId('loader-existing'), { meta: { cwd: config.workspace } })
  ctx.get('tools').register(defineContentToolFixture({
    name: 'loader_probe',
    description: 'Count actual dispatches through the Loader-mounted tool pipeline',
    parameters: {},
    execute: async () => {
      state.calls++
      return [{ type: 'text', text: 'Loader tool body executed' }]
    },
  }))
  await ctx.plugin(FixtureLlm)
  // Publish the final required dependency only after the existing session is ready.
  await ctx.plugin(SubagentRuntime, {})
}
