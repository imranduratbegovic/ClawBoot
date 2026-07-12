# ClawBoot

An open-source Raspberry Pi OS application that installs and configures OpenClaw with a fully local Gemma 4 E2B model. The goal is simple: replace the command-line setup with a short, reliable wizard.

## Download

[**Download ClawBoot for Raspberry Pi 5**](https://github.com/imranduratbegovic/ClawBoot/releases/latest/download/clawboot_arm64.deb)

Open the downloaded package with **Package Install**, then click **Install**. No terminal is required.

The interface follows the same basic pattern as Raspberry Pi Imager: one dedicated app window, a clear step list, one task per screen, and normal Back / Next / Install controls.

## What the app does

1. Checks for a Raspberry Pi 5, 64-bit OS, enough RAM, storage, and internet access.
2. Installs the ARM64 Ollama runtime.
3. Downloads `gemma4:e2b-it-qat`, the 4.3 GB Gemma 4 E2B QAT model.
4. Installs OpenClaw and configures its native Ollama provider.
5. Applies a selected access profile and loopback-only networking.
6. Starts both services and runs model, gateway, doctor, and security checks.
7. Connects Telegram through a BotFather token, with identity verification and owner pairing.
8. Installs the official WhatsApp plugin, displays the live linking QR, and approves trusted numbers.

Installation is resumable. Closing the window does not stop an active download or installation, and reopening the app reconnects to the current job.

The first setup downloads approximately 5.8 GB: about 1.5 GB for the official Ollama ARM64 runtime and 4.3 GB for the Gemma model. Runtime downloads use HTTP/1.1 byte ranges and a persistent cache under `/var/cache/clawboot/downloads`; a dropped connection, cancellation, or Retry continues from the saved byte instead of restarting the archive.

## Requirements

- Raspberry Pi 5
- 64-bit Raspberry Pi OS Bookworm or newer
- 16 GB RAM recommended; 8 GB is supported but experimental and slower
- At least 12 GB of free storage; an SSD or NVMe drive is recommended
- Internet access during installation

## Install on the Raspberry Pi desktop

No terminal is needed:

1. Download `clawboot_arm64.deb` onto a Raspberry Pi 5 running 64-bit Raspberry Pi OS with Desktop.
2. Open **Files**, find the downloaded package, and double-click it. If asked which application to use, select **Package Install**.
3. Click **Install** and enter the Raspberry Pi desktop password in the graphical prompt.
4. Open **Raspberry Pi menu → System Tools → ClawBoot**.

The package includes its own verified ARM64 Node.js runtime and does not depend on optional GTK, WebKit, Python or development packages. It installs the desktop launcher, creates the restricted background service, and starts it automatically. ClawBoot itself never opens a terminal or asks the user to type a command.

The desktop package installs:

- the desktop app launcher in `/usr/bin/clawboot`;
- a desktop-menu entry and application icon;
- the setup service in `/opt/clawboot`;
- a restricted systemd service on `127.0.0.1:3210`;
- a fixed root helper that accepts only the required installation actions.

The legacy `scripts/install.sh` path remains available for contributors and recovery, but it is not part of the normal user experience.

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
python3 scripts/build-deb.py --output clawboot_1.0.5_arm64.deb
```

The package builder downloads the official Node.js Linux ARM64 archive and refuses to package it unless its SHA-256 matches the pinned release checksum.

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

The test suite covers command allowlisting, secret redaction, Pi consent, persistent state, cancellation, restart recovery, server-sent progress events, the packaged shell settings, and the rendered setup wizard.

## Security defaults

- The web service, Ollama, and OpenClaw gateway bind to loopback only.
- Ollama cloud access is disabled.
- The setup daemon runs as an unprivileged `openclaw` user.
- The browser UI cannot submit arbitrary shell commands.
- Generated gateway tokens are removed from logs and support reports.
- Telegram bot tokens are verified directly with Telegram, redacted from output, and never stored in ClawBoot state.
- Telegram and WhatsApp default to pairing for direct messages, with group access disabled.
- Final verification runs OpenClaw doctor and deep security audit commands.

OpenClaw gives models access to tools, so a small local model should still be treated carefully. The recommended profile asks before commands and keeps file access in the agent workspace.

## Upstream documentation

- [OpenClaw installation](https://docs.openclaw.ai/install)
- [OpenClaw with Ollama](https://docs.openclaw.ai/providers/ollama)
- [OpenClaw Telegram](https://docs.openclaw.ai/providers/telegram)
- [OpenClaw WhatsApp](https://docs.openclaw.ai/providers/whatsapp)
- [Ollama on Linux](https://docs.ollama.com/linux)
- [Gemma 4 model tags](https://ollama.com/library/gemma4/tags)

This independent project is not affiliated with Raspberry Pi Ltd., Google, Ollama, or the OpenClaw Foundation. Their names and marks belong to their respective owners.
