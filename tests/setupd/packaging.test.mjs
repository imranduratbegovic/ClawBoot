import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("Ollama service is loopback-only and capped for Raspberry Pi memory", async () => {
  const helper = await fs.readFile(new URL("../../packaging/clawboot-helper", import.meta.url), "utf8");
  for (const setting of [
    "OLLAMA_HOST=127.0.0.1:11434",
    "OLLAMA_NO_CLOUD=1",
    "OLLAMA_MAX_LOADED_MODELS=1",
    "OLLAMA_NUM_PARALLEL=1",
    "CONTEXT_LENGTH=16384",
    "CONTEXT_LENGTH=8192",
  ]) {
    assert.equal(helper.includes(setting), true, `missing ${setting}`);
  }
});

test("headless install instructions forward the setup and gateway ports", async () => {
  const installer = await fs.readFile(new URL("../../scripts/install.sh", import.meta.url), "utf8");
  assert.match(installer, /-L 3210:127\.0\.0\.1:3210 -L 18789:127\.0\.0\.1:18789/);
});

test("desktop package is arm64, starts ClawBoot graphically, and uses the bundled runtime", async () => {
  const [control, postinst, service, wrapper, desktop, builder] = await Promise.all([
    fs.readFile(new URL("../../packaging/debian/control", import.meta.url), "utf8"),
    fs.readFile(new URL("../../packaging/debian/postinst", import.meta.url), "utf8"),
    fs.readFile(new URL("../../packaging/clawboot.service", import.meta.url), "utf8"),
    fs.readFile(new URL("../../packaging/clawboot-service", import.meta.url), "utf8"),
    fs.readFile(new URL("../../packaging/io.openclaw.ClawBoot.desktop", import.meta.url), "utf8"),
    fs.readFile(new URL("../../scripts/build-deb.py", import.meta.url), "utf8"),
  ]);

  assert.match(control, /^Architecture: arm64$/m);
  assert.match(control, /gir1\.2-webkit2-4\.1/);
  assert.match(postinst, /systemctl restart clawboot\.service/);
  assert.match(service, /ExecStart=\/opt\/clawboot\/bin\/clawboot-service/);
  assert.doesNotMatch(service, /OPENCLAW_UID/);
  assert.match(wrapper, /\/opt\/clawboot\/runtime\/bin\/node/);
  assert.match(desktop, /^Terminal=false$/m);
  assert.match(builder, /NODE_SHA256/);
  assert.match(builder, /linux-arm64/);
});
