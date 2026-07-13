# ClawBoot 1.1.2

`clawboot_1.1.2_arm64.deb` is the self-contained graphical installer for Raspberry Pi 5 running 64-bit Raspberry Pi OS Desktop.

This release fixes Qwen health checks that could mistake hidden thinking output for a failed model, configures Qwen for direct replies with a Pi-sized context, and treats scope-limited OpenClaw diagnostics as degraded reachability instead of a dead gateway. The local model remains `qwen3.5:2b` and is reused during an upgrade.

SHA-256:

```text
48ed704283ff788bd9d38c81894bbaf3ae06492dfa1bbb360c22c769f1f16928  clawboot_1.1.2_arm64.deb
48ed704283ff788bd9d38c81894bbaf3ae06492dfa1bbb360c22c769f1f16928  clawboot_arm64.deb
```
