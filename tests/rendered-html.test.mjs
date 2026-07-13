import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const html = await readFile(new URL("../dist/client/index.html", import.meta.url), "utf8");
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

test("renders a simple setup wizard rather than a marketing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>ClawBoot<\/title>/i);
  assert.match(html, /Check your Raspberry Pi/i);
  assert.match(html, /Setup steps/i);
  assert.match(html, /REFRESH/i);
  assert.doesNotMatch(html, /Clawberry|private little brain|hero|codex-preview/i);
});

test("wires the wizard to the real resumable setup service", async () => {
  const [page, css, packageJson, service, launcher, desktopEntry] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../setupd/service.mjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/clawboot", import.meta.url), "utf8"),
    readFile(new URL("../packaging/io.openclaw.ClawBoot.desktop", import.meta.url), "utf8"),
  ]);

  assert.match(page, /qwen3\.5:2b/);
  assert.match(page, /APP_VERSION = "1\.1\.2"/);
  assert.match(page, /background service is/);
  assert.match(page, /api\/v1\/status/);
  assert.match(page, /activeJobId/);
  assert.match(page, /new EventSource/);
  assert.match(page, /api\/v1\/channels\/telegram/);
  assert.match(page, /api\/v1\/channels\/whatsapp\/login/);
  assert.match(page, /api\/v1\/channels\/pairings\/approve/);
  assert.match(page, /No terminal or extra password prompt/);
  assert.match(page, /About 4\.2 GB total/);
  assert.match(page, /Interrupted downloads resume instead of restarting/);
  assert.match(page, /download-progress/);
  assert.match(page, /FAILURE DIAGNOSIS/);
  assert.match(page, /What to do/);
  assert.doesNotMatch(page, /simulateInstall|Clawberry/);
  assert.match(css, /--red:\s*#bd1e3e/i);
  assert.match(packageJson, /"name": "clawboot"/);
  assert.match(service, /text\/event-stream/);
  assert.match(launcher, /--app="\$SETUP_ORIGIN\/\?v=\$EXPECTED_VERSION"/);
  assert.match(launcher, /firefox-esr firefox/);
  assert.doesNotMatch(launcher, /python|WebKit|import gi/);
  assert.match(launcher, /127\.0\.0\.1:3210/);
  assert.match(desktopEntry, /Terminal=false/);
});
