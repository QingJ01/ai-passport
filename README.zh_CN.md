[English](README.md) · **简体中文**

# AI Passport 的 Agent Pet

一个随身 AI 工作搭子方案：电脑端 Magpie 适配器与桥接服务收集数据，设备本地小宠物展示 Agent 活动、待处理交互、任务结果与可核实的用量。

当前 `feature/agent-pet` 分支正在实现：已有原创设备界面与通信、电脑桥接/中继、固定版本的 Magpie 适配器和原生手机伴侣。应用启动已替换上游测试菜单。构建与端到端真机验收仍在进行，实际证据和待完成项目见[实现检查点](docs/assets/implementation-status.zh_CN.md)。

## 设备操作

三个按键：**UP**、**DOWN**、**OK**（长按 OK 进入菜单或返回）。屏幕分四页，底部有固定导航条。

- **Now**：显示小鲸鱼、活跃任务数与需要你处理的事项。按 OK 直接跳到该看的任务；尚未收到数据时进入设置。
- **Tasks**：OK 切换已收到的任务；只有一个任务时，OK 直接打开宿主操作对话框。
- **Usage**：显示已加载会话的累计 token；按 OK 查看来源。不虚构费用或额度。
- **Inbox**：OK 切换简短更新。
- **菜单**（长按 OK）：手机配网、USB 连接、隐私、选择本地或中继服务、选择任务、查询请求状态、设备信息，以及设备设置（Wi‑Fi、解绑、重置，全部需要明确确认，默认停在取消）。

Wi‑Fi 凭证、服务绑定与配对只会在设备上物理确认后写入。设备通过 `device.info` 报告准确构建标识；哪些版本已刷入、哪些仍未验证，以实现检查点为准。

- [产品与技术方案](docs/assets/agent-pet-design.zh_CN.md)：页面、宠物行为、适配器证据、USB/手机配网绑定、局域网与远程传输、信任、同步、隐私、资源上限、里程碑和验收标准。
- P1a：一台电脑一台设备，局域网 WSS、USB 配置、本地动画、只读状态优先、可选费用估算。
- P1b：[手机配网与远程使用](docs/assets/mobile-remote.zh_CN.md)，包含无电脑首次配网、热点、账户/中继、跨网只读状态、隐私和撤销。
- 后续：受支持的远程操作、语音收件箱、更多工具与皮肤、持续 BLE 网关、端到端加密与签名 OTA，分别验证后加入。

硬件能力和 BSP 契约继续以[上游概览](docs/README.zh_CN.md)、[产品规格](docs/hardware-design/specifications.zh_CN.md)和[硬件指南](docs/hardware-design/AI_HARDWARE_DEVELOPMENT_GUIDE.zh_CN.md)为准。
