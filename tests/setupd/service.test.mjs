import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_MODEL_ID, MODEL_ID } from "../../setupd/config.mjs";
import { assessSecurityAudit, createSetupService, diagnoseSetupFailure, parseDownloadProgress } from "../../setupd/service.mjs";
import { initialState, StateStore } from "../../setupd/state.mjs";

test("setup failures become plain-language technical diagnoses", () => {
  const server = diagnoseSetupFailure(new Error("https://registry.npmjs.org/openclaw returned HTTP 500."), { title: "Install OpenClaw" });
  assert.equal(server.code, "REMOTE_SERVER_ERROR");
  assert.equal(server.step, "Install OpenClaw");
  assert.match(server.problem, /remote.*server/i);
  assert.match(server.nextAction, /Retry/);

  const disk = diagnoseSetupFailure(new Error("ENOSPC: no space left on device"), { title: "Download model" });
  assert.equal(disk.code, "DISK_FULL");
  assert.match(disk.nextAction, /Free some disk space/);

  const ollama = diagnoseSetupFailure(new Error('http://127.0.0.1:11434/api/generate returned HTTP 500: {"error":"model runner crashed"}'), { title: "Run final checks" });
  assert.equal(ollama.code, "LOCAL_MODEL_ERROR");
  assert.match(ollama.problem, /local Ollama/i);

  const privilege = diagnoseSetupFailure(new Error("Allowlisted action restartOllama failed (exit 1): sudo: a password is required"), { title: "Run final checks" });
  assert.equal(privilege.code, "PRIVILEGE_RULE_MISSING");
  assert.match(privilege.reason, /does not need or store your desktop password/);

  const runtime = diagnoseSetupFailure(new Error('http://127.0.0.1:11434/api/generate returned HTTP 500: {"error":"llama-server binary not found"}'), { title: "Run final checks" });
  assert.equal(runtime.code, "OLLAMA_RUNTIME_INCOMPLETE");
  assert.match(runtime.reason, /not insufficient Raspberry Pi memory/);
});

test("security audit accepts only the explicitly acknowledged small-local-model critical", () => {
  assert.deepEqual(
    assessSecurityAudit({
      summary: { critical: 1, warning: 2 },
      findings: [{ checkId: "models.small_params", severity: "critical" }],
    }),
    { critical: 1, warnings: 2, acceptedSmallModelCritical: 1 },
  );
  assert.throws(
    () => assessSecurityAudit({
      summary: { critical: 1, warning: 0 },
      findings: [{ checkId: "tools.dangerous_exposure", severity: "critical" }],
    }),
    /tools\.dangerous_exposure/,
  );
  assert.throws(
    () => assessSecurityAudit({ summary: { critical: 1 }, findings: [] }),
    /critical finding/,
  );
});

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

async function waitForWhatsApp(base, predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const payload = await (await fetch(`${base}/api/v1/channels`)).json();
    const whatsapp = payload.channels.whatsapp;
    if (predicate(whatsapp)) return whatsapp;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for WhatsApp state.");
}

test("demo API runs an idempotent install and streams progress over SSE", async (t) => {
  const { base } = await demoService(t, 2);

  const preflightResponse = await fetch(`${base}/api/v1/preflight`);
  assert.equal(preflightResponse.status, 200);
  const preflight = await preflightResponse.json();
  assert.equal(preflight.demo, true);
  assert.equal(preflight.canInstall, true);
  assert.equal(preflight.model, DEFAULT_MODEL_ID);
  assert.deepEqual(preflight.models.map((model) => model.id), ["qwen3.5:2b", "qwen3.5:4b"]);

  const firstResponse = await post(`${base}/api/v1/install`);
  assert.equal(firstResponse.status, 202);
  const first = await firstResponse.json();
  assert.match(first.jobId, /^[0-9a-f-]{36}$/);
  assert.equal(first.model, DEFAULT_MODEL_ID);
  assert.equal(first.permissionProfile, "open");

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
  assert.match(events, /qwen3\.5:2b/);
  assert.match(events, /expected small-local-model tool risk as critical/);
  assert.match(events, /key-free DuckDuckGo web search/);
  assert.match(events, /full Pi assistant tool profile/);
  assert.match(events, /host-wide filesystem tools/);
  assert.match(events, /patching outside the agent workspace/);
  assert.match(events, /no-prompt host command execution/);
  assert.match(events, /isolated Chromium automation/);
  assert.match(events, /passwordless sudo/);

  const statusResponse = await fetch(`${base}/api/v1/status`);
  const status = await statusResponse.json();
  assert.equal(status.phase, "complete");
  assert.equal(status.installation.gatewayRunning, true);
  assert.equal(status.installation.model, DEFAULT_MODEL_ID);
  assert.equal(status.installation.permissionProfile, "open");
  assert.equal(status.installation.securityBaseline, 10);
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

test("v1.2 rejects restricted profiles because every install is explicitly root-equivalent", async (t) => {
  const { base } = await demoService(t, 1);
  for (const permissionProfile of ["guarded", "chat"]) {
    const response = await post(`${base}/api/v1/install`, { permissionProfile });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.match(payload.error, /only the open Full Pi permission profile/);
  }
});

test("a completed 2B job does not mask a requested 4B install and the 4B choice persists", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawboot-model-persistence-"));
  const stateFile = path.join(directory, "state.json");
  const services = [];
  t.after(async () => {
    for (const service of services.reverse()) await service.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function startService() {
    const service = await createSetupService({
      mode: "demo",
      config: { stateDir: directory, stateFile, home: directory, forceDemo: true, demoDelayMs: 1 },
      persist: true,
    });
    await service.listen(0, "127.0.0.1");
    services.push(service);
    const { port } = service.server.address();
    return { service, base: `http://127.0.0.1:${port}` };
  }

  const firstRun = await startService();
  const twoB = await (await post(`${firstRun.base}/api/v1/install`)).json();
  await (await fetch(`${firstRun.base}${twoB.eventsUrl}`)).text();
  await firstRun.service.close();
  services.pop();

  const secondRun = await startService();
  const beforeSwitch = await (await fetch(`${secondRun.base}/api/v1/status`)).json();
  assert.equal(beforeSwitch.installation.model, "qwen3.5:2b");
  const fourBResponse = await post(`${secondRun.base}/api/v1/install`, { model: "qwen3.5:4b" });
  assert.equal(fourBResponse.status, 202);
  const fourB = await fourBResponse.json();
  assert.equal(fourB.model, "qwen3.5:4b");
  assert.notEqual(fourB.jobId, twoB.jobId);
  const fourBEvents = await (await fetch(`${secondRun.base}${fourB.eventsUrl}`)).text();
  assert.match(fourBEvents, /pulling manifest for qwen3\.5:4b/);
  assert.match(fourBEvents, /Qwen 3\.5 4B completed its local inference health check/);
  await secondRun.service.close();
  services.pop();

  const thirdRun = await startService();
  const persisted = await (await fetch(`${thirdRun.base}/api/v1/status`)).json();
  assert.equal(persisted.installation.model, "qwen3.5:4b");
  assert.equal(persisted.installation.modelInstalled, true);
  const idempotentResponse = await post(`${thirdRun.base}/api/v1/install`, { model: "qwen3.5:4b" });
  assert.equal(idempotentResponse.status, 200);
  const idempotent = await idempotentResponse.json();
  assert.equal(idempotent.complete, true);
  assert.equal(idempotent.reused, true);
  assert.equal(idempotent.jobId, fourB.jobId);
});

test("upgrading security baseline 9 to 10 reruns policy checks without pulling Qwen again", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawboot-baseline-upgrade-"));
  const stateFile = path.join(directory, "state.json");
  const persisted = initialState("demo");
  persisted.installation = {
    ...persisted.installation,
    completedSteps: ["preflight", "system", "ollama", "model", "openclaw", "onboard", "verify"],
    ollamaInstalled: true,
    modelInstalled: true,
    openclawInstalled: true,
    agentConfigured: true,
    gatewayRunning: true,
    securityBaseline: 9,
    lastJobId: "old-complete-job",
  };
  persisted.jobs["old-complete-job"] = {
    id: "old-complete-job",
    model: DEFAULT_MODEL_ID,
    permissionProfile: "open",
    status: "complete",
    events: [],
    createdAt: new Date().toISOString(),
  };
  persisted.secrets.gatewayToken = "persisted-gateway-token-for-baseline-test";
  await fs.writeFile(stateFile, `${JSON.stringify(persisted, null, 2)}\n`);

  const service = await createSetupService({
    mode: "demo",
    config: { stateDir: directory, stateFile, home: directory, forceDemo: true, demoDelayMs: 1 },
    persist: true,
  });
  await service.listen(0, "127.0.0.1");
  t.after(async () => {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const { port } = service.server.address();
  const base = `http://127.0.0.1:${port}`;

  const response = await post(`${base}/api/v1/install`);
  assert.equal(response.status, 202);
  const upgrade = await response.json();
  const events = await (await fetch(`${base}${upgrade.eventsUrl}`)).text();
  assert.match(events, /full Pi assistant tool profile/);
  assert.doesNotMatch(events, /pulling manifest/);
  assert.doesNotMatch(events, /Downloading Qwen/);
  const status = await (await fetch(`${base}/api/v1/status`)).json();
  assert.equal(status.installation.modelInstalled, true);
  assert.equal(status.installation.securityBaseline, 10);
});

test("retry repairs a missing Ollama runtime even when the v1.0.10 Ollama step was persisted as complete", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawboot-v1.0.10-retry-"));
  const stateFile = path.join(directory, "state.json");
  const persisted = initialState("pi");
  persisted.installation = {
    ...persisted.installation,
    completedSteps: ["preflight", "system", "ollama", "model", "openclaw", "onboard"],
    ollamaInstalled: true,
    modelInstalled: true,
    openclawInstalled: true,
    agentConfigured: true,
    gatewayRunning: true,
    securityBaseline: 5,
    fullAccessConsentVersion: 1,
  };
  persisted.secrets.gatewayToken = "persisted-gateway-token-for-retry-test";
  await fs.writeFile(stateFile, `${JSON.stringify(persisted, null, 2)}\n`);

  const trace = [];
  const runner = {
    async prepare() {},
    async run(action, context = {}) {
      trace.push(action);
      if (action === "ollamaRuntimeStatus") {
        throw new Error("/usr/lib/ollama/llama-server is missing");
      }
      const stdout = action === "openclawSecurityDeep"
        ? '{"summary":{"critical":0,"warn":0,"info":0}}'
        : action === "openclawVersion"
          ? "OpenClaw 2026.6.11"
        : action === "openclawGatewayProbe"
          ? '{"ok":true,"degraded":true,"capability":"connected_no_operator_scope"}'
          : "ok";
      context.onLine?.({ source: "stdout", line: stdout });
      return { code: 0, stdout, stderr: "" };
    },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "http://127.0.0.1:11434/api/tags") {
      return new Response(JSON.stringify({ models: [{ name: MODEL_ID }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "http://127.0.0.1:11434/api/generate") {
      trace.push("apiGenerate");
      const request = JSON.parse(String(init?.body ?? "{}"));
      assert.equal(request.think, false);
      assert.equal(request.options.num_predict, 32);
      return new Response(JSON.stringify({
        response: "",
        thinking: "READY",
        done: true,
        done_reason: "stop",
        eval_count: 1,
        eval_duration: 1_000_000_000,
        total_duration: 2_000_000_000,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const service = await createSetupService({
    mode: "pi",
    hostInfo: {
      platform: "linux",
      architecture: "arm64",
      deviceModel: "Raspberry Pi 5 Model B",
      pi5: true,
      arm64: true,
      os: { PRETTY_NAME: "Raspberry Pi OS" },
      memoryBytes: 8 * 1024 ** 3,
      freeDiskBytes: 20 * 1024 ** 3,
      checks: [],
      compatible: true,
    },
    config: { stateDir: directory, stateFile, home: directory, host: "127.0.0.1" },
    runner,
    persist: true,
  });
  await service.listen(0, "127.0.0.1");
  t.after(async () => {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const { port } = service.server.address();
  const retryResponse = await post(`http://127.0.0.1:${port}/api/v1/install`, {
    permissionProfile: "open",
    riskAccepted: false,
  });
  assert.equal(retryResponse.status, 202);
  const retry = await retryResponse.json();
  let completed;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    completed = service.store.snapshot().jobs[retry.jobId];
    const finalEventWritten = completed.events?.some(
      (event) => event.type === "job" && event.status === "complete",
    );
    if (finalEventWritten || ["failed", "cancelled"].includes(completed.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(completed.status, "complete", completed.error);
  const runtimeCheck = trace.indexOf("ollamaRuntimeStatus");
  const runtimeRepair = trace.indexOf("ensureOllamaRuntime");
  const finalInference = trace.indexOf("apiGenerate");
  assert.ok(runtimeCheck >= 0, `Expected a runtime check in: ${trace.join(", ")}`);
  assert.ok(runtimeRepair > runtimeCheck, `Expected repair after the failed runtime check in: ${trace.join(", ")}`);
  assert.ok(finalInference > runtimeRepair, `Expected repair before final inference in: ${trace.join(", ")}`);
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

test("WhatsApp exposes PNG QR images, rotates them, and clears them after connection or failure", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawboot-whatsapp-qr-"));
  const store = new StateStore({ file: path.join(directory, "state.json"), mode: "pi", persist: false });
  await store.init();
  await store.update((state) => {
    Object.assign(state.installation, {
      ollamaInstalled: true,
      modelInstalled: true,
      openclawInstalled: true,
      agentConfigured: true,
      gatewayRunning: true,
      securityBaseline: 10,
    });
    state.secrets.gatewayToken = "gateway-token-long-enough-for-whatsapp-test";
  });

  const qrOne = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
  const qrTwo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAAC";
  let releaseFirstWait;
  let releaseSecondWait;
  const firstWait = new Promise((resolve) => { releaseFirstWait = resolve; });
  const secondWait = new Promise((resolve) => { releaseSecondWait = resolve; });
  const runner = {
    waits: 0,
    invalidQr: false,
    async prepare() {},
    async run(action) {
      if (action === "pluginList") return { code: 0, stdout: '{"plugins":["whatsapp"]}', stderr: "" };
      if (action === "whatsappLoginStart") {
        const qrDataUrl = this.invalidQr ? "data:image/svg+xml;base64,PHN2Zz4=" : qrOne;
        return { code: 0, stdout: JSON.stringify({ qrDataUrl }), stderr: "" };
      }
      if (action === "whatsappLoginWait") {
        this.waits += 1;
        if (this.waits === 1) {
          await firstWait;
          return { code: 0, stdout: JSON.stringify({ connected: false, qrDataUrl: qrTwo }), stderr: "" };
        }
        await secondWait;
        return { code: 0, stdout: JSON.stringify({ connected: true }), stderr: "" };
      }
      return { code: 0, stdout: "ok", stderr: "" };
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
      memoryBytes: 8 * 1024 ** 3,
      freeDiskBytes: 20 * 1024 ** 3,
      checks: [],
      compatible: true,
    },
    config: { stateDir: directory, home: directory, host: "127.0.0.1" },
    runner,
    store,
    persist: false,
  });
  await service.listen(0, "127.0.0.1");
  t.after(async () => {
    releaseFirstWait?.();
    releaseSecondWait?.();
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const { port } = service.server.address();
  const base = `http://127.0.0.1:${port}`;

  const loginResponse = await post(`${base}/api/v1/channels/whatsapp/login`);
  assert.equal(loginResponse.status, 202);
  const firstQr = await waitForWhatsApp(base, (whatsapp) => whatsapp.qrDataUrl === qrOne);
  assert.equal(firstQr.status, "linking");
  assert.match(firstQr.qrDataUrl, /^data:image\/png;base64,/);

  releaseFirstWait();
  const rotatedQr = await waitForWhatsApp(base, (whatsapp) => whatsapp.qrDataUrl === qrTwo);
  assert.equal(rotatedQr.status, "linking");
  assert.notEqual(rotatedQr.qrDataUrl, firstQr.qrDataUrl);

  releaseSecondWait();
  const connected = await waitForWhatsApp(base, (whatsapp) => whatsapp.status === "connected");
  assert.equal(connected.qrDataUrl, null);
  assert.equal(connected.error, null);

  runner.invalidQr = true;
  const invalidResponse = await post(`${base}/api/v1/channels/whatsapp/login`);
  assert.equal(invalidResponse.status, 202);
  const failed = await waitForWhatsApp(base, (whatsapp) => whatsapp.status === "failed");
  assert.equal(failed.qrDataUrl, null);
  assert.match(failed.error, /invalid WhatsApp QR image/);
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
    permissionProfile: "open",
    riskAccepted: false,
  });
  assert.equal(response.status, 422);
  const status = await (await fetch(`http://127.0.0.1:${port}/api/v1/status`)).json();
  assert.equal(status.activeJobId, null);

  await service.store.update((state) => {
    state.installation.permissionProfile = "open";
    state.installation.completedSteps = ["preflight", "system", "ollama", "model", "openclaw", "onboard"];
    state.installation.securityBaseline = 9;
    state.installation.fullAccessConsentVersion = 0;
  });
  const upgradeWithoutNewConsent = await post(`http://127.0.0.1:${port}/api/v1/install`, {
    permissionProfile: "open",
    riskAccepted: false,
  });
  assert.equal(upgradeWithoutNewConsent.status, 422);
  assert.equal(service.store.snapshot().activeJobId, null);
});
