# ClawBoot

An open-source Raspberry Pi OS desktop application that installs and configures OpenClaw with a fully local Qwen 3.5 model. Choose the faster 2B model or the smarter 4B model, then let the wizard set up the local assistant without a terminal.

## Download

[**Download ClawBoot for Raspberry Pi 5**](https://github.com/imranduratbegovic/ClawBoot/releases/latest/download/clawboot_arm64.deb)

Open the downloaded package with **Package Install**, then click **Install**. No terminal is required.

The interface follows the same basic pattern as Raspberry Pi Imager: one dedicated app window, a clear step list, one task per screen, and normal Back / Next / Install controls.

## What the app does

1. Checks for a Raspberry Pi 5, 64-bit OS, enough RAM, storage, and internet access.
2. Installs the verified ARM64 Ollama runtime.
3. Downloads either `qwen3.5:2b` (2.7 GB, recommended for speed) or `qwen3.5:4b` (3.4 GB, smarter but slower).
4. Installs the tested OpenClaw 2026.6.11 stable release (or keeps a newer installed version) and configures its native Ollama provider to keep inference on the Pi.
5. Enables key-free DuckDuckGo web search and direct web-page reading.
6. Installs and configures a managed, headless Chromium profile for interactive websites. It does not import the desktop user's normal browser profile.
7. Applies the Full Pi assistant policy and keeps Ollama, OpenClaw, and ClawBoot network services on loopback.
8. Starts the services and runs model, gateway, doctor, and security checks.
9. Connects Telegram through a BotFather token, with identity verification and owner pairing.
10. Installs the official WhatsApp plugin, displays the real live QR image returned by the local OpenClaw gateway, replaces it when the gateway rotates it during linking, and lets the owner approve trusted numbers.

Installation is resumable. Closing the window does not stop an active download or installation, and reopening the app reconnects to the current job.

The first setup downloads approximately 4.2 GB with Qwen 3.5 2B or 4.9 GB with Qwen 3.5 4B. That includes about 1.5 GB for the official Ollama ARM64 runtime. Runtime downloads use HTTP/1.1 byte ranges and a persistent cache under `/var/cache/clawboot/downloads`; a dropped connection, cancellation, or Retry continues from the saved byte instead of restarting the archive.

## Full Pi access

ClawBoot v1.2 is deliberately focused on one job: turning the Raspberry Pi into a whole-computer assistant. The wizard therefore offers one explicit permission mode:

- **Full Pi assistant** gives OpenClaw host-wide file access, unrestricted patching, no-prompt command execution, managed Chromium control, and passwordless `sudo` as root. This is the profile for an assistant that can administer the whole Pi.

Web search uses the key-free DuckDuckGo provider, so it does not require a search API subscription. Model inference remains local, but search, page fetching, Chromium browsing, messaging, and software downloads still contact the internet.

> **Full Pi assistant is deliberately root-equivalent.** Installing the ClawBoot package is the system-authorized permission grant: its package setup installs a validated sudo rule that allows the `openclaw` service account to run any command as any user without a password. The wizard repeats the warning and requires acknowledgement before it configures the agent. A paired Telegram or WhatsApp sender can therefore trigger root-level actions, and malicious instructions hidden in a website or message can become a root-level prompt-injection path. Pair only your own accounts and keep group access disabled. Uninstalling ClawBoot removes its passwordless-sudo rule.

## Requirements

- Raspberry Pi 5
- 64-bit Raspberry Pi OS Bookworm or newer
- 8 GB RAM or more
- At least 12 GB of free storage; an SSD or NVMe drive is recommended
- Internet access during installation

## Install on the Raspberry Pi desktop

No terminal is needed:

1. Download `clawboot_arm64.deb` onto a Raspberry Pi 5 running 64-bit Raspberry Pi OS with Desktop.
2. Open **Files**, find the downloaded package, and double-click it. If asked which application to use, select **Package Install**.
3. Click **Install** and enter the Raspberry Pi desktop password in the graphical prompt.
4. Open **Raspberry Pi menu → System Tools → ClawBoot**.

The package includes its own verified ARM64 Node.js runtime and does not depend on optional GTK, WebKit, Python, or development packages. It installs the desktop launcher, creates the background setup service, and starts it automatically. ClawBoot itself never opens a terminal or asks the user to type a command. Raspberry Pi OS shows the normal graphical administrator-password prompt only when installing the `.deb` package.

The desktop package installs:

- the desktop app launcher in `/usr/bin/clawboot`;
- a desktop-menu entry and application icon;
- the setup service in `/opt/clawboot`;
- a restricted systemd service on `127.0.0.1:3210`;
- a fixed setup helper that accepts only ClawBoot's packaged installation actions.

The setup service cannot accept arbitrary shell text through its API and cannot grant itself root access. Root permission is installed only by Debian's root-authorized package setup; the loopback setup service merely verifies it before continuing.

## Headless Pi

The desktop app is the normal path. For a headless Pi, forward the private local ports:

```bash
ssh -L 3210:127.0.0.1:3210 -L 18789:127.0.0.1:18789 <user>@<pi-host>
```

Then open `http://127.0.0.1:3210` on the computer running the tunnel.

## Development

```bash
npm install
npm run dev
```

Build the graphical ARM64 desktop package after `npm run build`:

```bash
python3 scripts/build-deb.py --output clawboot_1.2.0_arm64.deb
```

The package builder downloads the official Node.js Linux ARM64 archive and refuses to package it unless its SHA-256 matches the pinned release checksum.

The old source-level `scripts/install.sh` installer is retired because it could not reproduce the packaged runtime, upgrades, Full Pi permission grant, and uninstall behavior. It now exits without changing the system. Contributors should test and build the `.deb` above; users should install the release package.

To run the real setup API safely on a non-Pi computer:

```bash
npm run build
npm run demo:setupd
```

Open `http://127.0.0.1:3210`. Demo mode uses the same resumable job engine and progress stream but does not change the computer.

## Tests

```bash
npm test
npm run lint
```

The test suite covers command allowlisting, secret and QR redaction, Pi consent, persistent model and access choices, cancellation, restart recovery, server-sent progress events, the packaged shell settings, and the rendered setup wizard.

## Security defaults

- The web service, Ollama, and OpenClaw gateway bind to loopback only.
- Ollama cloud access is disabled.
- The setup daemon runs as an unprivileged `openclaw` user.
- The setup UI cannot submit arbitrary shell text to the privileged setup helper.
- Generated gateway tokens are removed from logs and support reports.
- Telegram bot tokens are verified directly with Telegram, redacted from output, and never stored in ClawBoot state.
- Telegram and WhatsApp default to pairing for direct messages, with group access disabled.
- WhatsApp linking QR images are held only while linking is active and are redacted from technical logs.
- Managed Chromium is headless, uses OpenClaw's isolated profile, retains Chromium's sandbox, and cannot import the desktop user's browser profile.
- Final verification runs OpenClaw doctor and deep security audit commands.

OpenClaw gives models access to tools, so local inference does not automatically make an agent safe. ClawBoot v1.2 intentionally enables root-equivalent **Full Pi assistant** access and is not the right package when a restricted chat-only agent is required.

Removing the package stops and disables ClawBoot, its OpenClaw user gateway, user lingering, and the Ollama service, and removes the Full Pi sudo rule. It keeps the downloaded model, OpenClaw account configuration, and resumable ClawBoot state for reinstall. Choosing **purge** also deletes `/var/lib/clawboot`, including setup state and any saved setup credentials.

## Upstream documentation

- [OpenClaw installation](https://docs.openclaw.ai/install)
- [OpenClaw with Ollama](https://docs.openclaw.ai/providers/ollama)
- [OpenClaw Telegram](https://docs.openclaw.ai/channels/telegram)
- [OpenClaw WhatsApp](https://docs.openclaw.ai/channels/whatsapp)
- [OpenClaw web tools](https://docs.openclaw.ai/tools/web)
- [OpenClaw browser](https://docs.openclaw.ai/browser)
- [OpenClaw execution approvals](https://docs.openclaw.ai/tools/exec-approvals)
- [Ollama on Linux](https://docs.ollama.com/linux)
- [Qwen 3.5 2B model](https://ollama.com/library/qwen3.5:2b)
- [Qwen 3.5 4B model](https://ollama.com/library/qwen3.5:4b)

This independent project is not affiliated with Raspberry Pi Ltd., Alibaba, Ollama, or the OpenClaw Foundation. Their names and marks belong to their respective owners.
