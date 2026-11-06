[English](README.md) · **简体中文**

# Agent Pet 手机伴侣

使用 React Native / Expo 54，包含实际生成的 iOS、Android 工程，以及封装乐鑫官方 BLE 配网 SDK 的 Swift/Kotlin 本地模块。需要原生开发构建。Expo Go、Safari 和 PWA 不能运行本应用的 iOS BLE 配网。

## 运行

需要 Node 22.13+（已用 Node 24 验证）和 npm。iOS 需要 Xcode、Ruby、CocoaPods；Android 需要 JDK 17、Android SDK 36 平台及构建工具、React Native 指定版本 NDK，以及 Android 8+ 真机。BLE、摄像头二维码验收需要手机真机与 AI Passport；模拟器只能检查界面。

```sh
cd apps/mobile
npm ci
npm test
npm run typecheck
npm run bundle
npm run prebuild
# 建议使用维护中的 Ruby 3；依赖只安装在项目内部。
BUNDLE_PATH=.bundle/vendor bundle install
BUNDLE_PATH=.bundle/vendor bundle exec pod install --project-directory=ios
BUNDLE_PATH=.bundle/vendor bundle exec npm run ios
# 配置 JAVA_HOME 和 ANDROID_HOME，指向本地工具后：
npm run android
npm start
```

真机 iPhone 需要在 Xcode 选择开发签名团队。应用标识为 `dev.agentpet.companion`。没有配置分发签名、应用商店发布、云构建或部署。Android 生成工程使用标准开发签名配置，不可直接发布。全新检出若缺少已忽略的标准开发 keystore，Android 运行脚本通过本地 JDK keytool 创建；不创建或配置分发密钥。控制器令牌和 Wi-Fi 口令不得写入源配置。

可选的 `scripts/ruby-sdk-compat.rb` 仅修复 macOS 系统 Ruby 2.6 寻找 `universal-darwin24` 头文件，而当前 Xcode SDK 提供 `universal-darwin25` 的问题。设置 `AGENTPET_RUBY_ARCH_HEADERS` 为实际 SDK 架构头文件目录，并设置 `RUBYOPT=-r<脚本绝对路径>`，再运行项目内 Bundler。它只修改当前进程的 `RbConfig`，不修改系统 Ruby 或 Xcode。现代 Ruby 无需此辅助脚本。

## 从零开始配对

默认流程是五步向导（简体中文）：选网络、扫电脑、扫设备、从设备自己搜到的列表里选网络并填密码、等设备上线。手机上还没有保存电脑时，应用启动后直接进入向导；保存过电脑的话，启动时自动重新连接。

1. **选网络。** “家里或办公室的 Wi-Fi”或“这部手机的热点”。选热点时先显示分平台的准备清单：iPhone 打开个人热点和“最大兼容性”（设备只支持 2.4 GHz），热点名就是 iPhone 的名字；安卓把频段设成 2.4 GHz。电脑先连上热点，这样空闲的 iPhone 热点也不会自动关掉；`tools/agent_pet_up.sh` 会在 15 秒内发现网络变化，并在新地址上重启桥接服务。清单还会提醒先记下密码，因为配对途中离开 App 会结束配对。

2. **扫电脑。** 在电脑终端运行 `tools/agent_pet_up.sh phone`，终端会显示二维码，内容是紧凑 JSON：

   ```json
   {"v":"agentpet-pair-v1","origin":"https://<computer>.local:7443","origin_ip":"https://192.168.x.y:7443","token":"<controller credential>","pin":"<64 lowercase hex>","name":"<computer display name>"}
   ```

   应用严格校验：版本字符串必须完全一致；源地址必须是 HTTPS，且不带路径、查询参数或账号密码；`origin_ip` 可省略，出现时必须是 IPv4 或带方括号的 IPv6 字面量；`token` 为 43 位 base64url；`pin` 为 64 位小写十六进制；名称不超过 64 个字符且不含控制字符；不允许多余字段。校验后先访问电脑上的桥接服务，成功后才把 origin、`origin_ip`、token、pin 和名称写入系统安全存储（iOS 为“仅解锁时、仅本机”的钥匙串，Android 为 Keystore 支持的 SecureStore）。
3. **扫设备。** 在设备菜单选“连接手机”，扫设备屏幕上的二维码，再在设备上按 OK。之后的 Security1 BLE 会话和以前一样，限时 120 秒。
4. **选网络、填密码。** 设备确认后，App 让设备扫描附近网络（`scanWifi`，即 SDK 的 `prov-scan` 端点），按信号从强到弱列出设备能搜到的网络，带信号格和是否需要密码。列表里只会出现 2.4 GHz 网络，所以它同时能检查热点或路由器设备够不够得着。Android 能读到手机当前 Wi-Fi 且设备也搜得到时自动选中。“列表里没有？”可以改成手动输入；不支持扫描的旧固件直接手动输入。密码错误和找不到网络会分别报告（`WIFI_AUTH`、`WIFI_NOT_FOUND`），并按热点或 Wi-Fi 给出改法；固件声明 `network-retry-v1` 时，设备配对窗口保持打开，改好后直接再点“连接”。一个按钮在同一个物理配对窗口内依次完成：选择任务来源、`network.prepare` 和 Wi-Fi 配网、`service.trust`、申请票据、设备证明、consume、`service.configure`、`finish`。“设备已经连着 Wi-Fi”只跳过 Wi-Fi 这一步。
5. **完成。** App 轮询 `GET /v1/devices`，直到设备的 `online` 为真（最多 75 秒）。超时后按设备屏幕上的提示（Wi-Fi 已连上但找不到电脑，或 Wi-Fi 正在重试）分别说明怎么处理，也提示可以先插 USB 线直接用。

桥接服务只报告一个任务来源时自动选中；已归属的设备沿用原来源；有多个来源时直接在向导里选择，不需要先去“设备”页。如果扫描到的服务报告 `remote` 传输，仍会先弹出默认取消的同意对话框，用户同意后才共享。

错误由 `src/friendly.ts` 和 `src/wifi.ts` 转成中文白话，例如“电脑不在同一个 Wi-Fi 上”“二维码已过期，请在设备上重新打开”“证书指纹不匹配”。内部错误信息保持英文，且从不包含令牌、PoP 或 Wi-Fi 密码。

老用户仍可在“账户”页的“高级 / Advanced”里手动填写 HTTPS 源地址和控制器令牌（证书指纹可选）；仅配对所有权、仅配置 Wi-Fi、远程中继这些操作放在“配对”页的“高级 / Advanced”里。

### 证书指纹（pin）

桥接服务使用自签名证书。用户不再需要安装并信任 CA 描述文件，电脑二维码直接带上 `pin`，即桥接服务 TLS 叶证书 DER 编码的 SHA-256。原生 HTTPS 模块新增可选参数 `pin`：

- **带 pin 时**，当且仅当服务器叶证书 DER 的 SHA-256 等于 pin 才接受连接。该请求不再参考系统信任和主机名，所以同一张证书既能用 `.local` 名称访问，也能用局域网 IP 访问。其他证书一律失败，错误码为 `PIN`。iOS 在 `URLSessionDelegate` 的服务器信任质询里检查（`SecTrustCopyCertificateChain`、`SecCertificateCopyData`、CryptoKit SHA-256）；Android 只在带 pin 时为该请求构建 OkHttp 客户端，装入自定义 `X509TrustManager` 和主机名校验器。
- **不带 pin 时**，行为不变：系统证书校验和主机名校验照常进行。

应用发往桥接服务的每个请求都带同一个 pin：devices、sources、health、service、state、enrollment tickets、consume、remote、privacy、revoke。原有限制保持不变：只允许 HTTPS，只允许 GET/POST/DELETE，令牌最多 8 KiB，请求体最多 16 KiB，响应最多 256 KiB，超时 12 秒，不跟随重定向，不使用 cookie、缓存或凭据存储（iOS 为临时会话）。

请求先访问 `origin`。GET 在网络层失败（包括 pin 不匹配）时，用同一个 pin 改试 `origin_ip`，之后沿用能连通的地址。POST 和 DELETE 不会换地址重放，因为响应丢失的请求（比如一次性的 enrollment consume）可能已经生效。每个流程都以 GET 开始，足以找到可用地址。Android 12 之前无法解析 `.local` 名称，这就是 `origin_ip` 存在的原因。iOS 首次访问时会请求“本地网络”权限（`NSLocalNetworkUsageDescription`）。

原生模块（`modules/agent-pet-provisioning`）的 JavaScript 接口：

```ts
request(url: string, method: "GET" | "POST" | "DELETE", token: string,
        body: string | null, pin: string | null): Promise<{ status: number; body: string }>
// 失败时错误码为 PIN（指纹不匹配）、NETWORK 或 REQUEST（参数无效）
currentWifiName(): Promise<string | null>   // 尽力而为；平台不提供时返回 null
connectSecure / exchange / provision / disconnect   // BLE 接口不变
```

封装层导出 `secureFetch(url, init, pin?)`，把上述错误码转换为 `TransportError`，类型为 `pin`、`network` 或 `request`；同时导出 `currentWifiName()`。`Relay` 构造函数的第四个参数为 `{ pin, fallbackOrigin }`。

## 已实现页面

应用跟随系统的浅色或深色外观，使用 iOS 系统配色、字号和分组列表，看起来像手机自带的应用，而不是一块主题化的仪表盘。

- **Today：** 当前选中的设备、任务状态和实体类型、已加载主机会话的累计用量、源时间戳和 45 秒新鲜度、分别显示中继/来源/设备健康。今日用量和缺失健康信息显示不可用。刷新只读取并验证完整快照，不展示伪造实时示例。
- **Devices：** 账户授权设备与来源列表、为新设备选择来源（只有一个来源时自动选中）、远程启停策略、公共模式请求、设备撤销。公共模式立即清除手机视图，等待服务的新隐私快照；不会声称已改变离线设备屏幕。
- **Setup（配对）：** 上文的五步向导，每一步下面都有可展开的排查提示。“高级选项”里保留仅所有权、本地桥接、远程设置和显式结束。向导本身包含摄像头扫描、原生蓝牙权限、安全会话、实体身份和物理确认、候选网络准备、达到固件报告容量时显式选择替换（最多三个 SSID）、超时/退出/后台清理。只有真正切到后台才结束配对：iOS 弹出蓝牙、相机、本地网络权限框时会报告 inactive，第一次配对正好会遇到，不能因此取消。固件不具备对应能力时明确拒绝。
- **Account（账户）：** 扫电脑二维码或使用上次保存的电脑；“高级 / Advanced”里可填写管理员签发的账户范围控制器令牌及可选证书指纹、系统安全存储、验证后恢复会话、退出并清除缓存、服务和数据披露。当前中继没有浏览器 OAuth、账户恢复、生产身份提供者；界面明确说明。

远程功能为 P1 只读。没有审批、回答、部署、支付、发布快捷操作，没有原生推送，不读取系统 Wi-Fi 口令，不自动开启热点，也不持续充当后台 BLE 网关。

## BLE 兼容性与安全状态

选用 [乐鑫 ESPProvision iOS 3.0.3](https://github.com/espressif/esp-idf-provisioning-ios/releases/tag/3.0.3) 和 [Android lib-2.4.4](https://github.com/espressif/esp-idf-provisioning-android/tree/lib-2.4.4)，均为 Apache-2.0。已检查上游 README 和实际 API，包括安全会话、加密自定义端点、连接事件及配网回调。Android 明确列出 ESP32-C3；iOS 文档写 ESP32 系列，仍需 iOS/C3/ESP-IDF 5.5.3 真机互通验证。SDK 能力不能等同产品已通过配网验收。

使用 ESP-IDF Security1（SDK 自带 X25519、PoP、AES-CTR），二维码中为临时高熵 PoP；JavaScript 不实现密钥交换。拒绝 Security0、缺少 `sec_ver:1` 以及 `no_pop`。广播名只用于找到候选设备，安全端点必须返回扫描到的同一设备 ID、会话 nonce、公钥。固件必须先由用户按 OK 才开放配网端点。会话 120 秒，普通调用 15 秒，连接 Wi-Fi 最多 45 秒且不能超过剩余配网窗口；退出与后台清理连接和扫描代次。二维码 URL 不能安装服务信任。

iOS 显式关闭 SDK 日志。Android 上游会在 DEBUG 输出 PoP。配置插件启用 R8 日志移除，但 AGP 对可调试变体即使开启 minify 也不做优化。因此原生桥接在**任何可调试 Android 应用中、调用 SDK 之前就拒绝 BLE 连接**。`npm run android` 明确构建优化 release，其 R8 规则移除 `android.util.Log`。Debug 可用于界面/远程查看开发，不能执行 BLE 配网。真实口令测试不得关闭 release 的优化和日志移除；发布前还要验证优化 APK 和真机日志，不收集原始配网日志。此处 release 仍使用开发签名，不是应用商店发布配置。

## 固件接口

在 SDK 已认证加密的自定义数据 API 上，已与固件负责人协调 `agentpet-setup`。端点缺失就是失败，不会模拟连接。设备屏幕二维码 JSON 字段：`ver:'agentpet-v1'`、`name:'PROV_*'`、`transport:'ble'`、`security:1`、临时 base64url `pop`、稳定 `device_id`、64 位小写十六进制 `nonce`、SPKI PEM `public_key_pem`、`service_uuid`。

固件实际配网服务 UUID 必须与二维码和广播一致；二维码写入 UUID 不会配置 ESP-IDF 服务。Android 将扫描到的 UUID 传给 connectBLEDevice，SDK 按名称扫描、不限定厂商默认 UUID。iOS 扫描所有服务并发现广播的服务。两端均不假设 SDK 默认 UUID，仍需真实 BLE 验收。

所有消息含 `v:1` 和 `op`：

| 操作 | 请求 | 成功响应 |
| --- | --- | --- |
| `challenge` | 扫描到的 nonce | 一致的 ID/nonce/公钥、`physical_confirmed:true`、`network_slots`、`max_network_slots`（1–3）、`capabilities` |
| `network.prepare` | SSID、显式 `replace_slot` 或 null | `ready:true`；固件应验证候选路径后才替换已保存网络 |
| `service.trust` | 明确的 `transport:'local'|'remote'`，所选 HTTPS 服务提供的 `public_key_pem` | `trusted:true`；不能静默覆盖已有不同根 |
| `enroll` | 同一明确 transport，以及包括 canonical 和服务签名的完整票据 | `service_signature_verified:true`、一致的 ID/nonce、设备签名 `proof` |
| `service.configure` | 同一明确 transport、WSS 端点、CA PEM、服务器名、UTC 时间、设备凭据、签名时间引导 URL/签发者/受信注册公钥 | `accepted:true,state:'validating_path'`，不等于已连上服务 |
| `finish` | 无敏感字段 | `finished:true`，先释放 BLE 再进行业务 TLS |
| `result` | 后台工作 `request_id` | `pending:true,request_id` 或 `pending:false,result` |

经认证的服务元数据选择 local/remote；信任、票据验证、配置始终携带同一明确 transport。远程设置要求 transport-profiles-v1，旧固件在修改信任根之前拒绝。**仅配对所有权**绑定设备，不授权上传、不配置传输。**连接本地桥接**不要求云端同意，也不修改远程策略。**添加远程查看**先显示默认取消的明确同意框，消耗已验证持钥证明后启用服务端策略，再配置设备远程传输。固件两个配置使用独立根和注册状态；真机共存仍需验收。

慢操作每 250ms 轮询，仍受总计 120 秒限制。只有 `network.prepare` 同意后才调用标准 SDK 配网。Wi-Fi 成功不能证明互联网、服务认证、持久槽位提交或来源在线；尝试结束清除手机口令，同时保留同一物理配网窗口。首次设置随后在该窗口完成账户注册和中继配置，再由 finish 释放 BLE 并验证 TLS；已有设备只换网时使用明确的完成设置按钮。向导在扫设备之前先连接电脑，并在同一页面自动选择或询问任务来源，因此不会在有效窗口中切换页面导致配网取消。支持独立配置的固件报告最多三个已保存 SSID；仍兼容旧固件的一槽响应。达到报告容量时要求显式替换，未报告容量则拒绝写入，并验证容量为一至三。槽位提交、回滚和候选路径验证仍需硬件验收。

## 中继接口

接口先与服务队友协调后实现。手机不猜测 OAuth，不将控制器令牌发送到设备二维码中的地址。控制器令牌和目标地址只来自电脑二维码（带 pin，见上文）或手动输入。不带 pin 时，按本节下文使用系统证书验证，下文的 CA 安装步骤只适用于不带 pin 的手动输入；原生传输拒绝 HTTP 和所有重定向：iOS 为每次请求使用临时 URLSession，并由重定向代理显式拒绝；Android 使用 OkHttp 关闭 HTTP/HTTPS 重定向和连接自动重试。两端限制响应大小、请求时间，保持系统证书校验。应用注入该传输，不依赖 React Native 基于 XHR 的 fetch 是否执行 redirect 参数。自建 CA 需通过系统信任管理显式安装，不可关闭 TLS 校验。iOS 开发时仅传输 CA 证书，在 设置 → 通用 → VPN 与设备管理 安装描述文件，再在 关于本机 → 证书信任设置 显式信任该根。Android 的 debug 与优化 release 均信任系统根及用户主动安装的根，因此纯本地桥接可使用自有 CA，无需依赖公共云证书。在安全设置中仅安装明确选择的 CA；这会扩展手机信任范围，应由用户主动决定。证书链和主机名校验始终启用。Release 网络策略禁止明文；debug 资源允许 Metro HTTP，但原生服务客户端在所有变体都拒绝 HTTP。手机 DNS 名必须可达并与证书 SAN 一致；默认开发证书为 agentpet.local、localhost、127.0.0.1，直接输入主机 LAN IP 或手机自己的 localhost 都不能正常访问主机服务。必须明确配置真实可达域名和证书，没有证书错误绕过。

- `GET /v1/devices`、`/v1/sources`、`/v1/health`、`/v1/devices/:id/state`，均通过 Authorization Bearer 认证。`/v1/devices` 里每台设备带 `online`，设备持有已认证的设备连接（Wi-Fi 或 USB 转发）时为真；旧版桥接没有这个字段，App 显示为未知。
- `GET /v1/service` 提供 transport:local/remote、endpoint、ca_pem、server_name、time、enrollment_public_key_pem、key_id。旧服务角色由已认证 health 判定，不来自二维码地址。端点为空时不能配置连接，仍可仅配对所有权。
- `POST /v1/enrollment/tickets` 传设备 ID/公钥/nonce/来源 ID，返回一次性签名票据。服务签名的 UTF-8 canonical 为固定字段顺序 `{domain,ticket,account_id,device_id,source_id,nonce,public_key_pem,expires_at}`，expires_at 单位毫秒；手机不重新序列化已签名字节串。
- 设备校验已受信/物理注册的服务 P-256 SHA-256 DER/base64url 签名和 nonce，再以设备私钥对原始 ticket 字符串签名。`POST /v1/enrollment/consume {ticket,proof}` 原子校验时效、账户、一次性使用和持钥证明，返回 `{device_id,credential}`。手机仅在同一已认证设备设置操作中转发凭据；仅配对所有权时丢弃所发凭据，不持久保存设备凭据。之后配置已有设备须明确传 operation:rotate_credential，以新的物理 nonce、相同账户/来源/P-256 公钥及新证明换发；消耗票据撤销旧设备凭据，不会静默启用远程共享。
- `DELETE /v1/devices/:id` 撤销；`POST /v1/devices/:id/privacy {mode:'public',view_epoch}` 请求公共模式。退出清除手机会话，服务端撤销丢失手机令牌是单独操作。

快照必须是完整 `snapshot.begin/page/end`，原子验证快照身份、stream、隐私 epoch、revision、页顺序/数量和任务上限；拒绝增量、混合视图和缺页。测试导入服务实际 Publication，防止接口漂移。源时间戳决定新鲜度，中继时间不能冒充源更新。切换账户、退出时丢弃视图，并阻止旧请求回写。

此处没有部署中继。两段 TLS **不等于端到端加密**。使用前仍需明确运营者、地区、保留时间、费用和恢复策略。不打开家庭路由器端口。

可用 `python3 scripts/verify-android-release.py android/app/build/outputs/apk/release/app-release.apk "$ANDROID_HOME"` 检查优化 Android APK。它验证清单和 SDK 字节码属性，不等于手机或 BLE 验收。

## 验证与剩余门槛

客户端测试覆盖电脑配对二维码解析与严格拒绝、pin 的安全存储、单一来源自动选择、每个桥接请求都带上 pin、仅 GET 回退到 `origin_ip`、pin 不匹配的报告、中文白话错误提示、安全二维码拒绝、身份不符、超时、网络替换选择、服务签名拒绝、异步固件响应、HTTPS 源、令牌授权、撤销、原子快照、服务真实投影和源离线。`npm run bundle` 生成两个平台的 Hermes 生产 JS；它与原生 `.app`/APK 编译分别记录。

两次扫码配对与证书 pin 改动的验证：TypeScript PASS；36 个客户端/服务契约测试 PASS（新增 10 个）；iOS 与 Android Hermes 生产 JS PASS；iOS 模拟器 Debug 构建（Xcode 26.3）PASS，已编译带 pin 的 Swift 请求代码；使用本地工具链离线执行 Android `:agent-pet-provisioning:compileReleaseKotlin` PASS。本次改动未运行：完整 Android APK 构建、启动应用，以及任何真机摄像头、BLE、本地网络或针对运行中桥接服务的 pin TLS 测试。

此前记录的本地验证：TypeScript PASS；26 个客户端/服务契约测试 PASS；iOS 与 Android Hermes 生产 JS PASS；Xcode 26.3 + ESPProvision 3.0.3 原生 iOS 模拟器 Debug 与独立 Release `.app` 构建 PASS。已在 iPhone 17 模拟器实际启动并确认界面，见[实际截图](screenshots/ios-now.png)。原生 Android ARM64 优化 release APK 构建 PASS；release 验证确认应用不可调试、备份关闭、网络策略存在，以及乐鑫 SDK 类中无 Log.d/v/i/w/e 调用。其他库可能保留无关日志。手机真机/C3 BLE 验收仍为 NOT RUN。验证没有使用实际账户数据或 Wi-Fi 口令。

宣称手机独立配网完成前，还需两个平台原生编译安装及真机检查：拒绝权限、错误/过期二维码、伪造广播名/身份、物理拒绝、前后台超时、错误网络保留旧配置、三槽替换、手机自身热点、服务根拒绝、伪造/重放/跨账户票据、中继 TLS、USB 恢复及反复进退。测量 C3 BLE/Wi-Fi/TLS 内存和清理，来源睡眠 45 秒内变陈旧，混合 LAN/热点使用及实际流量功耗。界面、原生编译、BLE、固件构建和真机结果应分别汇报。
