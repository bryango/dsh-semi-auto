# dsh-semi-auto

在当前 DeepSeek Harness profile 中接管原生一次性 `danger-full-access` 审批，
通过人工 popup 选择直接授权、Auto review 或拒绝。
普通工具调用不弹窗、不做模型审核；其他审批继续走原生路径。
不修改长期 sandbox 或 approval policy，不替换权限服务或子代理服务，也不新增 permission preset。

## 行为

普通调用直接交给原生工具和其他策略，不弹 popup、不做 Auto review。
只有工具实际请求原生一次性 `danger-full-access` 审批，且 reason 匹配受支持的原生格式时，才接管。
是否需要 full access 由原生工具判断，不按命令风险或参数名提前触发。

```text
普通调用
  → downstream policies → native execution

其他原生审批（含 read-only → workspace-write）
  → native approval answerers

匹配的原生 danger-full-access 审批
  → permission-popup --host dsh
      ├─ Auto review / exit 0 + empty stdout → vendored official Auto reviewer → allow/deny
      ├─ disabled popup / exit 0 + empty stdout → Auto reviewer → allow/deny
      ├─ Authorize / allow → allowed-once
      └─ Deny / invalid output / failure / timeout → reject
```

- 原生审批服务继续负责审计和 `allowed-once` 的范围。
  允许 `danger-full-access` 后，本次操作确实可以在原 sandbox 外执行；
  它不是只允许进入审核，也不改变会话之后的长期 sandbox。
- `Authorize` 只跳过这次提权的 Auto reviewer，不跳过其他拒绝策略。
  它不撤销此前已经发生的拒绝。
- `Auto review` 使用当前会话最新持久化 request header 的 provider/model，明确请求 `reasoningEffort: low`。
  thinking 由 provider 按该档位启用；不支持时审核失败即拒绝，不静默降级。
  每次审核增加一次 LLM 请求，不提供缓存或自动重试。
- 人工拒绝、Auto 拒绝和 reviewer 故障均为最终拒绝，不打开内置二次审批。
  每个后续原生 full-access 请求都要重新决定，不缓存或复用授权。
- 工具无需在 schema 或参数中声明 `sandbox_permissions`／`justification` 才能接管。
  `plugin_manager` 等通过相同原生 helper 发出的 full-access 请求也受支持。
  仅在参数里添加这些字段不会弹窗；缺失、无效参数或重复当前 mode 仍由原生工具处理。
- sandbox 拒绝本身不会自动重试或弹窗；需要重试时，代理须遵守原生工具的提权规则。
- 普通外层 `run_code` 和 inner tool call 均不审核。
  若其中某次调用实际请求受支持的 full-access 审批，则针对该调用弹窗；
  外层 `run_code` 的获准范围可能覆盖该次完整程序。
  普通 `run_code` 内直接使用 Node API 的效果仅由原生 PTC sandbox 约束，不逐项审核。
- 原生 `never` 在审批 answerer 之前直接拒绝，因而不会弹 popup。
  同进程子代理原生继承的 `never` 也保持不变；插件不自动放宽其提权权限。
- 只有 pending popup/review 会因 sandbox／approval 变化而取消，即使之后又切回原值。
  已获授权的工具可继续执行；插件不会撤回已发出的原生单次授权或取消其工具 body。
- 宿主日志只记录 session/call/tool/result，不额外记录参数、reviewer reasoning 或 prompt。
  工具调用自身仍按 DSH 原有机制持久化。

### 原生审批的兼容范围

支持的 rc.3／rc.5 `approveEscalation` helper 使用固定 reason prefix：

```text
'escalate sandbox to danger-full-access: '
```

prefix 后须有非空理由；插件保留并展示完整原生 reason。
这两个版本的审批 API 没有结构化 target mode 或 scope，
因此这是版本绑定的格式适配，不是对所有第三方审批的通用识别。
未知格式、普通 ask 和 `read-only → workspace-write` 请求均 `next()`，交由原生 answerer 链处理。
第三方请求若不使用此 helper／格式，不保证由本插件接管；升级 DSH 时须重新核对。

### Popup 与 reviewer 上下文

`PopupRequest.approval` 在 popup 的 `tool_input` 中与原始参数分开：

```json
{
  "native_approval": {
    "requestedMode": "danger-full-access",
    "reason": "escalate sandbox to danger-full-access: <原生完整理由>"
  },
  "tool_arguments": { "<原始参数名>": "<原始参数值>" }
}
```

这是显示上下文；真实工具执行参数不变。
已有 binary 可完整展示这份 JSON，无需识别新增字段。
`reviewTool` 可选接收同一 `FullAccessApproval`，
在额外的 `NATIVE_PERMISSION_REQUEST` 分区中呈现授权目标和完整理由，作为事实输入而不是指令。
复制的官方 policy 保持不变。

### 输入框旁的开关

输入框下方工具行内、原生权限选择器右侧有一个 Semi Auto 开关（客户端插件，`conversation.input.left`）。
点击即切换模式；状态以 3 秒轮询同步，多窗口一致。

- 关闭时，新调用不做 Auto review、不弹 popup，原生审批 answerer 链原样接管。
  已入场调用及 pending popup/review 保留既有路径，不因开关切换而中断。
- 切换只影响新进入 pre-execute 的调用；已准备或正在执行的调用保持原有审批路径。
  开启后新调用恢复上述 full-access broker 行为。
- 模式持久化在 `$DSH_HOME`（默认 `~/.dsh`）下的
  `plugins/semi-auto/mode.json`；文件缺失或损坏时默认开启。
  并发切换按接收顺序串行写入，避免临时文件冲突和重启后状态回退。
- 开关通过共享 `/api` 通道的 `semi-auto.get`／`semi-auto.set` 端点读写；
  `set` 仅接受布尔 `enabled`。headless 组合没有 connection 服务，不挂路由。

### 空响应与原生权限菜单

popup 托盘配置 `enabled: false` 时，binary 正常退出且 stdout 为空，表示 **no decision**。
插件此时继续 Auto review；只有 reviewer 允许后才授权本次执行。
空输出不是人工允许或拒绝，也不会跳过 reviewer。
仅正常退出、无截断且完整 stdout 为零字节时采用这一语义；纯空白或无效 JSON、异常退出、超时及清理失败仍拒绝。

原生权限 preset 同时匹配 sandbox 和 approval。
旧版固定 `never` 的实现会使 `workspace-write + ask` 变为 `Custom`。
当前插件不覆盖原生 policy，也不修改菜单、preset 表或匹配规则。

## 启用与关闭

**支持 DSH `0.2.1-rc.3` 和 `0.2.1-rc.5`，本地 macOS 标准 profile；当前开发依赖和测试基线为 rc.5。**
已核对官方 commit `b830ec950faba0a46dda564be3e2d854afed94f1` 的实际源码和发布类型；
核对的 approval、agent/tools、sandbox、hook-protocol/hooks、Connection RPC 和 remote API 相比 rc.3 无源码变更，
输入框开关的 slot 也未改变。
需要可用的原生 `permission-popup --host dsh` 和当前会话的 LLM provider。
popup 使用与 Codex 相同的决定：空 stdout 表示交给 Auto review，`allow` 表示直接授权，`deny` 表示拒绝。
采用旧 `allow`＝Auto review 语义的 popup 必须一起升级；旧的 `allow_direct` 响应不再支持。
使用上述响应协议、能完整展示 JSON 的已有 binary 可继续使用。

先构建安装包：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack
```

用当前 DSH 对应的 CLI，将包安装到当前 profile；不要为了使用本插件另开服务器。
下面用 `desktop` 举例，Web CLI 用户将其替换为自己正在使用的 profile：

```sh
dsh plugin --profile desktop add /absolute/path/dsh-semi-auto-0.3.0.tgz
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
确认 entry 为 ACTIVE 后再开始工作；PENDING 或 FAILED 不提供本插件的审批路径。
在停下当前所有会话的工具任务后启用，插件不会回溯接管启用前已开始执行的工具。

关闭时，在插件界面关闭 **semi-auto entry**，或改为：

```yaml
- id: semi-auto
  name: dsh-semi-auto
  disabled: true
```

关闭或卸载 entry 会停止新授权，取消并等待 pending popup/reviewer 清理，再移除拦截器。
它不会取消或等待已获授权的工具 body，避免 `plugin_manager` 自卸载或 reload 时互相等待。
已获授权的工具可继续执行，其生命周期由原生执行器管理。
这与输入框旁的模式开关不同：模式切换不会取消 pending 审批。
启用和关闭都不更改会话的 approval 或 sandbox，
因此关闭后原生权限组合保持当时的选择，而不是统一写回 `ask`。
手动选择 full access 或原生 Auto 时，普通调用也不被本插件拒绝或额外审核；
官方 Auto 插件自身的注册和审核行为不受修改。

关闭完成后再卸载：

```sh
dsh plugin --profile desktop remove dsh-semi-auto
```

### 升级到 0.3.0

0.3.0 不再审核普通调用，这是安全行为变化，不只是减少 popup。
网络操作、远端工具效果和 workspace 内删除等操作，
如果原生工具不要求 full access，就不会经过本插件的模型审核。
是否要求 full access 由原生工具判断；本插件不提供通用命令风险扫描或远端权限隔离。
`read-only → workspace-write` 和其他普通 ask 改回原生审批路径；
通过共享 helper 发起的隐式 full-access 审批（含 `plugin_manager`）现在可以接管。
升级前先停止工具任务、关闭旧 entry 并等待旧版清理，再替换和重新启用。

从旧版 `0.1.0` 的固定 `never` 实现升级时，
须先等旧插件完成清理、恢复其受管会话的 `ask`。
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
- popup 仍要求本地 subprocess provider，但不再限制外部 subagent provider 的注册。
  Codex／Claude／ACP 等外部 provider 自有的权限和审批不由本插件接管，
  也不保证其工具效果经过 DSH 的本地 sandbox 或本插件审核。
- 本插件只决定匹配的原生 full-access 审批，不替代其他工具策略。
  同进程恶意插件本来就属于可信宿主代码，不是本插件能隔离的对象。
- 原生 sandbox 与 approval policy 保持有效，不固定 `never`。
  提权 answerer 需要 `ask`；`never` 仍按原生规则在插件弹窗前拒绝。
  full access 和原生 Auto 的长期权限也不改动；普通调用直接遵守当前原生设置。
- `workspace-write` 不是网络隔离，也不限制读取所有工作区外文件。
  原生 filesystem provider 是可信路径检查；bash/PTC 代码由原生 OS sandbox 约束。
  MCP 或其他远端工具的服务端效果不因此被本地文件 sandbox 隔离。
- 模型审核不保证判断准确。popup 展示原生审批上下文和实际工具参数，
  参数及理由中的文字不能当作可靠指令。
- 复制的官方 prompt 保留其 full-host 风险假设，policy 不变。
  实际执行权限仍由原生工具决定；获准提权使用原生工具授予的单次范围。
  源码版本及更新方法见 [UPDATING.md](UPDATING.md)。

## 开发与验证

```sh
pnpm typecheck
pnpm test
pnpm build
node scripts/generate-reviewer.mjs --check
```

测试包括严格 popup 协议、进程取消/清理、真实 Cordis/rc5 工具执行、
三按钮顺序、权限变化和卸载竞态、官方 reviewer 的持久化历史重建、
PTC inner-call 校验、真实 filesystem workspace/outside-workspace 写入。
测试不调用真实 LLM，不自动操作 AppKit 窗口。

手动验收应在实际已加载插件的 profile 中进行：
确认普通调用（含 PTC inner call）不做 Auto、不弹窗，sandbox 拒绝不会自动弹窗或重试；
再提交原生 full-access 请求，分别点击 Auto review、Authorize、Deny，确认审核次数和单次工具效果。
确认 `never` 下的提权不弹窗而直接拒绝，workspace-write 提权和普通 ask 仍走原生审批。
确认 popup 同时展示原生完整理由和原始参数，而真实执行参数不变。
关闭 popup 托盘开关后，full-access 请求不弹窗但必须经过 Auto review；确认审核结果仍决定本次授权。
切换模式时 pending 审批保留原路径；卸载时 pending 审批取消，但已授权工具不被取消或等待。
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
