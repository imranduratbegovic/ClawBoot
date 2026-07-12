import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSetupService, parseDownloadProgress } from "../../setupd/service.mjs";

test("Ollama byte markers become bounded resumable download progress", () => {
  assert.deepEqual(parseDownloadProgress("CLAWBOOT_DOWNLOAD ollama 778002133 1556004266"), {
    kind: "ollama",
    label: "Ollama runtime",
    downloadedBytes: 778002133,
    totalBytes: 1556004266,
    percent: 50,
  });
  assert.equal(parseDownloadProgress("curl: (92) HTTP/2 stream error"), null);
  assert.equal(parseDownloadProgress("CLAWBOOT_DOWNLOAD ollama nope 1556004266"), null);
});

async function demoService(t, delay = 1) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-service-"));
  const service = await createSetupService({
    config: {
      stateDir: directory,
      home: directory,
      forceDemo: true,
      demoDelayMs: delay,
    },
    persist: false,
  });
  await service.listen(0, "127.0.0.1");
  const { port } = service.server.address();
  t.after(async () => {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { service, base: `http://127.0.0.1:${port}` };
}

async function post(url, body = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("demo API runs an idempotent install and streams progress over SSE", async (t) => {
  const { base } = await demoService(t, 2);

  const preflightResponse = await fetch(`${base}/api/v1/preflight`);
  assert.equal(preflightResponse.status, 200);
  const preflight = await preflightResponse.json();
  assert.equal(preflight.demo, true);
  assert.equal(preflight.canInstall, true);
  assert.equal(preflight.model, "gemma4:e2b-it-qat");

  const firstResponse = await post(`${base}/api/v1/install`);
  assert.equal(firstResponse.status, 202);
  const first = await firstResponse.json();
  assert.match(first.jobId, /^[0-9a-f-]{36}$/);
  assert.equal(first.permissionProfile, "guarded");

  const duplicateResponse = await post(`${base}/api/v1/install`);
  assert.equal(duplicateResponse.status, 202);
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicate.jobId, first.jobId);
  assert.equal(duplicate.reused, true);

  const eventsResponse = await fetch(`${base}${first.eventsUrl}`);
  assert.equal(eventsResponse.status, 200);
  assert.match(eventsResponse.headers.get("content-type"), /text\/event-stream/);
  const events = await eventsResponse.text();
  assert.doesNotMatch(events, /^event:/m);
  assert.match(events, /"type":"step"/);
  assert.match(events, /"status":"complete"/);
  assert.match(events, /gemma4:e2b-it-qat/);
  assert.match(events, /security audit passed with no critical findings/);

  const statusResponse = await fetch(`${base}/api/v1/status`);
  const status = await statusResponse.json();
  assert.equal(status.phase, "complete");
  assert.equal(status.installation.gatewayRunning, true);
  assert.equal(status.installation.securityBaseline, 3);
  assert.equal(status.activeJobId, null);

  const idempotentResponse = await post(`${base}/api/v1/install`);
  assert.equal(idempotentResponse.status, 200);
  const idempotent = await idempotentResponse.json();
  assert.equal(idempotent.jobId, first.jobId);
  assert.equal(idempotent.complete, true);

  const model = await (await post(`${base}/api/v1/verify/model`)).json();
  assert.equal(model.ok, true);
  assert.equal(typeof model.tokensPerSecond, "number");
  assert.equal(typeof model.firstTokenSeconds, "number");
  const agent = await (await post(`${base}/api/v1/verify/agent`)).json();
  assert.equal(agent.ok, true);

  const logsResponse = await fetch(`${base}/api/v1/logs/export`);
  const logs = await logsResponse.text();
  assert.match(logs, /ClawBoot logs/);
  assert.match(logs, /Demo complete/);
  assert.doesNotMatch(logs, /gatewayToken/);
});

test("an active demo job can be cancelled and resumed with a new job", async (t) => {
  const { base } = await demoService(t, 30);
  const started = await (await post(`${base}/api/v1/install`)).json();
  const cancelResponse = await post(`${base}${started.cancelUrl}`);
  assert.equal(cancelResponse.status, 200);
  assert.equal((await cancelResponse.json()).cancelRequested, true);

  let status;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    status = await (await fetch(`${base}/api/v1/status`)).json();
    if (!status.activeJobId) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(status.activeJobId, null);
  assert.equal(status.lastJob.status, "cancelled");
  assert.equal(status.phase, "ready");

  const resumedResponse = await post(`${base}/api/v1/install`);
  assert.equal(resumedResponse.status, 202);
  const resumed = await resumedResponse.json();
  assert.notEqual(resumed.jobId, started.jobId);
});

test("mutation APIs reject form posts and cross-site browser requests", async (t) => {
  const { base } = await demoService(t, 1);
  const form = await fetch(`${base}/api/v1/install`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "",
  });
  assert.equal(form.status, 415);

  const crossSite = await fetch(`${base}/api/v1/install`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Sec-Fetch-Site": "cross-site",
    },
    body: "{}",
  });
  assert.equal(crossSite.status, 403);

  const invalidProfile = await post(`${base}/api/v1/install`, { permissionProfile: "root-shell" });
  assert.equal(invalidProfile.status, 400);
});

test("demo API configures Telegram, links WhatsApp, and exposes safe pairing operations", async (t) => {
  const { base } = await demoService(t, 1);
  const install = await (await post(`${base}/api/v1/install`)).json();
  await (await fetch(`${base}${install.eventsUrl}`)).text();

  const token = "123456789:abcdefghijklmnopqrstuvwxyz_ABCDE";
  const telegramResponse = await post(`${base}/api/v1/channels/telegram`, { token });
  assert.equal(telegramResponse.status, 200);
  const telegram = await telegramResponse.json();
  assert.equal(telegram.status, "connected");
  assert.equal(telegram.bot.username, "clawboot_demo_bot");

  const whatsappResponse = await post(`${base}/api/v1/channels/whatsapp/login`);
  assert.equal(whatsappResponse.status, 202);
  let channels;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    channels = await (await fetch(`${base}/api/v1/channels`)).json();
    if (channels.channels.whatsapp.status === "connected") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(channels.channels.telegram.status, "connected");
  assert.equal(channels.channels.whatsapp.status, "connected");

  const pairingResponse = await fetch(`${base}/api/v1/channels/pairings?channel=telegram`);
  assert.equal(pairingResponse.status, 200);
  assert.deepEqual((await pairingResponse.json()).requests, []);

  const report = await (await fetch(`${base}/api/v1/logs/export`)).text();
  assert.doesNotMatch(report, new RegExp(token));
  const status = await (await fetch(`${base}/api/v1/status`)).text();
  assert.doesNotMatch(status, new RegExp(token));
});

test("real Pi mode requires explicit risk consent before queuing setup", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-risk-"));
  const runner = {
    async prepare() {},
    async run() {
      throw new Error("No install command should run without consent.");
    },
  };
  const service = await createSetupService({
    mode: "pi",
    hostInfo: {
      platform: "linux",
      architecture: "arm64",
      deviceModel: "Raspberry Pi 5 Model B",
      pi5: true,
      arm64: true,
      os: { PRETTY_NAME: "Raspberry Pi OS" },
      memoryBytes: 16 * 1024 ** 3,
      freeDiskBytes: 20 * 1024 ** 3,
      checks: [],
      compatible: true,
    },
    config: { stateDir: directory, home: directory, host: "127.0.0.1" },
    runner,
    persist: false,
  });
  await service.listen(0, "127.0.0.1");
  const { port } = service.server.address();
  t.after(async () => {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const response = await post(`http://127.0.0.1:${port}/api/v1/install`, {
    permissionProfile: "guarded",
    riskAccepted: false,
  });
  assert.equal(response.status, 422);
  const status = await (await fetch(`http://127.0.0.1:${port}/api/v1/status`)).json();
  assert.equal(status.activeJobId, null);
});
