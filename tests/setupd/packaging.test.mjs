import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("Ollama service is loopback-only and capped for Raspberry Pi memory", async () => {
  const [helper, runner, sudoers, service, postrm] = await Promise.all([
    fs.readFile(new URL("../../packaging/clawboot-helper", import.meta.url), "utf8"),
    fs.readFile(new URL("../../setupd/command-runner.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../../packaging/clawboot.sudoers", import.meta.url), "utf8"),
    fs.readFile(new URL("../../setupd/service.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../../packaging/debian/postrm", import.meta.url), "utf8"),
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
  assert.match(helper, /test -x \/usr\/lib\/ollama\/llama-server/);
  assert.match(helper, /rm -rf \/usr\/lib\/ollama/);
  assert.match(helper, /install -d -o root -g root -m 0755 \/usr\/lib\/ollama/);
  assert.match(helper, /rm -rf \/usr\/lib\/ollama[\s\S]*install -d -o root -g root -m 0755 \/usr\/lib\/ollama[\s\S]*tar -xf - -C \/usr/);
  assert.match(helper, /chmod 0755 \/usr\/lib\/ollama/);
  assert.match(helper, /runuser -u ollama -- test -x \/usr\/lib\/ollama\/llama-server/);
  assert.match(helper, /write_ollama_service[\s\S]*systemctl stop ollama\.service[\s\S]*systemctl restart ollama\.service/);
  assert.match(helper, /readlink -f "\/proc\/\$MAIN_PID\/exe"/);
  assert.match(helper, /api\/version/);
  assert.match(helper, /ensure-ollama-runtime\) ensure_ollama_runtime/);
  assert.match(helper, /restart-ollama\) restart_ollama/);
  assert.match(helper, /systemctl restart ollama\.service/);
  for (const action of ["prepare-system", "install-ollama-arm64", "ensure-ollama-runtime", "configure-ollama-loopback", "restart-ollama", "ensure-chromium"]) {
    assert.match(sudoers, new RegExp(`^openclaw ALL=\\(root\\) NOPASSWD: /usr/local/libexec/clawboot-helper ${action}$`, "m"));
  }
  assert.doesNotMatch(sudoers, /(?:enable|disable)-agent-root/);
  assert.match(helper, /ensure_chromium\(\)/);
  assert.match(helper, /\/usr\/bin\/chromium \/usr\/bin\/chromium-browser/);
  assert.match(helper, /\/usr\/local\/bin\/clawboot-chromium/);
  assert.match(helper, /openclaw ALL=\(ALL:ALL\) NOPASSWD: ALL/);
  assert.match(helper, /visudo -cf/);
  assert.doesNotMatch(helper, /disable-agent-root/);
  assert.match(postrm, /remove\|purge\|disappear\|abort-install[\s\S]*rm -f \/etc\/sudoers\.d\/clawboot-agent-full-access/);
  assert.match(postrm, /upgrade\|failed-upgrade\|abort-upgrade[\s\S]*Keep Full Pi access across package upgrades/);
  assert.match(runner, /noSandbox:\s*false/);
  assert.match(runner, /case "installOllamaArm64"[\s\S]*timeoutMs: 3 \* 60 \* 60_000/);
  assert.match(service, /async verify\(\{ jobId, signal \}\)[\s\S]*runAction\(jobId, "ensureOllamaRuntime"[\s\S]*runAction\(jobId, "configureOllamaLoopback"/);
  assert.match(service, /runner\.run\("ollamaRuntimeStatus"[\s\S]*ollamaInstalled = false/);
  assert.match(service, /runAction\(jobId, "configurePrimaryModel"[\s\S]*runAction\(jobId, "configureLocalModelDefaults"/);
  assert.match(service, /think: false[\s\S]*num_predict: 32/);
  assert.match(service, /runAction\(jobId, "openclawGatewayProbe"[\s\S]*probe\?\.ok === true/);
  assert.match(helper, /dpkg --configure -a/);
  assert.match(helper, /--fix-broken install -y/);
});

test("retired source installer refuses to mutate the system", async () => {
  const installer = await fs.readFile(new URL("../../scripts/install.sh", import.meta.url), "utf8");
  assert.match(installer, /retired, contributor-facing guard/);
  assert.match(installer, /does not install/);
  assert.match(installer, /clawboot_1\.2\.0_arm64\.deb/);
  assert.match(installer, /exit 64/);
  assert.doesNotMatch(installer, /\b(?:apt-get|systemctl|sudo|install -[dom])\b/);
});

test("AppStream discloses model choices and Full Pi privileges", async () => {
  const metainfo = await fs.readFile(new URL("../../packaging/io.openclaw.ClawBoot.metainfo.xml", import.meta.url), "utf8");
  assert.match(metainfo, /Qwen 3\.5 2B or 4B/);
  assert.match(metainfo, /WhatsApp QR linking/);
  assert.match(metainfo, /Full Pi assistant profile is intentionally root-equivalent/);
  assert.match(metainfo, /passwordless sudo/);
});

test("package removal stops managed services without disrupting upgrades", async () => {
  const [prerm, postrm] = await Promise.all([
    fs.readFile(new URL("../../packaging/debian/prerm", import.meta.url), "utf8"),
    fs.readFile(new URL("../../packaging/debian/postrm", import.meta.url), "utf8"),
  ]);

  assert.match(prerm, /remove\|deconfigure\)[\s\S]*disable --now clawboot\.service/);
  assert.match(prerm, /systemctl --user disable --now openclaw-gateway\.service/);
  assert.match(prerm, /rm -f \/var\/lib\/openclaw\/\.config\/systemd\/user\/default\.target\.wants\/openclaw-gateway\.service/);
  assert.match(prerm, /loginctl disable-linger/);
  assert.match(prerm, /systemctl stop "user@\$\{SERVICE_UID\}\.service"/);
  assert.match(prerm, /disable --now ollama\.service/);
  assert.match(prerm, /upgrade\|failed-upgrade\)[\s\S]*replacement package/);
  assert.match(postrm, /if \[ "\$\{1:-\}" = purge \][\s\S]*rm -rf \/var\/lib\/clawboot/);
  assert.match(postrm, /ordinary removal intentionally keeps resumable state/);
});

test("desktop package uses only Pi-standard base dependencies and self-heals", async () => {
  const [control, preinst, postinst, service, wrapper, repair, desktop, launcher, builder] = await Promise.all([
    fs.readFile(new URL("../../packaging/debian/control", import.meta.url), "utf8"),
    fs.readFile(new URL("../../packaging/debian/preinst", import.meta.url), "utf8"),
    fs.readFile(new URL("../../packaging/debian/postinst", import.meta.url), "utf8"),
    fs.readFile(new URL("../../packaging/clawboot.service", import.meta.url), "utf8"),
    fs.readFile(new URL("../../packaging/clawboot-service", import.meta.url), "utf8"),
    fs.readFile(new URL("../../packaging/clawboot-repair", import.meta.url), "utf8"),
    fs.readFile(new URL("../../packaging/io.openclaw.ClawBoot.desktop", import.meta.url), "utf8"),
    fs.readFile(new URL("../../desktop/clawboot", import.meta.url), "utf8"),
    fs.readFile(new URL("../../scripts/build-deb.py", import.meta.url), "utf8"),
  ]);

  assert.match(control, /^Architecture: arm64$/m);
  assert.match(control, /grants the OpenClaw service account passwordless[\s\S]*root access/);
  assert.match(control, /^Depends: sudo, systemd, libc6, libstdc\+\+6, libgcc-s1$/m);
  assert.doesNotMatch(control, /^Pre-Depends:/m);
  assert.match(preinst, /systemctl stop clawboot\.service/);
  assert.match(postinst, /clawboot-repair/);
  assert.match(postinst, /clawboot-helper enable-agent-root/);
  assert.match(postinst, /case "\$\{1:-\}" in/);
  assert.match(postinst, /configure\)/);
  assert.match(postinst, /retrying once/);
  assert.match(postinst, /exit 0/);
  assert.match(service, /ExecStart=\/opt\/clawboot\/bin\/clawboot-service/);
  assert.doesNotMatch(service, /OPENCLAW_UID/);
  assert.match(wrapper, /\/opt\/clawboot\/runtime\/bin\/node/);
  assert.match(repair, /groupadd --system/);
  assert.match(repair, /useradd --system --gid/);
  assert.match(repair, /systemctl restart clawboot\.service/);
  assert.match(repair, /body\.serviceVersion === process\.argv\[2\]/);
  assert.match(repair, /systemctl is-active --quiet clawboot\.service/);
  assert.match(desktop, /^Terminal=false$/m);
  assert.match(launcher, /chromium chromium-browser/);
  assert.match(launcher, /pkexec \/opt\/clawboot\/bin\/clawboot-repair/);
  assert.match(launcher, /AbortSignal\.timeout\(1500\)/);
  assert.match(launcher, /body\.serviceVersion === process\.argv\[2\]/);
  assert.match(launcher, /VERSION_FILE=\/opt\/clawboot\/VERSION/);
  assert.match(launcher, /--incognito/);
  assert.match(launcher, /--private-window/);
  assert.doesNotMatch(launcher, /python|WebKit|import gi/);
  assert.match(builder, /NODE_SHA256/);
  assert.match(builder, /linux-arm64/);
  assert.match(builder, /VINEXT_DEPLOYMENT_ID/);
  assert.match(builder, /assets\/_vinext_fonts/);
  assert.match(builder, /Expected one vinext deployment id/);
  assert.match(builder, /opt\/clawboot\/VERSION.*write_bytes/);
  assert.match(builder, /\("preinst", "postinst", "prerm", "postrm"\)/);
  assert.match(builder, /replace\(b"\\r\\n", b"\\n"\)/);
  assert.match(builder, /format=tarfile\.GNU_FORMAT/g);
  assert.doesNotMatch(builder, /tarfile\.PAX_FORMAT/);
  assert.match(builder, /TarInfo\("\.\/opt\/clawboot\/runtime"\)/);

  for (const script of [preinst, wrapper, repair, launcher]) {
    assert.equal(script.startsWith("#!/bin/sh\n"), true);
    assert.equal(script.includes("\r\n"), false);
  }
});
