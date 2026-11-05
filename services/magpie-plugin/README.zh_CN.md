[English](README.md) · **简体中文**

# Agent Pet Magpie 适配器

可安装的宿主适配器和浏览器 companion，精确支持 **DSH 0.2.2-rc.1**。宿主读取获准的存活注册表和投影，向桥接服务发送最小脱敏摘要，将鉴权后的会话跳转意图交给存活的 owner 客户端。Companion 调用 `uiWorkspace.openSession` 并检查实际选中的会话。不承诺操作系统聚焦或 deep link。

## 包和审核

包名：`@ai-passport/dsh-agent-pet@0.2.1`。清单导出宿主入口 `./src/index.mjs`、浏览器包 `./src/client.js`、包清单与 `./cordis.patch.yml`。`dsh.bundle.patch` 插入 Cordis 行 `agent-pet-adapter`，模块为 `@ai-passport/dsh-agent-pet`。`dsh.client` 声明 web 平台以及已有 DSH Gateway、Workspace UI 模块依赖。浏览器文件使用已打包的 `window.__ModuleLoader__.load({id,factory})` 格式。

无安装脚本、原生资源、后台 sidecar 或宿主源码补丁，直接分发 JavaScript。浏览器封装由共享 Remote 描述和浏览器安全的 companion 核心确定性生成：

```sh
cd services/magpie-plugin
npm ci --ignore-scripts --legacy-peer-deps
npm run build
npm test
mkdir -p dist
npm pack --ignore-scripts --pack-destination dist
```

审核 tarball 后，通过目标 DSH profile 的插件 UI 安装。CLI 管理的测试 profile 可使用 `dsh plugin --profile <test-profile> add <absolute-tarball-path>`。Desktop profile 由应用管理，不要通过 CLI 管理保留的 desktop profile 或手动改其文件。全局安装、激活与重载由 lead/操作者审核后执行；打包和测试不执行这些操作。不要授予版本豁免绕过不兼容。

## 安全的实时连接配置

默认 bundle 仅读取明确指定的 Agent Pet 连接文件 `~/.config/agent-pet/magpie.json`，不读取 DSH 个人会话数据库或 DSH 配置文件。项目 setup/操作者只在审核后使用桥接服务限定来源的凭据和明确获准的会话 ID 生成此文件。读取器不会创建或改写文件。

文件必须是当前用户所有的普通非符号链接文件，权限精确为 **0600**，最多 8192 字节。打开使用 `O_NOFOLLOW|O_NONBLOCK`，验证打开后描述符的类型、所有者和权限，读取有界。所有者/权限错误、符号链接、无效 JSON 或未知字段以脱敏类别阻止激活。文件不存在且无环境凭据时，插件保持 inactive，不导出数据。Inactive 激活后才创建文件，需要开关插件重新读取；修改凭据不会静默切换已激活的连接。

精确文件格式；以下值全部为示例：

```json
{
  "bridgeUrl": "http://127.0.0.1:7445",
  "sourceId": "magpie-local",
  "ipcToken": "<separate-bridge-ipc-token>",
  "sourceToken": "<scoped-source-token>",
  "sessionIds": ["approved-session-id"]
}
```

`sessionIds` 必须是非空显式允许列表。文件配置强制 `includeAllSessions:false`，文件中不接受该字段。真实凭据应为 32-512 个可打印 ASCII 字符。不要提交连接文件或真实会话 ID，也不要将凭据放入补丁、浏览器代码、URL 或日志。桥接 URL 只接受 HTTP 字面量回环 origin `127.0.0.1`，无路径、URL 身份信息、查询参数或片段。IPC 只能绑定回环地址并拒绝浏览器 Origin 请求。

继续支持环境凭据，且其优先于文件 token。默认变量为 `AGENT_PET_IPC_TOKEN`、`AGENT_PET_SOURCE_TOKEN`。已有部署可配置 Cordis 行的 `sourceId`、`bridgeUrl`、`ipcTokenEnv`、`sourceTokenEnv`、`sessionIds`、`includeAllSessions` 及可选绝对路径 `connectionFile`。空路径采用上述默认文件。仅环境模式下，默认空选择不导出会话，`includeAllSessions:true` 是高级显式授权；存在文件时，其来源、地址和精确允许列表优先于行默认值，全部会话导出被关闭。文件路径和配置不会成为浏览器凭据通道。

## 兼容性和实际 API

`engines.dsh` 和激活时 `getDshRuntimeVersion()` 均要求精确 `0.2.2-rc.1`。运行依赖：`@deepseek-ai/schemastery@3.19.0`、`zod@4.4.3`。精确宿主 peer：Cordis `4.1.0`；DSH app-boot、session、agent、session-projection、token-meter、user-questions、typert-protocol、typert-registry、api-gateway、client-ui-workspace `0.2.2-rc.1`。Profile 解析提供宿主 peer，避免重复注册表。这些内部 hook 仅支持锁定版本。

只读证据来自安装包 `dsh/node_modules/@deepseek-ai/` 源码和清单，不包含个人会话样本：

| 能力 | 已打包证据 | 用途 |
| --- | --- | --- |
| 可安装 bundle | `dsh-experimental-forge-bundle/package.json:50`、其 `cordis.patch.yml`；`dsh-app-boot/lib/index.js:1301,3080` | 实际补丁合成与兼容性检查 |
| 浏览器插件 | `dsh-client-ui-shortcuts/package.json:29`；`dsh-client-modules/lib/index.js:32` | `dsh.client`、`./client`、延迟模块工厂 |
| 存活会话 | `dsh-session/lib/index.js:1999,2006` | `sessions.get/list` 与精确存活实例检查 |
| 会话事件 | `dsh-session/lib/index.js:1583,1924` | 全局 created/event/disposed 观察，显式过滤选择 |
| 代理与回合 | `dsh-agent-loop/lib/index.js:554,731,819` | 代理状态、宿主私有 `petLifecycle` 归约 |
| 投影 | `dsh-session-projection/lib/index.js:156,193,232` | 等待句柄、选定 snapshot、onChanged |
| 提供方 token | `dsh-token-meter/lib/index.js:394-427,803` | 权威 `tokenUsage` 视图 |
| 提问 | `dsh-user-questions/lib/index.js:170,676-712` | 持续问题投影与原样委托的 request waterfall |
| 类型化宿主/客户端通道 | `dsh-typert-registry/lib/index.js:460`；`dsh-api-gateway/lib/client.node.js:1485` | 严格描述注册和 `remote.$mount` |
| Owner 来源 | `dsh-api-gateway/lib/index.js:1200-1244`；`dsh-typert-protocol/lib/index.js:338` | Gateway 注入调用 peer，导航服务仅允许 owner |
| 跳转确认 | `dsh-client-ui-workspace/lib/client.js:1473,1661-1684` | `openSession(id)` 后检查 `selection.getSnapshot().sessionId` |

`agentPetNavigation` Remote 命名空间暴露 `poll(clientId)`、`result(clientId,commandId,status)`、`leave(clientId)` 和仅 owner 可用的 `diagnostics()`。宿主与客户端共享显式编写的严格 Typert 描述，无源码反射回退或任意端点执行。Remote 调用必须来自 Gateway 的 owner principal，独立于更宽泛的非 owner 访问策略。凭据仅留在宿主。

0.2.1 增加只读 `agentPetNavigation/diagnostics` 端点，请求为 `{args:{}}`。仅返回已配置/存活/具有存活代理的选择计数、队列/捕获/IPC 计数、active 标记和固定故障阶段枚举；不包含会话 ID、来源 ID、凭据、标题、路径或异常文本。调用诊断不会取得浏览器租约，也不会声明跳转能力。心跳 fresh 仅证明来源在线，不证明捕获成功；没有任务时应对照 selected-live、captured 和 event accepted 计数。每次心跳都会重新发布所选当前完整状态，即使宿主日志没有变化，重启后为空的桥接也无需新的用户事件即可恢复。

## 桥接与跳转契约

所有 IPC 使用 `Authorization: Bearer <ipc-token>`，无浏览器 Origin：

- `POST /v1/events`：`{source_credential,event}`。
- `POST /v1/source/heartbeat`：`{source_credential,connected}`，每 15 秒发送；卸载时排空更早请求后尽力发送 false。
- `GET /v1/commands`：限定来源的 token 放入 `X-Source-Credential`；返回 `{commands:[{command_id,type:"open_on_host",session_id}]}`。
- `POST /v1/commands/result`：`{source_credential,command_id,status}`，status 为 `succeeded`、`failed`、`unknown`。

浏览器不直接访问回环服务，通过 DSH 已有鉴权连接挂载类型化命名空间。可见的 owner 客户端每秒轮询，持有五秒宿主租约。每条意图只交给一个客户端。丢失租约后，其他客户端也不会接管已分配的意图，桥接在 30 秒后返回 unknown。隐藏或卸载的客户端释放/过期租约。能力随租约过期并重新发布到桥接。目标会再次检查是否属于获准的精确存活会话。

调用 `uiWorkspace.openSession` 前，客户端先记录命令 ID 和 unknown 决策，在保留窗口内至多调用该 ID 一次。只有选择存储显示目标会话才报告 succeeded；跳转抛出异常报告 failed；无法确认选择则为 unknown。重试发送相同决策，不再次跳转。宿主和客户端各最多保留 256 条意图、60 秒，计时使用单调时钟。页面/进程崩溃会丢失易失去重状态，不承诺跨进程恰好一次。桥接负责持久化操作状态和超时。跳转成功仅表示 DSH 内选中会话，不代表操作系统聚焦或内容加载完成。

事件字段为 `source_id`、`session_id`、`run_id`、安全整数 `revision`、通用标题、`entity_kind:"turn"`、执行状态、待处理交互 ID、`task_outcome:null`、`turn_outcome:null|"ended"`；只有 companion 租约存活时才声明 `open_on_host`。稳定 run ID 为 `turn-<turn>-<startSeq>`，真实回合会替换 `session-observed`。Idle/注册表移除不代表目标成功。移除将执行标为 unknown，并去除失效交互。不声明回答、取消、重试、账单或额度能力。

提问观察器只调用一次现有 waterfall 的 `next()`，原样保留回答对象或异常。定时调用使用 `wait.callId` 并与持久化持续问题去重；阻塞请求因未暴露稳定 call ID 而使用进程内随机 ID。执行和等待保持正交。不导出问题文本、选项、回答、审批详情、提示词、回复、代码或工具输出。

## Usage 计量和限制

`event.usage` 是宿主归约后的完整记录：

```json
{"kind":"session_total","revision":123,"input_tokens":"12","output_tokens":"4","cache_read_tokens":"6","cache_write_tokens":"8","coverage":"loaded_session","accounting":"dsh-token-meter@0.2.2-rc.1"}
```

Input 表示非缓存输入，四个桶互不重叠，以十进制字符串表示。DSH 替换相同 turn/step 的前次结算，允许负向修正，并在 `llm/retry-started` 关闭替换槽，让重试的尝试累加。适配器读取宿主投影，不逐块累加。桥接按 source/session 更新单条记录，与 run 无关，`usage.revision = asOfSeq + 1`。不得累计所有快照，或同时累计父历史和继承子历史。Seeded/继承会话不导出 usage。超出安全整数或最终非负约束时仅抑制 usage，不牺牲精度。生命周期、usage 和问题投影分别读取，可选视图失败不会阻止导出所选存活执行观察。回合投影本身不可用时，适配器发送 `session-observed`、当前存活执行状态和未知结果，并记录失败计数，不推断回合。

这是**已加载会话的生命周期总量**，不是今日用量、完整历史或账单。不得将初始总量归入接收当天。每日归属、冷会话、实际金额、模型价格和订阅额度仍不可用。缺失表示未知，不能伪造为零。

队列最多保留 256 条 run 摘要，按 session/run 合并，IPC 失败五秒后重试；溢出时移除最早状态。心跳核对可修复桥接恢复后的当前存活状态，但不保证完整历史转换。事件回调只读取投影并入队。IPC 使用两秒截止时间、固定路径、无重定向、16 KB 请求/响应上限。诊断不记录异常正文或秘密。卸载释放全部观察器、定时器、客户端租约、Remote 注册、HTTP 请求和私有投影，不启动孤儿进程。

摘要 revision 使用毫秒墙钟乘以 1000，并在实例内递增；usage revision 使用宿主持久化游标。进程重启时发生时钟回拨，摘要替换可能等到时钟追平，不引入私有游标持久化。

## 验证与待检项

`npm test` 验证生命周期归约、会话选择与精确实例、宿主 usage 标准化/fork 排除、问题委托、重试合并、按序卸载、安全连接文件、单客户端意图分配、去重/结果重试、选择确认/失败、鉴权 IPC 和打包内容。`npm run build` 生成浏览器封装，测试会拒绝过期生成文件。

只读 runtime smoke 在独立进程中使用安装代码，不启动 profile 或安装插件：

```sh
DSH_TEST_RUNTIME='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh' \
ELECTRON_RUN_AS_NODE=1 \
'/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' test/runtime-smoke.mjs
```

将脚本改为 `test/entry-smoke.mjs`、`test/client-runtime-smoke.mjs` 可运行另两项检查。它们验证真实归约器（10 修正为 7、重试加 5，总量 12）、兼容性/补丁合成、真实注册表/问题服务下的宿主入口，以及真实宿主/客户端 Gateway 和生成的浏览器工厂。Client smoke 根据已检查的同步选择契约模拟 Workspace UI，真实 GUI 跳转仍需 lead 授权安装后验证。临时解析 hook 仅存在于一次性测试进程。

真实 profile 激活/重载、浏览器跳转、全天来源覆盖和设备展示仍是集成待检项。本包不修改固件，无需烧录。
