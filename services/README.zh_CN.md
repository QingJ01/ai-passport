[English](README.md) · **简体中文**

# Agent Pet 电脑端服务

本目录提供可运行的 Node.js 桥接、主动启用的受信任中继、限定权限的注册 API、签名时间服务、协议测试和 [Magpie 插件](magpie-plugin/README.zh_CN.md)。不会自动部署服务或向运行中的宿主安装插件。需要 Node 22+ 和 OpenSSL；服务唯一运行时依赖为精确固定的 `ws` 8.22.1。密码学使用 Node 标准 TLS、P-256 和 SHA-256。

## 本地安装

在本目录运行：

```sh
/usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npm-cli.js ci --ignore-scripts
/usr/local/bin/node src/setup.mjs .agent-pet
/usr/local/bin/node src/cli.mjs .agent-pet/config.json
/usr/local/bin/node --test test/*.test.mjs
```

初始化创建受限目录和文件、适用于 `agentpet.local`、`localhost`、`127.0.0.1` 的开发证书、独立签名密钥，以及 `local` 账户、`magpie` 来源、`passport-1` 设备。凭据只写入权限受限文件，不打印；已有配置不会被覆盖。开发根证书仅适用于明确配对的本地信任；公开中继需要真实域名证书和运营方管理的注册签名身份。

默认 TLS 监听 `127.0.0.1:7443`，适配器 IPC 监听 `127.0.0.1:7445`。设备和手机使用时运行 `node src/setup.mjs .agent-pet --lan-ip 192.168.1.20`，替换成明确选择的电脑局域网地址。初始化验证私有 IPv4，将 IP 加入证书 SAN，仅监听该地址，并用该 IP 写入 `public_endpoint` 和 `time_bootstrap_url`。手机可以验证 IP SAN，固件也可使用固定 `server_name:'agentpet.local'`。不提供参数时元数据使用回环地址，只适合本地测试。尚未实现 mDNS 广播。CLI 拒绝通配地址监听。不会修改防火墙、路由器、DNS 或全局插件配置。

设备凭据和根证书只能经设备物理确认的 USB 或加密并物理确认的手机配网传输。USB 格式见 [protocol.json](protocol.json)，可选 `device_id` 必须与凭据绑定一致。不要在命令参数或日志里粘贴秘密。初始凭据有效期 30 天；当前轮换需要重新注册或运营操作。生产 OAuth、账户恢复、自动刷新、服务器存储加密、备份策略及监控仍是部署前工作。

[离线管理工具](src/admin.mjs) 可以发放控制器、来源和设备凭据或撤销设备。操作前停止服务，运行中的服务不会加载任意外部文件修改。例如 `node src/admin.mjs .agent-pet/config.json issue-controller local operator .agent-pet/controller.json` 写入新受限凭据文件。设备绑定当前选择来源 `magpie`。在线撤销通过 API 立即关闭订阅。不要提交运行时目录。

## 通信和手机 API

[protocol.json](protocol.json) 是规范协议。每条完整 UTF-8 JSON 消息不超过 4096 字节，禁用 WebSocket 压缩。设备发送 `hello`，包含 `device_id`、`versions:[1]`、`view_epoch` 和可选 `public_mode`，随后在五秒内发送包含 `credential` 的 `auth`。认证绑定账户、设备和所选来源。业务消息统一为 `v,type,stream_id,view_epoch,revision,payload`。

快照使用 begin/page/end，页码从零开始，每页最多四个任务，总计最多 16 个任务、八个收件项。当前实现每页一个任务，另有元数据页，因此最多 17 页。计数与来源信息原子更新。`state.delta` 替换完整任务摘要或用量；成员、总数或收件项变化会创建新流和快照。修订号只在该设备视图实际发布 delta 时递增；uint32 溢出前创建新流。HTTPS 回退 `GET /v1/state?frame=0` 冻结十秒快照，后续索引读取同一基线。没有索引的接口返回 `{frames:[...]}`，供手机和电脑使用，整体可能超过 4096 字节。

手机 HTTPS API 使用 `Authorization: Bearer <控制器凭据>`。服务拒绝浏览器 Origin，原生客户端使用选定且已认证的 HTTPS 来源。来源和设备令牌不能管理其他账户的设备。

| 请求 | 结果 |
| --- | --- |
| `GET /v1/service` | `endpoint,ca_pem,server_name,time,enrollment_public_key_pem,public_key_pem,key_id,time_bootstrap_url,time_issuer,transport`（`local` 或 `remote`） |
| `GET /v1/devices` | `{devices:[{id,source_id,remote_enabled,view_epoch,mode}]}` |
| `GET /v1/sources` | `{sources:[{id,connected,fresh,source_updated_at}]}` |
| `GET /v1/health` | 服务模式、`source_scope`、`source_id`、聚合 `source` 和授权范围内 `sources` |
| `GET /v1/devices/:id/state` | `{frames:[...]}`；中继另含 `source_fresh,relay_received_at` |
| `GET /v1/diagnostics` | 仅控制器可读的账户内适配器事件、心跳计数及固定拒绝类别 |
| `POST /v1/enrollment/tickets` | 签名票据；请求包含 `device_id,source_id,public_key_pem,nonce`，可选 `operation:'enroll'|'rotate_credential'` |
| `POST /v1/enrollment/consume` | `{device_id,credential}`；请求包含 `ticket,proof` |
| `POST /v1/devices/:id/privacy` | 请求包含 `mode,view_epoch`；清除缓存并关闭旧订阅 |
| `POST /v1/devices/:id/remote` | 请求 `{enabled:boolean}`；明确授权远程模式 |
| `DELETE /v1/devices/:id` | 立即撤销凭据、订阅并删除缓存 |

控制器健康接口列出当前账户去重后的有效来源。仅一个来源时 `source_scope` 为 `single_source`；多个或没有来源时为 `any_authorized_source`，聚合 connected/fresh 表示任一授权来源具有该状态。设备健康范围仅限其绑定来源。中继健康来自授权缓存快照的原始来源新鲜度，不会创建虚构本地适配器，也不会用中继心跳刷新来源。

票据 120 秒到期，经 P-256 私钥持有证明后只能消费一次。返回的 `canonical` 是按以下精确属性顺序编码的 UTF-8 JSON 字符串：`domain,ticket,account_id,device_id,source_id,nonce,public_key_pem,expires_at`。域为 `agentpet-enroll-v1`，nonce 为 64 位小写十六进制，过期时间为 UTC 毫秒。用预信任注册公钥校验 `signature`，其为对该完整字符串的 ECDSA/SHA-256 DER 签名，base64url 编码。设备 `proof` 为对票据字符串 UTF-8 字节的同类签名。服务只接受 P-256 公钥，以及已授权给控制器账户的来源。未消费票据仅在内存中，重启即失效。

账户注册保持 `remote_enabled:false`。仅建立所有权的配对可以丢弃新发设备凭据并保留局域网配置。启用远程传输必须获得明确同意，再调用独立远程启用 API。后续经物理确认的会话可以用相同账户、来源、P-256 密钥及新挑战 nonce 请求 `operation:'rotate_credential'`。消费时验证新票据持有证明，撤销原设备凭据并立即关闭旧订阅，只在经认证的 TLS 响应流程中返回替代凭据，保留原远程启用设置。更换密钥、已撤销设备或没有已注册密钥绑定的旧设备均会被拒绝。服务保留最近 32 个已消费设备 nonce 的哈希以拒绝重复，票据重放另行拒绝。签名规范票据结构不变。

诊断仅保存在内存，进程重启时清零。按已认证来源分别统计事件与心跳的 received/accepted/rejected，并使用固定验证类别，不含任务 ID、正文、令牌或凭据，只允许控制器读取自身账户统计。有效心跳但事件接收数为零，与事件规范化被拒绝属于不同故障。

## Magpie 适配器边界

[插件包](magpie-plugin/package.json) 单独进行版本门控。回环 IPC 使用独立适配器 bearer 令牌，拒绝 Origin，并另行校验来源凭据。`POST /v1/events` 接受 `{source_credential,event}`。事件字段为 `source_id,session_id,run_id,revision,title,entity_kind,execution_state,pending_interactions,task_outcome,turn_outcome,capabilities`；未知原始正文不会被存储或转发。请求 ID 和纯文本长度受限。任务 ID 通过 SHA-256 稳定生成，不超过固件 96 字节限制；原始会话和运行身份只保留在受限本地状态中供路由使用。

可选 `event.usage` 格式为 `{kind:'session_total',revision,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,coverage:'loaded_session',accounting:'dsh-token-meter@0.2.2-rc.1'}`。令牌均为非负十进制字符串。桥接按来源和会话更新完整宿主归约记录，与轮次无关；较新但较小的总数属于修正。范围为 `loaded_sessions_lifetime`，`daily_tokens` 为 null。这不等于今日消费或订阅剩余额度。总数超过 23 位时，固件协议报告不可用。此适配器没有金额来源；归约器可接受明确来源、携带实际或估计溯源的微单位记录，不猜测价格或汇率。

`POST /v1/source/heartbeat` 每 15 秒及卸载时发送 `{source_credential,connected}`。`GET /v1/commands` 使用适配器 bearer 和 `X-Source-Credential`，返回 `{commands:[{command_id,type:'open_on_host',session_id}]}`。`POST /v1/commands/result` 接受 `{source_credential,command_id,status}`。除非插件确认在线导航能力，否则设备不能打开宿主任务。动作使用有效期 30 秒的授权、持久化调用前意图及动作 ID。收到请求不等于完成导航。相同 ID 和参数返回记录，不同参数冲突；重启将未决 accepted 状态变成 unknown，不重复调用。没有跨系统恰好一次保证。不支持回答、取消和重试。

运行与等待独立。轮次结束只产生 `turn_outcome:'ended'`，不表示目标完成。来源 45 秒后过期，连接心跳不会完成任务。真实轮次出现后替代初始 observed 行。公开模式不发送任务、收件项或用量，并清除云缓存、创建新视图流。

## 日常启动与 USB 连接

最简上手（已安装 Magpie 的 Mac）：运行 `tools/agent_pet_up.sh`，插上设备，屏幕询问时按 OK。全部设置就这些。

`tools/agent_pet_up.sh` 是唯一入口。它会检查 Node.js 20+、pyserial 和（仅首次）OpenSSL，缺什么就给出确切的解决办法；首次安装一次服务依赖；首次运行时创建 `.agent-pet/`（仅监听本机，USB 已够用）；每当桥接服务尚未运行时，用 `services/src/renew.mjs` 为 10 天内到期的凭据续期，并据此写入 Magpie 连接文件 `~/.config/agent-pet/magpie.json`（0600），不需要手动复制任何东西。随后在后台启动本地桥接服务、Magpie 数据源和常驻 USB 连接。`status` 显示运行情况和最近一条连接消息，`stop` 只停止本仓库目录下的服务（按绝对路径匹配进程），`autostart on|off` 添加或移除登录时自动启动的 macOS LaunchAgent。桥接服务没能启动时，脚本会说明原因（例如端口被占用），而不是报告成功。

`wifi` 让设备不插线也能用。它会一次性把桥接服务切换到局域网模式（`services/src/lan.mjs`）：设备和手机通过这台电脑的 Bonjour 名称（`<LocalHostName>.local`）找到它，设备校验证书名称、手机固定证书指纹，因此都不依赖 IP；桥接服务绑定当前的私有局域网 IPv4，每次启动都会重新检测（地址变化会重启桥接服务），没有局域网时退回本机地址。Magpie 通道仍在 127.0.0.1；USB 转发直接连接绑定地址，因为这台电脑可能把自己的名称解析成本机回环地址。随后命令会读取当前 Wi-Fi 名称（读不到就让你输入），在终端里询问密码且不保存，请设备一键确认后发送设置；设备会显示 Wi-Fi 名称，需要再按一次 OK 才会应用，测试连接失败时保留原设置。设备通过 Wi-Fi 在线后，常驻 USB 连接会保持安静，只有设备离线超过一分钟才会再次请求连接。

`phone` 在终端显示给手机 App 扫描的二维码：`{"v":"agentpet-pair-v1","origin":"https://<名称>.local:7443","origin_ip":"https://<局域网 IP>:7443","token":"<控制端凭据>","pin":"<桥接证书 DER 的 SHA-256>","name":"<电脑名称>"}`。凭据只出现在二维码里。请把这个二维码当作钥匙。控制端凭据有效期 30 天，过期后手机需要重新配对。常驻连接（`tools/agent_pet_device.py link`）会自动找到第一台 Espressif USB 设备并发送 `link.request`，设备随即显示“电脑请求连接”：按一下 OK 允许，长按拒绝并在一分钟内不再提示。电脑永远不能自行打开窗口。允许之后，电脑每推送一帧都会把窗口再延长 30 秒，所以只要不拔线、服务不停就一直保持连接；断开后会等待设备重新出现。来自电脑的配置（Wi-Fi、服务）仍需在设备上单独确认。概览页在未连接时按 OK 会直接打开 USB 窗口。

## Magpie 数据源

`services/src/magpie-source.mjs` 直接从 [Magpie](https://usemagpie.ai) 读取数据供给桥接服务，不再依赖代理内插件。它每 10 秒以只读方式调用一次 Magpie CLI：

- `magpie sessions --limit 16 --json`：Magpie 可读取的所有代理（DeepSeek Harness、Codex、Claude Code、Claude Desktop 等）最近 16 个会话，含标题、输入/输出 token 和 Magpie 算出的费用。
- `magpie usage --csv today`：今天的每条请求。按会话用输出 token 除以（总耗时 − 首 token 时间）得到生成速度；同一批数据也给出今日合计和按模型的列表（按 token 取前 8 个，各含 token、费用和速度），设备的用量页每页显示 4 行。token 数为输入加输出，与 Magpie 首页口径一致；设备上缩写为 K、M、B。
- `magpie settings get currency`：费用默认是美元；如果 Magpie 设成人民币，则用 Magpie 自己的 `~/.cache/magpie/fxrate.json` 换算。

会话在最近 90 秒内有请求或活动时显示为进行中。费用由 Magpie 按价目表算出，因此标为估算。只有标题、代理名和数字会发给桥接服务；提示词、回复、路径和恢复命令都不会离开这个进程。它复用 `~/.config/agent-pet/magpie.json` 里的数据源凭据，通过回环 IPC 上报（每个会话一次 `/v1/events`，今日合计随 `/v1/source/heartbeat` 发送）。

```bash
node services/src/magpie-source.mjs        # 可选参数：轮询间隔秒数（最少 5）
```

只有设备上显示的内容变化时才重新发送该对话，每 30 次轮询做一次全量刷新。`MAGPIE_BIN` 可覆盖 Magpie 可执行文件路径，`AGENT_PET_MAGPIE_CONNECTION` 可覆盖连接文件。若代理内插件也上报了同一个对话，桥接服务优先显示带用量数据的那条记录。

## 主动启用的中继

第二个服务使用 `mode:'relay'`、真实证书、明确监听地址，以及独立发放账户、来源、设备凭据的受限存储。远程凭据与局域网凭据独立，必须有意配对两端。中继 WSS 路径 `/v1/relay`，来源认证首帧为 `{v:1,type:'auth',payload:{credential,device_id}}`；设备在 payload 中另加 `view_epoch` 和布尔 `public_mode`。中继返回规范认证 `welcome`，包含所选远程 epoch、模式、原始来源健康和限制。来源只发布完整且通过验证的最小快照，设备可读取状态和配置自身隐私视图，不支持远程动作。中继不代理宿主 API、文件、命令或终端。初始中继周期发布完整快照，不转发 delta。

桥接配置 `remote:{enabled:true,disclosure_acknowledged:true,url:'wss://your-domain/v1/relay',credentials_file:'relay-credentials.json'}` 前，必须确认运营方、区域、字段、保留期和费用。发布端只发起出站连接，验证真实 TLS，以有界指数抖动重连，不上传私有标题和问题正文，不上传金额，仅发送别名、ID、状态、关注计数和请求 ID、可核实令牌总数及来源状态。CLI 要求独立的 `remote.credentials_file` 文件，包含单独发放的 `source_credential` 和 `device_id`，不会默认使用局域网凭据。发布端等待中继认证策略后才发送投影。生产环境不要复用局域网凭据。中继设备必须启用 `remote_enabled`。`remote_view_epoch` 和 `remote_mode` 独立于局域网字段存储。设备新启动 epoch 或 `view.configure {mode,view_epoch}` 会清除旧缓存，并通知权限范围内来源发布端以新流重新过滤快照。`view.ready` 只确认隐私配置，不表示快照已同步。旧 epoch 的迟到来源帧会被丢弃。来源离线时 welcome 和心跳显示数据不可用，不会将旧快照改标签复用于新 epoch。

中继是可读取允许字段的受信任处理方，两段 TLS 不等于端到端加密。仅在内存中缓存每设备最后完整快照，24 小时到期，重启等待来源重新同步。即使中继心跳在线，来源 45 秒后也会显式过期。撤销、隐私变化、禁用会清除相关缓存和旧订阅，不上传七天任务历史。不支持远程动作。测试不会启动公开服务。

[time.mjs](src/time.mjs) 提供独立 HTTP `/v1/time?nonce=<64 hex>`。初始化 CLI 默认在同一明确地址的 7444 端口监听，`time_issuer` 默认为 `agentpet-local`，`time_bootstrap_url` 必须设置为设备可达地址。响应包含 `issuer,nonce,unix_seconds` 字符串和 base64url DER `signature`，并保留设计文档兼容字段 `domain,bridge_id,seconds`。签名原文为 `agentpet-time-v1`、issuer、nonce、秒数字符串以换行连接，末尾无换行。用物理确认时固定的 P-256/SHA-256 公钥校验，要求五秒单调时钟内完成，然后完整验证 TLS。时间端点没有凭据或任务数据。真机冷启动、密钥轮换和网络恢复仍需验证。

## 验证和限制

运行 `node --test test/*.test.mjs` 与 `npm audit`。测试覆盖实际 TLS/WSS 桥接和中继、证书拒绝、IPC 隔离、来源过期与 TTL、快照边界、修正、账户隔离、P-256 持有证明、撤销和动作结果未知。服务测试不等于硬件、手机 BLE 或安装桌面插件的验收。仓库静态和固件完整检查由负责人运行。

本地受限文件只持久化规范摘要、会话路由身份、归约用量和动作哈希/结果。容量上限为 4096 摘要、10000 用量记录、1024 凭据、128 票据/授权、四个执行中动作和 4096 保留动作。结束摘要按天清理和按日期汇总仍未完成；当前本地状态容量有界，由运营方明确清除。本版使用受限文件而非加密存储。账户生命周期、存储、入口配额、证书轮换、可信时间、来源覆盖及运营策略完成审查前，不应公开部署。
