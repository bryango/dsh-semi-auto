# dsh-semi-auto

在当前 DeepSeek Harness profile 中增加原生人工 popup 和 Auto review，
执行继续受 DSH 原生选择的 `read-only` 或 `workspace-write` 文件 sandbox 限制。
不修改上游源码，不替换权限服务或子代理服务，也不新增 permission preset。

## 行为

启用插件后，当前 profile 中已加载和新创建的会话仅将 approval 改成 `never`。
原生 `read-only` 或 `workspace-write` sandbox 选择保持不变；两者之间仍可通过原生菜单切换。
插件对官方 Auto 的候选调用全局生效，不依赖会话 preset 身份。
因此同进程 spawn、fork 和 Teams 的调用不需要继承新的 permission preset。
权限菜单可能显示 `Custom`，这是原生权限组合的显示结果，不代表插件未运行。

```text
pending tool call
  → permission-popup --host dsh
      ├─ Auto review / allow
      │    → vendored official Auto reviewer → downstream policies → sandboxed execution
      ├─ Authorize / allow_direct
      │    → downstream policies → sandboxed execution
      └─ Deny / invalid output / failure / timeout
           → deny
```

- `Authorize` 只跳过 Auto reviewer，不跳过其他拒绝策略或文件 sandbox。
- `Auto review` 每次使用当前会话最新持久化 request header 的 provider/model。
  它增加一次 LLM 请求，不提供缓存或自动重试。
- 人工拒绝、Auto 拒绝和 reviewer 故障均为最终拒绝，不打开内置二次审批。
- 明确的 `sandbox_permissions` 请求被拒绝；不能获得 one-shot full access。
- 外层 `run_code` 和官方 Auto 一样不弹窗、不审查；每个实际开始的 inner tool call 单独审核。
  `run_code` 内直接使用 Node API 的效果仅由原生 PTC sandbox 约束，不逐项弹窗。
- 空 stdout 也拒绝：关闭 popup 的托盘开关并不等于关闭本插件。
- 审核或排队期间权限发生不兼容变化，会取消本次授权，即使之后又切回原值。
- 宿主日志只记录 session/call/tool/result，不额外记录参数、reviewer reasoning 或 prompt。
  工具调用自身仍按 DSH 原有机制持久化。

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
所有仍然加载的受管会话仅将 approval 恢复为 `ask`，保留当时的 sandbox 选择。
例如 `read-only + never` 回到 `read-only + ask`。
如果手动选择了 full access，启用期间调用会被拒绝；关闭后该 sandbox 选择仍然保留，不会由插件偷偷改动。
官方 Auto 插件的注册和行为不受修改。
不响应取消的工具可能延迟关闭完成；插件不会提前移除保护或假称已完成清理。

关闭完成后再卸载：

```sh
dsh plugin --profile desktop remove dsh-semi-auto
```

其他未加载的持久化会话可能仍保留原 sandbox 与 `never`。
在插件关闭后打开这些会话时，可以通过原生权限菜单重新选择所需的 sandbox preset，恢复原生 approval 配置。
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
其输入上限是完整 JSON stdin（包含换行）8 MiB。

## 安全与范围

- popup 是可信宿主 UI，使用本地 `LocalSubprocessRuntime` 直接启动，不经过 agent bash sandbox。
  待执行工具是另一个操作，继续使用原生 sandbox；两者没有执行权限继承关系。
- 只接受本地 subprocess provider。
  已注册外部进程型 subagent provider 时，插件会拒绝启用；启用后也拒绝这类 provider 的新增注册。
  请先关闭外部 Codex/Claude/ACP 等 provider 插件，保留同进程 spawn/fork。
- 插件同时通过 pre-execute、单调 guard 和 execute 阶段检查授权与权限，
  其他普通 pre-execute listener 返回 allow 不能替代本插件的授权。
  同进程恶意插件本来就属于可信宿主代码，不是本插件能隔离的对象。
- 原生 `read-only` 与 `workspace-write` 选择保持有效，插件只将 `ask` 改为 `never`。
  菜单变更后的重新固定在事件发布后执行；每次工具授权入口也先固定 `never`，不依赖 UI 更新时序。
  切换 sandbox 会取消正在审核或排队的调用，下一次调用使用新的原生选择。
  选择 full access 或原生 Auto 不会关闭本插件，但启用期间调用会被拒绝；需要这些模式时先关闭本插件。
- `workspace-write` 不是网络隔离，也不限制读取所有工作区外文件。
  原生 filesystem provider 是可信路径检查；bash/PTC 代码由原生 OS sandbox 约束。
  MCP 或其他远端工具的服务端效果不因此被本地文件 sandbox 隔离。
- 模型审核不保证判断准确。popup 内容是待执行工具的实际参数，不能将其中的文字当作可靠指令。
- 复制的官方 prompt 保留其 full-host 风险假设；实际执行权限更窄。
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
分别点击 Auto review、Authorize、Deny，确认 reviewer 请求次数和工具效果；
再确认 read-only 写入拒绝、workspace-write 的工作区外写入拒绝，
关闭插件后不再弹窗、approval 恢复 ask，且 sandbox 选择保持不变。
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
