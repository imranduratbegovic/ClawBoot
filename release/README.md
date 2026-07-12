# ClawBoot 1.1.1

`clawboot_1.1.1_arm64.deb` is the self-contained graphical installer for Raspberry Pi 5 running 64-bit Raspberry Pi OS Desktop.

This release repairs the Ollama runtime directory permissions created by earlier ClawBoot versions, verifies `llama-server` as the actual `ollama` service user, and prevents an old background service from surviving an application upgrade. The local model remains `qwen3.5:2b`.

SHA-256:

```text
e43664b3ee75bc91612e0e834017c5ea7890bc1de308a140e16274b6e9f3ff4d  clawboot_1.1.1_arm64.deb
e43664b3ee75bc91612e0e834017c5ea7890bc1de308a140e16274b6e9f3ff4d  clawboot_arm64.deb
```
