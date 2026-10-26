# dsh-semi-auto

在当前 DeepSeek Harness profile 中增加 Auto review，
仅在原生一次性提权审批出现时打开人工 popup。
保留原生 `read-only`／`workspace-write` sandbox 和 approval policy 选择，
不修改上游源码，不替换权限服务或子代理服务，也不新增 permission preset。

## 行为

普通 sandbox 内调用只做 Auto review，不弹 popup。
只有工具实际向原生审批服务请求一次性扩大权限时，才弹 popup；
插件不会仅因参数里出现 `sandbox_permissions` 就提前弹窗。
启用和关闭都不写入 sandbox 或 approval policy，
原生 `read-only`／`workspace-write` 选择及 `ask`／`never` 决策保持有效。

```text
普通 sandbox 调用
  → vendored official Auto reviewer → downstream policies → sandboxed execution

原生有效提权审批
  → permission-popup --host dsh
      ├─ Auto review / allow → vendored official Auto reviewer → allowed-once
      ├─ disabled popup / exit 0 + empty stdout → Auto reviewer → allowed-once
      ├─ Authorize / allow_direct → allowed-once
      └─ Deny / invalid output / failure / timeout → reject
```

- 原生审批服务继续负责审计和 `allowed-once` 的范围。
  允许 `danger-full-access` 后，本次操作确实可以在原 sandbox 外执行；
  它不是只允许进入审核，也不改变会话之后的长期 sandbox。
  `read-only → workspace-write` 同样是需要原生审批的扩大权限，虽然并非完全无 sandbox。
- `Authorize` 只跳过这次提权的 Auto reviewer，不跳过其他拒绝策略。
  它不撤销此前已经发生的审核拒绝。
- `Auto review` 使用当前会话最新持久化 request header 的 provider/model，明确请求 `reasoningEffort: high`。
  thinking 由 provider 按该档位启用；不支持时审核失败即拒绝，不静默降级。
  每次审核增加一次 LLM 请求，不提供缓存或自动重试。
- 人工拒绝、Auto 拒绝和 reviewer 故障均为最终拒绝，不打开内置二次审批。
  缺失或无效提权参数仍先按普通调用做 Auto，再由原生工具验证；重复当前 mode 不需要提权弹窗。
  只有可信工具定义明确声明 `sandbox_permissions` 和 `justification` 时，才能将 Auto 延后到实际审批。
  普通工具多带这两个参数不能跳过 Auto。
- 没有声明原生提权参数的隐式审批暂不接管，默认拒绝且不回退内置审批。
  例如 `plugin_manager` 的内部 full-access 审批不受支持；请通过 GUI 管理插件。
  这也避免从正在运行的工具中卸载其自身审核插件产生清理等待。
- sandbox 拒绝本身不会自动重试或弹窗；代理必须按原生规则显式重试，
  同时提供有效的 `sandbox_permissions` 和 `justification`。
- 普通外层 `run_code` 和官方 Auto 一样不弹窗、不审查；每个实际开始的 inner tool call 单独做 Auto。
  如果外层 `run_code` 自身请求扩大权限，则 popup 和 Auto review 的对象是整个待执行程序，
  不能按普通 transport 跳过；获准范围可能覆盖该次完整程序。
  普通 `run_code` 内直接使用 Node API 的效果仅由原生 PTC sandbox 约束，不逐项审核。
- 原生 `never` 在审批 answerer 之前直接拒绝，因而不会弹 popup。
  同进程子代理原生继承的 `never` 也保持不变；插件不自动放宽其提权权限。
- 审核或排队期间 sandbox／approval 变化，会取消本次授权，即使之后又切回原值。
- 宿主日志只记录 session/call/tool/result，不额外记录参数、reviewer reasoning 或 prompt。
  工具调用自身仍按 DSH 原有机制持久化。

### 空响应与 Custom 菜单调查

popup 托盘配置 `enabled: false` 时，binary 正常退出且 stdout 为空，表示 **no decision**。
插件此时继续 Auto review；只有 reviewer 允许后才授权本次执行。
空输出不是人工允许或拒绝，也不会跳过 reviewer。
仅正常退出、无截断且完整 stdout 为零字节时采用这一语义；纯空白或无效 JSON、异常退出、超时及清理失败仍拒绝。

原生权限 preset 同时匹配 sandbox 和 approval。
旧实现把 `workspace-write + ask` 改成 `workspace-write + never`，
因此原生菜单派生为 `Custom`。
本轮只调查这一问题，不修改 UI、preset 表或匹配规则。
新审核路径不再覆盖原生 policy，所以正常原生选择可继续按原有规则显示；
这不是新增的菜单显示修补。

## 启用与关闭

**只支持 DSH `0.2.1-rc.3`，本地 macOS 标准 profile。**
需要可用的原生 `permission-popup --host dsh` 和当前会话的 LLM provider。
popup 必须支持 `allow`、`allow_direct` 和 `deny` 三种 DSH 响应。

先构建安装包：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack
```

用当前 DSH 对应的 CLI，将包安装到当前 profile；不要为了使用本插件另开服务器。
下面用 `desktop` 举例，Web CLI 用户将其替换为自己正在使用的 profile：

```sh
dsh plugin --profile desktop add /absolute/path/dsh-semi-auto-0.1.0.tgz
```

安装默认只添加一个 **disabled** 的 `semi-auto` entry，不立即改变会话权限。
在当前 profile 的 `cordis.patch.yml` 增加以下覆盖，配置真实 binary 绝对路径：

```yaml
- id: semi-auto
  name: dsh-semi-auto
  disabled: false
  config:
    permissionPopupPath: /Users/bryan/Documents/codex/agent-permission-popup/build/permission-popup
```

也可以在 DSH 插件配置界面填写路径，然后启用 `semi-auto` entry。
生效方式取决于宿主：支持 live reload 时即时应用，否则按 DSH 的提示重启。
确认 entry 为 ACTIVE 后再开始工作；PENDING 或 FAILED 不提供审核保护。
在停下当前所有会话的工具任务后启用，插件不会回溯审核启用前已开始执行的工具。

关闭时，在插件界面关闭 **semi-auto entry**，或改为：

```yaml
- id: semi-auto
  name: dsh-semi-auto
  disabled: true
```

关闭会停止新授权，取消 popup/reviewer 和在途工具的生命周期信号，
等待相关调用完成，再移除拦截器。
启用和关闭都不更改会话的 approval 或 sandbox，
因此关闭后原生权限组合保持当时的选择，而不是统一写回 `ask`。
如果手动选择了 full access，启用期间调用会被拒绝；关闭后该 sandbox 选择仍然保留，不会由插件偷偷改动。
官方 Auto 插件的注册和行为不受修改。
不响应取消的工具可能延迟关闭完成；插件不会提前移除保护或假称已完成清理。

关闭完成后再卸载：

```sh
dsh plugin --profile desktop remove dsh-semi-auto
```

从旧版 `0.1.0` 的固定 `never` 实现升级时，先停下工具任务并关闭旧 entry，
待旧插件完成清理、恢复其受管会话的 `ask` 后，再构建并重新启用。
旧版未加载的持久化会话可能仍保留 `never`；
重新打开后可通过原生权限菜单明确选择所需 preset，恢复相应原生 policy。
新版不会把这些 `never` 自动改成 `ask`，以免放宽用户有意设置的限制。
插件退出或整个进程崩溃不提供“启动时必定存在”的保证，
重启后必须确认插件 ACTIVE；插件缺席时原生 DSH 不会继续替它运行 popup/Auto。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `permissionPopupPath` | 必填 | 可信 popup executable 的绝对路径，不经过 shell |
| `popupTimeoutMs` | `600000` | 包括 executable lookup、运行和正常清理的外层超时 |
| `processGraceMs` | `1000` | subprocess provider 的进程清理 grace period |
| `outputLimitBytes` | `65536` | stdout/stderr 各自的内存上限；stdout 截断即拒绝 |

DSH 的 patch 整体替换 `config`，覆盖其他配置时仍需填写 `permissionPopupPath`。
popup 自身的默认队列/窗口 deadline 是 540 秒；其环境变量及托盘设置仍由 popup 项目管理。
托盘开关开启时显示人工 popup；关闭时返回 no decision，直接进入 Auto review，
不会直接允许、直接拒绝或回退为内置审批。
其输入上限是完整 JSON stdin（包含换行）8 MiB。

## 安全与范围

- popup 是可信宿主 UI，使用本地 `LocalSubprocessRuntime` 直接启动，不经过 agent bash sandbox。
  待执行工具是另一个操作；popup 进程本身不携带工具执行权限，
  真正的一次性扩大权限仍由原生审批服务和调用工具执行。
- 只接受本地 subprocess provider。
  已注册外部进程型 subagent provider 时，插件会拒绝启用；启用后也拒绝这类 provider 的新增注册。
  请先关闭外部 Codex/Claude/ACP 等 provider 插件，保留同进程 spawn/fork。
- 插件同时通过 pre-execute、单调 guard 和 execute 阶段检查授权与权限，
  其他普通 pre-execute listener 返回 allow 不能替代本插件的授权。
  同进程恶意插件本来就属于可信宿主代码，不是本插件能隔离的对象。
- 原生 `read-only` 与 `workspace-write` 选择及 approval policy 保持有效，不固定 `never`。
  原生提权 answerer 需要 `ask`；`never` 仍按原生规则在插件弹窗前拒绝。
  切换 sandbox 或 approval 会取消正在审核或排队的调用，下一次调用使用新的原生选择。
  选择 full access 或原生 Auto 不会关闭本插件，但启用期间调用会被拒绝；需要这些模式时先关闭本插件。
- `workspace-write` 不是网络隔离，也不限制读取所有工作区外文件。
  原生 filesystem provider 是可信路径检查；bash/PTC 代码由原生 OS sandbox 约束。
  MCP 或其他远端工具的服务端效果不因此被本地文件 sandbox 隔离。
- 模型审核不保证判断准确。popup 内容是待执行工具的实际参数，不能将其中的文字当作可靠指令。
- 复制的官方 prompt 保留其 full-host 风险假设；普通调用实际执行权限由当前 sandbox 限定，
  获准的提权调用则使用原生工具授予的单次范围。
  本插件不修改其风险策略，源码版本及更新方法见 [UPDATING.md](UPDATING.md)。

## 开发与验证

```sh
pnpm typecheck
pnpm test
pnpm build
node scripts/generate-reviewer.mjs --check
```

测试包括严格 popup 协议、进程取消/清理、真实 Cordis/rc3 工具执行、
三按钮顺序、权限变化和卸载竞态、官方 reviewer 的持久化历史重建、
PTC inner-call 校验、真实 filesystem workspace/outside-workspace 写入。
测试不调用真实 LLM，不自动操作 AppKit 窗口。

手动验收应在实际已加载插件的 profile 中进行：
确认普通 sandbox 调用只做 Auto、不弹窗，sandbox 拒绝不会自动弹窗或重试；
再提交原生有效提权请求，分别点击 Auto review、Authorize、Deny，确认审核次数和单次工具效果。
确认 `never` 下的提权不弹窗而直接拒绝，普通外层 PTC 与外层 PTC 提权路径区分正确。
关闭 popup 托盘开关后，提权不弹窗但必须经过 Auto review；确认 reviewer 的允许／拒绝仍然决定本次执行。
关闭插件后不再有本插件的审核或 popup，approval 和 sandbox 均保持原生选择。
完整 macOS UI、真实 LLM 和 OS bash/PTC worker confinement 需要额外实机验收，
不能用单元测试通过代替这些结论。

开发依赖使用 Rollup WASM，避免签名 Node 对外部 native addon 的 Team ID 加载限制。
此设置不改变发布插件的运行时代码。

## 许可证

Copyright (c) 2026 dsh-semi-auto contributors.
本项目整体使用 **GNU GPL version 3 only（SPDX: `GPL-3.0-only`）**，
可依其条款重新分发和修改；不提供任何担保，包括适销性或特定用途适用性的默示担保。
完整条款见 [LICENSE](LICENSE)。

复制的 DeepSeek Harness 源码原本使用 MIT，与 GPLv3 兼容；
其原始版权及 MIT 授权声明保留在 [第三方声明](THIRD_PARTY_NOTICES.md) 和 [上游许可证](vendor/upstream/LICENSE) 中。
发布包同时包含 TypeScript 源码、生成脚本、锁文件及构建配置，便于接收者修改和重新构建。
其他独立依赖及外部 popup 程序保留各自的许可证。
