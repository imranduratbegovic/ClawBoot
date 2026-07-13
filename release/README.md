# ClawBoot 1.2.0

`clawboot_1.2.0_arm64.deb` is the self-contained graphical installer for Raspberry Pi 5 running 64-bit Raspberry Pi OS Desktop.

This release turns ClawBoot into a practical whole-Pi assistant: selectable Qwen 3.5 2B/4B models, key-free web search and page reading, isolated Chromium automation, a real rotating WhatsApp QR image, and one explicit Full Pi mode with no-prompt commands, host-wide files, and passwordless `sudo`. Existing Ollama and model downloads are preserved during upgrade.

Full Pi mode is root-equivalent, and installing this `.deb` is the permission grant that installs its passwordless-sudo rule. Use it only on a Pi dedicated to an assistant, pair only accounts you trust, and keep messaging groups disabled. Uninstalling ClawBoot removes the rule.

SHA-256:

```text
c07d68acd275fdffd925c88b5187fdc99717b2c54d1ed6d1f3233b1bdc317676  clawboot_1.2.0_arm64.deb
c07d68acd275fdffd925c88b5187fdc99717b2c54d1ed6d1f3233b1bdc317676  clawboot_arm64.deb
```
