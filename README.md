**English** · [简体中文](README.zh_CN.md)

# Agent Pet for AI Passport

A proposal for a portable AI work companion: a local animated pet shows agent activity, pending interactions, task outcomes, and verifiable usage collected by a computer-side Magpie adapter and bridge.

This `feature/agent-pet` branch is under active implementation: original device UI and networking, computer bridge/relay, a version-pinned Magpie adapter, and a native phone companion are present. The application no longer starts the upstream test menu. Builds and end-to-end hardware acceptance are still in progress; see the [implementation checkpoint](docs/assets/implementation-status.md) for evidence and remaining work.

## Using the device

Three buttons: **UP**, **DOWN**, **OK** (hold OK for menu and back). The screen has four pages with a fixed bottom strip.

- **Now** shows the whale, how many tasks are active, and what needs you. OK jumps to the task you should look at; with nothing received it opens setup.
- **Tasks** cycles received tasks; with a single task OK opens the host-action dialog.
- **Usage** shows lifetime tokens for loaded sessions and, on OK, where the number came from. It never invents cost or quota.
- **Inbox** cycles short updates.
- **Menu** (hold OK): pair with a phone, connect over USB, privacy, choose local or relay service, choose a task, request status, device information, and device settings (Wi-Fi, unpair, reset, all behind an explicit confirmation that defaults to Cancel).

Wi-Fi credentials, service bindings, and pairing are only written after a physical confirmation on the device. The device reports its exact build through `device.info`; the implementation checkpoint records which builds were flashed and what is still unverified.

- [Product and technical design](docs/assets/agent-pet-design.md): pages, pet behavior, adapter evidence, USB/phone setup/pairing, LAN and remote transport, trust, synchronization, privacy, bounded resources, milestones, and acceptance criteria.
- P1a: one computer and one device, LAN WSS, USB provisioning, local animations, read-first status, optional estimated costs.
- P1b: [Phone provisioning and remote use](docs/assets/mobile-remote.md), including phone-only first setup, hotspot, account/relay, cross-network read-only state, privacy, and revocation.
- Later scope: supported remote interactions, voice inbox, other tools/skins, continuous BLE gateway, E2EE, and signed OTA after separate validation.

Hardware capabilities and BSP contracts remain documented in the [upstream overview](docs/README.md), [specifications](docs/hardware-design/specifications.md), and [hardware guide](docs/hardware-design/AI_HARDWARE_DEVELOPMENT_GUIDE.md).
