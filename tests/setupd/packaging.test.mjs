import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("Ollama service is loopback-only and capped for Raspberry Pi memory", async () => {
  const [helper, runner] = await Promise.all([
    fs.readFile(new URL("../../packaging/clawboot-helper", import.meta.url), "utf8"),
    fs.readFile(new URL("../../setupd/command-runner.mjs", import.meta.url), "utf8"),
  ]);
  for (const setting of [
    "OLLAMA_HOST=127.0.0.1:11434",
    "OLLAMA_NO_CLOUD=1",
    "OLLAMA_MAX_LOADED_MODELS=1",
    "OLLAMA_NUM_PARALLEL=1",
    "CONTEXT_LENGTH=8192",
    "CONTEXT_LENGTH=4096",
  ]) {
    assert.equal(helper.includes(setting), true, `missing ${setting}`);
  }
  assert.match(helper, /OLLAMA_VERSION="0\.31\.2"/);
  assert.match(helper, /github\.com\/ollama\/ollama\/releases\/download\/v\$\{OLLAMA_VERSION\}/);
  assert.match(helper, /OLLAMA_ARCHIVE_SHA256="07a0adfcf3ed48ff110e2a3bcec897ca4d3f77d6f817d6ff63e83debfd102a31"/);
  assert.match(helper, /sha256sum --check --status/);
  assert.match(helper, /OLLAMA_ARCHIVE_BYTES=1556004266/);
  assert.match(helper, /OLLAMA_CACHE_DIR=\/var\/cache\/clawboot\/downloads/);
  assert.match(helper, /--http1\.1/);
  assert.match(helper, /--continue-at -/);
  assert.match(helper, /--retry 10 --retry-delay 3 --retry-all-errors/);
  assert.match(helper, /CLAWBOOT_DOWNLOAD ollama/);
  assert.match(helper, /partial download was saved; Retry will continue/);
  assert.match(helper, /restart-ollama\) restart_ollama/);
  assert.match(helper, /systemctl restart ollama\.service/);
  assert.match(runner, /case "installOllamaArm64"[\s\S]*timeoutMs: 3 \* 60 \* 60_000/);
  assert.match(helper, /dpkg --configure -a/);
  assert.match(helper, /--fix-broken install -y/);
});

test("headless install instructions forward the setup and gateway ports", async () => {
  const installer = await fs.readFile(new URL("../../scripts/install.sh", import.meta.url), "utf8");
  assert.match(installer, /-L 3210:127\.0\.0\.1:3210 -L 18789:127\.0\.0\.1:18789/);
});

test("desktop package uses only Pi-standard base dependencies and self-heals", async () => {
  const [control, postinst, service, wrapper, repair, desktop, launcher, builder] = await Promise.all([
    fs.readFile(new URL("../../packaging/debian/control", import.meta.url), "utf8"),
    fs.readFile(new URL("../../packaging/debian/postinst", import.meta.url), "utf8"),
    fs.readFile(new URL("../../packaging/clawboot.service", import.meta.url), "utf8"),
    fs.readFile(new URL("../../packaging/clawboot-service", import.meta.url), "utf8"),
    fs.readFile(new URL("../../packaging/clawboot-repair", import.meta.url), "utf8"),
    fs.readFile(new URL("../../packaging/io.openclaw.ClawBoot.desktop", import.meta.url), "utf8"),
    fs.readFile(new URL("../../desktop/clawboot", import.meta.url), "utf8"),
    fs.readFile(new URL("../../scripts/build-deb.py", import.meta.url), "utf8"),
  ]);

  assert.match(control, /^Architecture: arm64$/m);
  assert.match(control, /^Depends: sudo, systemd, libc6, libstdc\+\+6, libgcc-s1$/m);
  assert.doesNotMatch(control, /^Pre-Depends:/m);
  assert.match(postinst, /clawboot-repair/);
  assert.match(postinst, /case "\$\{1:-\}" in/);
  assert.match(postinst, /configure\)/);
  assert.match(postinst, /exit 0/);
  assert.match(service, /ExecStart=\/opt\/clawboot\/bin\/clawboot-service/);
  assert.doesNotMatch(service, /OPENCLAW_UID/);
  assert.match(wrapper, /\/opt\/clawboot\/runtime\/bin\/node/);
  assert.match(repair, /groupadd --system/);
  assert.match(repair, /useradd --system --gid/);
  assert.match(repair, /systemctl restart clawboot\.service/);
  assert.match(desktop, /^Terminal=false$/m);
  assert.match(launcher, /chromium chromium-browser/);
  assert.match(launcher, /pkexec \/opt\/clawboot\/bin\/clawboot-repair/);
  assert.match(launcher, /AbortSignal\.timeout\(1500\)/);
  assert.match(launcher, /--incognito/);
  assert.match(launcher, /--private-window/);
  assert.doesNotMatch(launcher, /python|WebKit|import gi/);
  assert.match(builder, /NODE_SHA256/);
  assert.match(builder, /linux-arm64/);
  assert.match(builder, /replace\(b"\\r\\n", b"\\n"\)/);
  assert.match(builder, /format=tarfile\.GNU_FORMAT/g);
  assert.doesNotMatch(builder, /tarfile\.PAX_FORMAT/);
  assert.match(builder, /TarInfo\("\.\/opt\/clawboot\/runtime"\)/);

  for (const script of [wrapper, repair, launcher]) {
    assert.equal(script.startsWith("#!/bin/sh\n"), true);
    assert.equal(script.includes("\r\n"), false);
  }
});
