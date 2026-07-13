import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { CommandCancelledError, CommandRunner, DemoCommandRunner } from "./command-runner.mjs";
import {
  DEFAULT_MODEL_ID,
  GATEWAY_PORT,
  makeConfig,
  MODEL_CATALOG,
  OLLAMA_BASE_URL,
  OPENCLAW_VERSION,
  QR_DATA_URL_MAX_LENGTH,
  SERVICE_VERSION,
  modelSpec,
} from "./config.mjs";
import { inspectHost, runtimeMode } from "./preflight.mjs";
import { createSanitizer, makeSecret, publicState } from "./security.mjs";
import { appendJobEvent, StateStore } from "./state.mjs";

function stepDefinitions(modelId = DEFAULT_MODEL_ID) {
  const model = modelSpec(modelId) ?? modelSpec(DEFAULT_MODEL_ID);
  return [
    { id: "preflight", title: "Check your Raspberry Pi" },
    { id: "system", title: "Prepare the operating system" },
    { id: "ollama", title: "Install Ollama for ARM64" },
    { id: "model", title: `Download ${model.label}` },
    { id: "openclaw", title: "Install OpenClaw" },
    { id: "onboard", title: "Configure your local agent" },
    { id: "verify", title: "Enable and test assistant tools" },
  ];
}

const TERMINAL_JOB_STATUSES = new Set(["complete", "failed", "cancelled", "interrupted"]);
const CURRENT_SECURITY_BASELINE = 10;
const PERMISSION_PROFILES = new Set(["open"]);
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function json(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  response.end(payload);
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16 * 1024) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error();
    return value;
  } catch {
    const error = new Error("Request body must be a JSON object.");
    error.statusCode = 400;
    throw error;
  }
}

function assertSafeMutation(request) {
  const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    const error = new Error("Mutation requests must use application/json.");
    error.statusCode = 415;
    throw error;
  }
  const fetchSite = String(request.headers["sec-fetch-site"] ?? "").toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    const error = new Error("Cross-site setup requests are not allowed.");
    error.statusCode = 403;
    throw error;
  }
  const origin = request.headers.origin;
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (!originHost || originHost !== request.headers.host) {
      const error = new Error("Request origin does not match the setup service.");
      error.statusCode = 403;
      throw error;
    }
  }
}

function assertAllowedHost(request, configuredHost) {
  if (!["127.0.0.1", "localhost", "::1"].includes(configuredHost)) return;
  const host = String(request.headers.host ?? "").toLowerCase();
  const hostname = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : host.split(":", 1)[0];
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    const error = new Error("The setup service only accepts loopback hostnames.");
    error.statusCode = 403;
    throw error;
  }
}

function jobSummary(job) {
  if (!job) return null;
  const summary = structuredClone(job);
  delete summary.events;
  delete summary.nextEventId;
  return summary;
}

function statusPayload(state) {
  const safe = publicState(state);
  return {
    serviceVersion: SERVICE_VERSION,
    mode: safe.mode,
    demo: safe.mode === "demo",
    phase: safe.phase,
    activeJobId: safe.activeJobId,
    installation: safe.installation,
    channels: safe.channels,
    activeJob: safe.activeJobId ? jobSummary(safe.jobs[safe.activeJobId]) : null,
    lastJob: safe.installation.lastJobId ? jobSummary(safe.jobs[safe.installation.lastJobId]) : null,
    updatedAt: safe.updatedAt,
  };
}

async function fetchJson(url, options = {}, timeoutMs = 10_000) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(url, { ...options, signal });
  const body = await response.text();
  if (!response.ok) {
    const safeUrl = String(url).replace(/\/bot[^/]+\//, "/bot[REDACTED]/");
    const detail = createSanitizer()(body).trim().slice(0, 800);
    throw new Error(`${safeUrl} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}.`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${url} returned an unreadable JSON response.`);
  }
}

function modelIsPresent(tags, modelId) {
  return Boolean(
    tags?.models?.some((model) => {
      const name = model?.name ?? model?.model;
      return name === modelId || name === `${modelId}:latest`;
    }),
  );
}

function openClawVersionIsSupported(output) {
  const installed = String(output ?? "").match(/\b(\d{4})\.(\d+)\.(\d+)\b/);
  const required = OPENCLAW_VERSION.match(/^(\d{4})\.(\d+)\.(\d+)$/);
  if (!installed || !required) return false;
  for (let index = 1; index <= 3; index += 1) {
    const actualPart = Number(installed[index]);
    const requiredPart = Number(required[index]);
    if (actualPart > requiredPart) return true;
    if (actualPart < requiredPart) return false;
  }
  return true;
}

function sseWrite(response, event) {
  response.write(`id: ${event.id}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function friendlyError(error) {
  if (error instanceof CommandCancelledError || error?.code === "SETUP_CANCELLED") {
    return "Setup was cancelled.";
  }
  const sanitize = createSanitizer();
  if (error?.action === "installOllamaArm64") {
    if (error?.exitCode === 74) {
      return "The Ollama runtime download was corrupted and removed. Check the connection, then press Retry to download a clean copy.";
    }
    if ([75, 130].includes(error?.exitCode)) {
      return "The Ollama runtime download was interrupted. Its completed bytes were saved; check the connection and press Retry to continue instead of starting over.";
    }
  }
  return sanitize(error?.message ?? "Setup failed unexpectedly.").slice(0, 2_000);
}

export function diagnoseSetupFailure(error, step = null) {
  const technical = friendlyError(error);
  const lower = technical.toLowerCase();
  const stepTitle = String(step?.title ?? step?.id ?? "Setup");
  const diagnosis = {
    code: "SETUP_COMMAND_FAILED",
    step: stepTitle,
    problem: "A required setup command did not finish.",
    reason: technical,
    nextAction: "Check the details below, then press Retry. Completed work is preserved.",
    retryable: true,
  };

  if (/127\.0\.0\.1:11434|localhost:11434/.test(lower)) {
    if (/llama-server binary not found|missing.*llama-server/.test(lower)) {
      return {
        ...diagnosis,
        code: "OLLAMA_RUNTIME_INCOMPLETE",
        problem: "Ollama cannot access its required inference-server executable.",
        reason: `${technical} This is caused by the installed runtime path or its permissions, not insufficient Raspberry Pi memory.`,
        nextAction: "Install the latest ClawBoot update and press Retry. It repairs the existing Ollama files in place without redownloading the local model.",
      };
    }
    return {
      ...diagnosis,
      code: "LOCAL_MODEL_ERROR",
      problem: "The local Ollama model engine could not generate a test response.",
      reason: `${technical} This address belongs to Ollama on this Raspberry Pi, not a remote website.`,
      nextAction: "Close memory-heavy applications and press Retry. If it repeats, restart the Pi once and try again; the model is already downloaded.",
    };
  }
  if (/http\s+5\d\d|returned\s+5\d\d|status(?: code)?\s*5\d\d/.test(lower)) {
    return {
      ...diagnosis,
      code: "REMOTE_SERVER_ERROR",
      problem: "A remote download or package server returned an HTTP 5xx error.",
      reason: `${technical} This is a server-side response, not damage to the Raspberry Pi or the saved local model.`,
      nextAction: "Wait a few minutes and press Retry. ClawBoot will reuse completed work and saved downloads.",
    };
  }
  if (/enospc|no space left|disk.+full/.test(lower)) {
    return {
      ...diagnosis,
      code: "DISK_FULL",
      problem: "The Raspberry Pi ran out of free storage.",
      nextAction: "Free some disk space, reopen ClawBoot, and press Retry.",
    };
  }
  if (/eai_again|enotfound|could not resolve|connection reset|network is unreachable|timed? out/.test(lower)) {
    return {
      ...diagnosis,
      code: "NETWORK_ERROR",
      problem: "The network connection or remote server became unavailable.",
      nextAction: "Check the Pi's internet connection, then press Retry. Saved downloads will resume.",
    };
  }
  if (/sudo:.*password is required|a password is required/.test(lower)) {
    return {
      ...diagnosis,
      code: "PRIVILEGE_RULE_MISSING",
      problem: "ClawBoot's fixed system-helper permission is missing or outdated.",
      reason: `${technical} ClawBoot does not need or store your desktop password.`,
      nextAction: "Install the latest ClawBoot package over this version, reopen it, and press Retry.",
    };
  }
  if (/eacces|permission denied|operation not permitted/.test(lower)) {
    return {
      ...diagnosis,
      code: "PERMISSION_ERROR",
      problem: "A required file or service could not be changed because access was denied.",
      nextAction: "Reinstall the latest ClawBoot package, reopen it, and press Retry.",
    };
  }
  if (error?.code === "COMMAND_TIMEOUT") {
    return {
      ...diagnosis,
      code: "COMMAND_TIMEOUT",
      problem: "A setup operation took too long and was stopped.",
      nextAction: "Check the network connection and press Retry. Completed work is preserved.",
    };
  }
  return diagnosis;
}

function diagnosisText(diagnosis) {
  return [
    "FAILURE DIAGNOSIS",
    `Step: ${diagnosis.step}`,
    `Problem: ${diagnosis.problem}`,
    `Reason: ${diagnosis.reason}`,
    `What to do: ${diagnosis.nextAction}`,
    `Code: ${diagnosis.code}`,
  ].join("\n");
}

export function parseDownloadProgress(line) {
  const match = /^CLAWBOOT_DOWNLOAD\s+(ollama)\s+(\d+)\s+(\d+)$/.exec(String(line).trim());
  if (!match) return null;
  const downloadedBytes = Number(match[2]);
  const totalBytes = Number(match[3]);
  if (!Number.isSafeInteger(downloadedBytes) || !Number.isSafeInteger(totalBytes) || totalBytes <= 0) return null;
  return {
    kind: match[1],
    label: "Ollama runtime",
    downloadedBytes: Math.max(0, Math.min(downloadedBytes, totalBytes)),
    totalBytes,
    percent: Math.max(0, Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100))),
  };
}

function parseCommandJson(output) {
  const text = String(output ?? "").trim();
  for (const line of text.split(/\r?\n/).reverse()) {
    const candidate = line.trim();
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Fall through to the multi-line form below.
    }
  }
  for (const opener of ["{", "["]) {
    const start = text.indexOf(opener);
    if (start === -1) continue;
    try {
      return JSON.parse(text.slice(start));
    } catch {
      // Some OpenClaw versions print a short notice before or after JSON.
    }
  }
  return null;
}

export function assessSecurityAudit(report) {
  const critical = Number(report?.summary?.critical);
  const warnings = Number(report?.summary?.warn ?? report?.summary?.warning ?? 0);
  if (!Number.isFinite(critical) || critical < 0) {
    throw new Error("OpenClaw returned an unreadable security audit result.");
  }
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  const criticalFindings = findings.filter((finding) => String(finding?.severity ?? "").toLowerCase() === "critical");
  const acceptedSmallModel = criticalFindings.filter((finding) => finding?.checkId === "models.small_params");
  const blocking = criticalFindings.filter((finding) => finding?.checkId !== "models.small_params");
  if (critical > 0 && (blocking.length > 0 || acceptedSmallModel.length !== critical)) {
    const ids = blocking.map((finding) => String(finding?.checkId ?? "unknown")).join(", ");
    throw new Error(`OpenClaw security audit still reports ${critical} critical finding${critical === 1 ? "" : "s"}${ids ? ` (${ids})` : ""}.`);
  }
  return {
    critical,
    warnings: Number.isFinite(warnings) && warnings > 0 ? warnings : 0,
    acceptedSmallModelCritical: acceptedSmallModel.length,
  };
}

function whatsappPluginIsReady(output) {
  const report = parseCommandJson(output);
  const plugins = Array.isArray(report) ? report : Array.isArray(report?.plugins) ? report.plugins : [];
  const plugin = plugins.find((entry) => {
    const id = String(entry?.id ?? entry?.name ?? entry?.packageName ?? "").toLowerCase();
    return id === "whatsapp" || id === "@openclaw/whatsapp";
  });
  if (!plugin) return false;
  const status = String(plugin.status ?? plugin.state ?? "").toLowerCase();
  return plugin.version === OPENCLAW_VERSION && plugin.enabled !== false && status !== "error" && status !== "failed";
}

function validatedQrDataUrl(value) {
  if (
    typeof value !== "string" ||
    value.length > QR_DATA_URL_MAX_LENGTH ||
    !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error("OpenClaw returned an invalid WhatsApp QR image. Restart linking and try again.");
  }
  return value;
}

function toolList(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string" && /^[A-Za-z0-9_*:./-]{1,80}$/.test(entry))
    : [];
}

function uniqueTools(values) {
  return [...new Set(values)];
}

function normalizePairingRequests(value) {
  const source = Array.isArray(value)
    ? value
    : Array.isArray(value?.requests)
      ? value.requests
      : Array.isArray(value?.pending)
        ? value.pending
        : [];
  return source.slice(0, 20).map((entry) => ({
    code: String(entry?.code ?? entry?.pairingCode ?? "").slice(0, 32),
    name: String(entry?.displayName ?? entry?.name ?? entry?.senderName ?? "New contact").slice(0, 120),
    sender: String(entry?.sender ?? entry?.senderId ?? entry?.from ?? entry?.id ?? "Unknown account").slice(0, 160),
    expiresAt: entry?.expiresAt ?? entry?.expires ?? null,
  })).filter((entry) => entry.code);
}

export async function createSetupService(options = {}) {
  const config = makeConfig(options.config ?? options);
  const hostInfo =
    options.hostInfo ??
    (await inspectHost({ stateDir: config.stateDir, skipNetwork: config.forceDemo === true }));
  const mode = options.mode ?? runtimeMode(hostInfo, config.forceDemo);
  const store =
    options.store ??
    new StateStore({
      file: config.stateFile,
      mode,
      persist: options.persist ?? mode === "pi",
    });
  await store.init();
  await store.update((state) => {
    if (["installing", "linking"].includes(state.channels?.whatsapp?.status)) {
      state.channels.whatsapp.status = "failed";
      state.channels.whatsapp.error = "WhatsApp linking was interrupted. Start it again to show a new QR code.";
      state.channels.whatsapp.qrDataUrl = null;
    }
    if (state.channels?.telegram?.status === "configuring") {
      state.channels.telegram.status = "failed";
      state.channels.telegram.error = "Telegram setup was interrupted. Paste the bot token again.";
    }
  });

  const runner =
    options.runner ??
    (mode === "demo" ? new DemoCommandRunner({ config }) : new CommandRunner({ config }));
  await runner.prepare();

  const subscribers = new Map();
  const controllers = new Map();
  const channelControllers = new Map();
  let preflightCache = { value: hostInfo, at: Date.now() };

  function subscribe(jobId, callback) {
    const listeners = subscribers.get(jobId) ?? new Set();
    listeners.add(callback);
    subscribers.set(jobId, listeners);
    return () => {
      listeners.delete(callback);
      if (!listeners.size) subscribers.delete(jobId);
    };
  }

  async function emit(jobId, event) {
    let entry;
    await store.update((state) => {
      const job = state.jobs[jobId];
      if (!job) return;
      entry = appendJobEvent(job, event);
    });
    if (!entry) return null;
    for (const listener of subscribers.get(jobId) ?? []) listener(entry);
    return entry;
  }

  async function cachedPreflight(force = false) {
    if (!force && Date.now() - preflightCache.at < 30_000) return preflightCache.value;
    preflightCache = {
      value: await inspectHost({ stateDir: config.stateDir, skipNetwork: mode === "demo" }),
      at: Date.now(),
    };
    return preflightCache.value;
  }

  async function runAction(jobId, action, context = {}) {
    let lines = Promise.resolve();
    let lastProgressLogAt = 0;
    let pendingProgressLine = null;
    let lastDownloadKey = null;
    const result = await runner.run(action, {
      ...context,
      onLine({ source, line }) {
        const download = parseDownloadProgress(line);
        if (download) {
          const key = `${download.kind}:${download.percent}`;
          if (key === lastDownloadKey) return;
          lastDownloadKey = key;
          lines = lines.then(() =>
            emit(jobId, {
              type: "download",
              stepId: "ollama",
              resumable: true,
              ...download,
            }),
          );
          return;
        }
        if (action === "pullModel") {
          const selected = modelSpec(context.model ?? store.snapshot().installation.model) ?? modelSpec(DEFAULT_MODEL_ID);
          const percentage = /(?:^|\s)(\d{1,3}(?:\.\d+)?)%/.exec(line);
          if (percentage) {
            const percent = Math.max(0, Math.min(100, Math.floor(Number(percentage[1]))));
            const key = `model:${percent}`;
            if (key !== lastDownloadKey) {
              lastDownloadKey = key;
              lines = lines.then(() =>
                emit(jobId, {
                  type: "download",
                  stepId: "model",
                  kind: "model",
                  label: `${selected.label} model`,
                  percent,
                  resumable: true,
                }),
              );
            }
          }
          const now = Date.now();
          if (now - lastProgressLogAt < 250) {
            pendingProgressLine = { source, line };
            return;
          }
          lastProgressLogAt = now;
          pendingProgressLine = null;
        }
        lines = lines.then(() =>
          emit(jobId, {
            type: "log",
            source,
            message: line,
          }),
        );
      },
    });
    if (pendingProgressLine) {
      lines = lines.then(() =>
        emit(jobId, {
          type: "log",
          source: pendingProgressLine.source,
          message: pendingProgressLine.line,
        }),
      );
    }
    await lines;
    return result;
  }

  async function verifyModel({ signal, exercise = true, modelId = store.snapshot().installation.model } = {}) {
    const selected = modelSpec(modelId);
    if (!selected) throw new Error("The selected local model is not supported by ClawBoot.");
    if (mode === "demo") {
      return {
        ok: true,
        model: selected.id,
        provider: "ollama",
        baseUrl: OLLAMA_BASE_URL,
        latencyMs: 640,
        tokensPerSecond: 5.4,
        firstTokenSeconds: 1.8,
        response: exercise ? "READY" : null,
        demo: true,
      };
    }

    const started = Date.now();
    const tags = await fetchJson(`${OLLAMA_BASE_URL}/api/tags`, { signal }, 8_000);
    if (!modelIsPresent(tags, selected.id)) {
      return {
        ok: false,
        model: selected.id,
        provider: "ollama",
        baseUrl: OLLAMA_BASE_URL,
        reason: `${selected.id} is not present in Ollama.`,
      };
    }
    if (!exercise) {
      return {
        ok: true,
        model: selected.id,
        provider: "ollama",
        baseUrl: OLLAMA_BASE_URL,
        latencyMs: Date.now() - started,
      };
    }

    const generated = await fetchJson(
      `${OLLAMA_BASE_URL}/api/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: selected.id,
          prompt: "Reply with exactly READY.",
          think: false,
          stream: false,
          keep_alive: selected.params.keep_alive,
          options: { num_ctx: 2048, num_predict: 32, temperature: 0 },
        }),
        signal,
      },
      5 * 60_000,
    );
    const evalCount = Number(generated?.eval_count ?? 0);
    const evalDuration = Number(generated?.eval_duration ?? 0);
    const totalDuration = Number(generated?.total_duration ?? 0);
    const tokensPerSecond =
      evalCount > 0 && evalDuration > 0
        ? Math.round((evalCount / (evalDuration / 1_000_000_000)) * 100) / 100
        : null;
    const firstTokenSeconds =
      totalDuration > 0 && evalDuration > 0
        ? Math.round((Math.max(0, totalDuration - evalDuration) / 1_000_000_000) * 1000) / 1000
        : null;
    const visibleResponse = String(generated?.response ?? "").trim();
    const thinkingResponse = String(generated?.thinking ?? "").trim();
    const answered = Boolean(visibleResponse || thinkingResponse);
    return {
      ok: answered,
      model: selected.id,
      provider: "ollama",
      baseUrl: OLLAMA_BASE_URL,
      latencyMs: Date.now() - started,
      tokensPerSecond,
      firstTokenSeconds,
      response: visibleResponse.slice(0, 120),
      thinkingOnly: !visibleResponse && Boolean(thinkingResponse),
      ...(!answered ? { reason: `Ollama completed the Qwen health request but returned no visible or thinking output (done reason: ${generated?.done_reason ?? "unknown"}).` } : {}),
    };
  }

  async function verifyAgent({ signal, jobId = null } = {}) {
    if (mode === "demo") {
      return {
        ok: true,
        gateway: `http://127.0.0.1:${GATEWAY_PORT}`,
        bind: "loopback",
        authenticated: true,
        demo: true,
      };
    }
    const gatewayToken = store.snapshot().secrets.gatewayToken;
    const context =
      typeof gatewayToken === "string" && gatewayToken.length >= 24
        ? { signal, gatewayToken, secrets: [gatewayToken] }
        : { signal };
    const result = jobId
      ? await runAction(jobId, "openclawGatewayProbe", context)
      : await runner.run("openclawGatewayProbe", context);
    const probe = parseCommandJson(result.stdout);
    return {
      ok: result.code === 0 && probe?.ok === true,
      gateway: `http://127.0.0.1:${GATEWAY_PORT}`,
      bind: "loopback",
      authenticated: true,
      degraded: probe?.degraded === true,
      capability: typeof probe?.capability === "string" ? probe.capability : null,
    };
  }

  async function reconcileInstalledState(signal, modelId = store.snapshot().installation.model) {
    if (mode === "demo") return;
    const selected = modelSpec(modelId);
    if (!selected) throw new Error("The selected local model is not supported by ClawBoot.");
    let ollamaInstalled = false;
    let modelInstalled = false;
    let openclawInstalled = false;
    let gatewayRunning = false;

    try {
      ollamaInstalled = (await runner.run("ollamaVersion", { signal })).code === 0;
    } catch {}
    if (ollamaInstalled) {
      try {
        ollamaInstalled = (await runner.run("ollamaRuntimeStatus", { signal })).code === 0;
      } catch {
        ollamaInstalled = false;
      }
    }
    if (ollamaInstalled) {
      try {
        modelInstalled = (await verifyModel({ signal, exercise: false, modelId: selected.id })).ok;
      } catch {}
    }
    try {
      const version = await runner.run("openclawVersion", { signal });
      openclawInstalled = version.code === 0 && openClawVersionIsSupported(version.stdout);
    } catch {}
    if (openclawInstalled) {
      try {
        gatewayRunning = (await verifyAgent({ signal })).ok;
      } catch {}
    }

    await store.update((state) => {
      state.installation.ollamaInstalled = ollamaInstalled;
      state.installation.modelInstalled = modelInstalled;
      state.installation.openclawInstalled = openclawInstalled;
      state.installation.gatewayRunning = gatewayRunning;
      if (gatewayRunning) state.installation.agentConfigured = true;
      const invalidated = new Set();
      if (!ollamaInstalled) {
        invalidated.add("ollama");
        invalidated.add("model");
        invalidated.add("verify");
      } else if (!modelInstalled) {
        invalidated.add("model");
        invalidated.add("verify");
      }
      if (!openclawInstalled) {
        invalidated.add("openclaw");
        invalidated.add("onboard");
        invalidated.add("verify");
        state.installation.agentConfigured = false;
      } else if (!gatewayRunning) {
        invalidated.add("onboard");
        invalidated.add("verify");
        state.installation.agentConfigured = false;
      }
      if (state.installation.securityBaseline < CURRENT_SECURITY_BASELINE) {
        invalidated.add("verify");
      }
      state.installation.completedSteps = state.installation.completedSteps.filter(
        (stepId) => !invalidated.has(stepId),
      );
    });
  }

  async function markInstallation(jobId, changes) {
    await store.update((state) => {
      Object.assign(state.installation, changes);
      if (jobId) state.installation.lastJobId = jobId;
    });
  }

  function assertAgentReady() {
    const installation = store.snapshot().installation;
    if (!installation.openclawInstalled || !installation.agentConfigured || !installation.gatewayRunning) {
      const error = new Error("Finish installing and verifying OpenClaw before connecting messaging.");
      error.statusCode = 409;
      throw error;
    }
  }

  async function verifyTelegramToken(token) {
    if (!/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(token)) {
      const error = new Error("That does not look like a Telegram bot token from BotFather.");
      error.statusCode = 400;
      throw error;
    }
    if (mode === "demo") {
      return { id: 123456789, first_name: "ClawBoot Demo", username: "clawboot_demo_bot" };
    }
    let payload;
    try {
      payload = await fetchJson(`https://api.telegram.org/bot${token}/getMe`, {}, 15_000);
    } catch {
      const error = new Error("Telegram rejected the token. Copy a fresh token from BotFather and try again.");
      error.statusCode = 422;
      throw error;
    }
    if (!payload?.ok || !payload?.result?.username) {
      const error = new Error("Telegram could not identify a bot for that token.");
      error.statusCode = 422;
      throw error;
    }
    return payload.result;
  }

  async function configureTelegram(token) {
    assertAgentReady();
    await store.update((state) => {
      state.channels.telegram.status = "configuring";
      state.channels.telegram.error = null;
    });
    try {
      const bot = await verifyTelegramToken(token);
      const secretContext = { token, secrets: [token] };
      await runner.run("telegramAdd", secretContext);
      await runner.run("telegramDmPairing");
      await runner.run("telegramGroupsDisabled");
      await runner.run("gatewayRestart");
      await runner.run("channelStatus", { channel: "telegram" });
      await store.update((state) => {
        state.channels.telegram.status = "connected";
        state.channels.telegram.bot = {
          id: String(bot.id),
          name: String(bot.first_name ?? "Telegram bot").slice(0, 120),
          username: String(bot.username).slice(0, 120),
        };
        state.channels.telegram.error = null;
      });
      return publicState(store.snapshot()).channels.telegram;
    } catch (error) {
      await store.update((state) => {
        state.channels.telegram.status = "failed";
        state.channels.telegram.error = friendlyError(error);
      });
      throw error;
    }
  }

  async function runWhatsAppLogin(controller) {
    try {
      const gatewayToken = store.snapshot().secrets.gatewayToken;
      if (typeof gatewayToken !== "string" || gatewayToken.length < 24) {
        throw new Error("ClawBoot could not find the local gateway credential. Press Retry on the Install step first.");
      }
      const gatewayContext = {
        signal: controller.signal,
        gatewayToken,
        secrets: [gatewayToken],
      };
      const plugins = await runner.run("pluginList", { signal: controller.signal });
      if (!whatsappPluginIsReady(plugins.stdout)) {
        await runner.run("whatsappPluginInstall", { signal: controller.signal });
      }
      await runner.run("whatsappPluginEnable", { signal: controller.signal });
      await runner.run("whatsappDmPairing", { signal: controller.signal });
      await runner.run("whatsappGroupsDisabled", { signal: controller.signal });
      await runner.run("gatewayRestart", { signal: controller.signal });
      await runner.run("openclawGatewayProbe", gatewayContext);
      await store.update((state) => {
        state.channels.whatsapp.status = "linking";
      });

      const started = await runner.run("whatsappLoginStart", gatewayContext);
      let login = parseCommandJson(started.stdout);
      login = login?.payload ?? login?.result ?? login;
      const startMessage = String(login?.message ?? "");
      let connected =
        login?.connected === true ||
        /already linked|recovered (?:the )?existing linked session/i.test(startMessage);
      let qrDataUrl = null;
      if (!connected) {
        if (!login?.qrDataUrl) {
          throw new Error(
            startMessage ||
              "OpenClaw did not return a WhatsApp QR image. Select Show QR Code to try again.",
          );
        }
        qrDataUrl = validatedQrDataUrl(login.qrDataUrl);
      }
      if (qrDataUrl) {
        await store.update((state) => {
          state.channels.whatsapp.qrDataUrl = qrDataUrl;
        });
      }

      const deadline = Date.now() + 3 * 60_000;
      while (!connected && Date.now() < deadline) {
        const waited = await runner.run("whatsappLoginWait", {
          ...gatewayContext,
          currentQrDataUrl: qrDataUrl,
          secrets: [gatewayToken, qrDataUrl],
        });
        let status = parseCommandJson(waited.stdout);
        status = status?.payload ?? status?.result ?? status;
        connected = status?.connected === true;
        if (connected) break;
        if (status?.qrDataUrl) {
          const refreshed = validatedQrDataUrl(status.qrDataUrl);
          if (refreshed !== qrDataUrl) {
            qrDataUrl = refreshed;
            await store.update((state) => {
              state.channels.whatsapp.qrDataUrl = refreshed;
            });
          }
        }
        const message = String(status?.message ?? "");
        if (/no active|expired|failed|logged out/i.test(message)) {
          throw new Error(message || "The WhatsApp QR expired. Start linking again.");
        }
      }
      if (!connected) throw new Error("The WhatsApp QR expired before it was scanned. Select Show QR Code to try again.");

      await runner.run("channelStatus", { channel: "whatsapp", signal: controller.signal });
      await store.update((state) => {
        state.channels.whatsapp.status = "connected";
        state.channels.whatsapp.account = "default";
        state.channels.whatsapp.qrDataUrl = null;
        state.channels.whatsapp.error = null;
      });
    } catch (error) {
      await store.update((state) => {
        state.channels.whatsapp.status = controller.signal.aborted ? "not_configured" : "failed";
        state.channels.whatsapp.error = controller.signal.aborted ? null : friendlyError(error);
        state.channels.whatsapp.qrDataUrl = null;
      });
    } finally {
      channelControllers.delete("whatsapp");
    }
  }

  async function startWhatsAppLogin() {
    assertAgentReady();
    if (channelControllers.has("whatsapp")) {
      const error = new Error("WhatsApp linking is already in progress.");
      error.statusCode = 409;
      throw error;
    }
    await store.update((state) => {
      state.channels.whatsapp.status = "installing";
      state.channels.whatsapp.qrDataUrl = null;
      state.channels.whatsapp.error = null;
    });
    const controller = new AbortController();
    channelControllers.set("whatsapp", controller);
    setImmediate(() => void runWhatsAppLogin(controller));
    return publicState(store.snapshot()).channels.whatsapp;
  }

  async function pairingRequests(channel) {
    assertAgentReady();
    const result = await runner.run("pairingList", { channel });
    return normalizePairingRequests(parseCommandJson(result.stdout));
  }

  async function approvePairing(channel, code) {
    assertAgentReady();
    await runner.run("pairingApprove", { channel, code });
    return { ok: true, channel, code };
  }

  async function readPolicyList(jobId, action, signal, modelId) {
    try {
      const result = await runAction(jobId, action, { signal, model: modelId });
      const parsed = parseCommandJson(result.stdout);
      return { present: true, values: toolList(parsed) };
    } catch {
      return { present: false, values: [] };
    }
  }

  async function configureToolLists(jobId, signal, permissionProfile, modelId) {
    const [allow, alsoAllow] = await Promise.all([
      readPolicyList(jobId, "readToolsAllow", signal, modelId),
      readPolicyList(jobId, "readToolsAlsoAllow", signal, modelId),
    ]);

    const required = permissionProfile === "chat"
      ? ["group:messaging", "group:web"]
      : ["group:fs", "group:runtime", "group:web", "group:sessions", "group:memory", "cron", "browser", "message"];
    if (allow.present) {
      if (alsoAllow.present) {
        await runAction(jobId, "unsetToolsAlsoAllow", { signal, model: modelId });
      }
      await runAction(jobId, "setToolsAllow", {
        signal,
        model: modelId,
        tools: uniqueTools([...allow.values, ...required]),
      });
    } else {
      await runAction(jobId, "setToolsAlsoAllow", {
        signal,
        model: modelId,
        tools: uniqueTools([...alsoAllow.values, ...required]),
      });
    }

    // Full Pi is the only v1.2 mode. Legacy deny entries must not silently
    // leave browsing, sessions, memory, cron, or computer control disabled.
    await runAction(jobId, "setToolsDeny", {
      signal,
      model: modelId,
      tools: [],
    });
  }

  async function configurePluginLists(jobId, signal, permissionProfile, modelId) {
    const [allow, deny] = await Promise.all([
      readPolicyList(jobId, "readPluginsAllow", signal, modelId),
      readPolicyList(jobId, "readPluginsDeny", signal, modelId),
    ]);

    const required = permissionProfile === "chat" ? ["duckduckgo"] : ["duckduckgo", "browser"];
    if (allow.present) {
      await runAction(jobId, "setPluginsAllow", {
        signal,
        model: modelId,
        tools: uniqueTools([...allow.values, ...required]),
      });
    }
    if (deny.present) {
      await runAction(jobId, "setPluginsDeny", {
        signal,
        model: modelId,
        tools: deny.values.filter((pluginId) => !required.includes(pluginId)),
      });
    }
  }

  async function writeAgentGuide() {
    if (mode === "demo") return;
    const workspace = path.join(config.home, ".openclaw", "workspace");
    const guidePath = path.join(workspace, "TOOLS.md");
    const startMarker = "<!-- CLAWBOOT MANAGED START -->";
    const endMarker = "<!-- CLAWBOOT MANAGED END -->";
    let existing = "";
    try {
      existing = await fs.readFile(guidePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const withoutManaged = existing
      .replace(new RegExp(`${startMarker}[\\s\\S]*?${endMarker}\\s*`, "g"), "")
      .trimEnd();
    const access = "You may use host shell commands without approval, read or change files across the Pi, and use `sudo -n` for system administration. Confirm before destructive or irreversible work unless the owner explicitly asked for it.";
    const managed = [
      startMarker,
      "## ClawBoot capabilities",
      "",
      "Use `web_search` for current news and sources, `web_fetch` to read pages, and the managed `browser` for interactive sites when it is available.",
      "For news summaries, search current sources, include publication dates and links, and clearly separate reported facts from your own summary. Use scheduled tasks only after the owner confirms the timing and destination.",
      "For IGCSE practice, you may research syllabus topics and sites such as Examable, then create original exam-style questions and mark schemes. Do not claim copied questions are original, bypass logins, or reproduce paywalled papers verbatim.",
      access,
      endMarker,
      "",
    ].join("\n");
    await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
    await fs.writeFile(guidePath, `${withoutManaged ? `${withoutManaged}\n\n` : ""}${managed}`, { mode: 0o600 });
  }

  async function configureAssistantPolicy(jobId, signal, permissionProfile, modelId) {
    await configurePluginLists(jobId, signal, permissionProfile, modelId);
    await runAction(jobId, "enableDuckDuckGo", { signal, model: modelId });
    await runAction(jobId, "configureWebSearch", { signal, model: modelId });
    await runAction(jobId, "configureWebFetch", { signal, model: modelId });
    await runAction(jobId, "permissionSandboxOff", { signal, model: modelId });

    await runAction(jobId, "permissionOpen", { signal, model: modelId });
    await runAction(jobId, "permissionFilesystemFull", { signal, model: modelId });
    await runAction(jobId, "permissionApplyPatchFull", { signal, model: modelId });
    await runAction(jobId, "permissionExecYolo", { signal, model: modelId });
    await runAction(jobId, "ensureChromium", { signal, model: modelId });
    await runAction(jobId, "enableBrowserPlugin", { signal, model: modelId });
    await runAction(jobId, "configureBrowser", { signal, model: modelId });
    await runAction(jobId, "verifyAgentRoot", { signal, model: modelId });
    await configureToolLists(jobId, signal, permissionProfile, modelId);
    await runAction(jobId, "disableElevatedTools", { signal, model: modelId });
    await writeAgentGuide();
  }

  const stepRunners = {
    async preflight({ jobId }) {
      const current = await cachedPreflight(true);
      if (mode === "pi" && !current.compatible) {
        const failures = current.checks
          .filter((item) => item.status === "fail")
          .map((item) => item.detail)
          .join(" ");
        throw new Error(failures || "This Raspberry Pi did not pass preflight checks.");
      }
      await emit(jobId, {
        type: "log",
        source: "setup",
        message:
          mode === "demo"
            ? "Demo mode is active because this machine is not a Raspberry Pi 5. No system changes will be made."
            : "Raspberry Pi 5 preflight checks passed.",
      });
    },
    async system({ jobId, signal }) {
      await runAction(jobId, "prepareSystem", { signal });
    },
    async ollama({ jobId, signal }) {
      const { installation } = store.snapshot();
      if (!installation.ollamaInstalled) {
        await runAction(jobId, "installOllamaArm64", { signal });
      } else {
        await emit(jobId, {
          type: "log",
          source: "setup",
          message: "Ollama is already installed; keeping the existing installation.",
        });
      }
      await runAction(jobId, "ensureOllamaRuntime", { signal });
      await runAction(jobId, "configureOllamaLoopback", { signal });
      await markInstallation(jobId, { ollamaInstalled: true });
    },
    async model({ jobId, signal }) {
      const modelId = store.snapshot().jobs[jobId].model;
      const selected = modelSpec(modelId);
      if (!store.snapshot().installation.modelInstalled) {
        await runAction(jobId, "pullModel", { signal, model: modelId });
      } else {
        await emit(jobId, {
          type: "log",
          source: "setup",
          message: `${selected.label} is already downloaded; skipping the pull.`,
        });
      }
      await markInstallation(jobId, { modelInstalled: true });
    },
    async openclaw({ jobId, signal }) {
      if (!store.snapshot().installation.openclawInstalled) {
        await runAction(jobId, "installOpenClaw", { signal });
      } else {
        await emit(jobId, {
          type: "log",
          source: "setup",
          message: "OpenClaw is already installed; keeping the existing installation.",
        });
      }
      const installed = await runAction(jobId, "openclawVersion", { signal });
      if (!openClawVersionIsSupported(installed.stdout)) {
        throw new Error(`ClawBoot requires OpenClaw ${OPENCLAW_VERSION} or newer, but the installed version could not be verified.`);
      }
      await markInstallation(jobId, { openclawInstalled: true });
    },
    async onboard({ jobId, signal }) {
      const modelId = store.snapshot().jobs[jobId].model;
      if (!store.snapshot().installation.agentConfigured) {
        let gatewayToken;
        await store.update((state) => {
          state.secrets.gatewayToken ??= makeSecret();
          gatewayToken = state.secrets.gatewayToken;
        });
        await runAction(jobId, "onboardOpenClaw", {
          signal,
          model: modelId,
          gatewayToken,
          secrets: [gatewayToken],
        });
      } else {
        await emit(jobId, {
          type: "log",
          source: "setup",
          message: "OpenClaw onboarding is already complete; keeping the existing configuration.",
        });
      }
      await markInstallation(jobId, { agentConfigured: true });
    },
    async verify({ jobId, signal }) {
      const job = store.snapshot().jobs[jobId];
      const modelId = job.model;
      const permissionProfile = job.permissionProfile;
      const selected = modelSpec(modelId);
      const gatewayToken = store.snapshot().secrets.gatewayToken;
      const gatewayContext =
        typeof gatewayToken === "string" && gatewayToken.length >= 24
          ? { signal, model: modelId, gatewayToken, secrets: [gatewayToken] }
          : { signal, model: modelId };
      await runAction(jobId, "configurePrimaryModel", { signal, model: modelId });
      await runAction(jobId, "configureLocalModelDefaults", { signal, model: modelId });
      await runAction(jobId, "disableCloudMemorySearch", { signal, model: modelId });
      await runAction(jobId, "validateOpenClawConfig", { signal, model: modelId });
      await runAction(jobId, "gatewayRestart", { signal });
      await runAction(jobId, "openclawDoctorFix", { signal, model: modelId });
      await runAction(jobId, "openclawSecurityFix", { signal, model: modelId });
      await configureAssistantPolicy(jobId, signal, permissionProfile, modelId);
      await runAction(jobId, "validateOpenClawConfig", { signal, model: modelId });
      await runAction(jobId, "gatewayRestart", { signal, model: modelId });
      const security = await runAction(jobId, "openclawSecurityDeep", gatewayContext);
      const securityReport = parseCommandJson(security.stdout);
      const { warnings, acceptedSmallModelCritical } = assessSecurityAudit(securityReport);
      await emit(jobId, {
        type: "log",
        source: "setup",
        message: acceptedSmallModelCritical > 0
          ? `OpenClaw reported its expected small-local-model tool risk as critical; the owner explicitly accepted this Full Pi risk${warnings > 0 ? `, and ${warnings} additional non-blocking warning${warnings === 1 ? " remains" : "s remain"}` : ""}.`
          : `OpenClaw security audit passed with no critical findings${warnings > 0 ? `; ${warnings} non-blocking warning${warnings === 1 ? " remains" : "s remain"}` : ""}.`,
      });
      await runAction(jobId, "ensureOllamaRuntime", { signal });
      await runAction(jobId, "configureOllamaLoopback", { signal });
      let model;
      try {
        model = await verifyModel({ signal, exercise: true, modelId });
      } catch (error) {
        if (!/127\.0\.0\.1:11434|localhost:11434/.test(String(error?.message ?? ""))) throw error;
        await emit(jobId, {
          type: "log",
          source: "setup",
          message: "The local model test failed once. Restarting Ollama and trying one more time.",
        });
        await runAction(jobId, "restartOllama", { signal, model: modelId });
        model = await verifyModel({ signal, exercise: true, modelId });
      }
      if (!model.ok) throw new Error(model.reason ?? "The local model did not complete its inference health check.");
      await emit(jobId, {
        type: "log",
        source: "setup",
        message: `${selected.label} completed its local inference health check in ${model.latencyMs} ms.`,
      });
      const agent = await verifyAgent({ signal, jobId });
      if (!agent.ok) throw new Error("The OpenClaw gateway health check failed.");
      await markInstallation(jobId, {
        gatewayRunning: true,
        model: modelId,
        permissionProfile,
        securityBaseline: CURRENT_SECURITY_BASELINE,
      });
    },
  };

  async function runInstall(jobId, controller) {
    try {
      const queuedJob = store.snapshot().jobs[jobId];
      const definitions = stepDefinitions(queuedJob.model);
      await reconcileInstalledState(controller.signal, queuedJob.model);
      await store.update((state) => {
        const job = state.jobs[jobId];
        job.status = "running";
        job.startedAt = new Date().toISOString();
      });
      await emit(jobId, {
        type: "job",
        status: "running",
        message: mode === "demo" ? "Starting a safe demo installation." : "Starting installation.",
      });

      for (let index = 0; index < definitions.length; index += 1) {
        const definition = definitions[index];
        if (controller.signal.aborted) throw new CommandCancelledError();

        const alreadyCompleted = store.snapshot().installation.completedSteps.includes(definition.id);
        if (alreadyCompleted) {
          await store.update((state) => {
            state.jobs[jobId].steps[index].status = "complete";
          });
          await emit(jobId, {
            type: "step",
            stepId: definition.id,
            status: "skipped",
            message: `${definition.title} was already completed.`,
          });
          continue;
        }

        await store.update((state) => {
          const job = state.jobs[jobId];
          job.currentStep = definition.id;
          job.steps[index].status = "running";
          job.steps[index].startedAt = new Date().toISOString();
        });
        await emit(jobId, {
          type: "step",
          stepId: definition.id,
          status: "running",
          message: definition.title,
        });

        await stepRunners[definition.id]({ jobId, signal: controller.signal });

        await store.update((state) => {
          const job = state.jobs[jobId];
          const step = job.steps[index];
          step.status = "complete";
          step.finishedAt = new Date().toISOString();
          if (!state.installation.completedSteps.includes(definition.id)) {
            state.installation.completedSteps.push(definition.id);
          }
          job.progress = Math.round(((index + 1) / definitions.length) * 100);
        });
        await emit(jobId, {
          type: "step",
          stepId: definition.id,
          status: "complete",
          progress: Math.round(((index + 1) / definitions.length) * 100),
          message: `${definition.title} complete.`,
        });
      }

      await store.update((state) => {
        const job = state.jobs[jobId];
        job.status = "complete";
        job.progress = 100;
        job.currentStep = null;
        job.finishedAt = new Date().toISOString();
        state.activeJobId = null;
        state.phase = "complete";
        state.installation.completedAt = job.finishedAt;
        state.installation.lastJobId = jobId;
      });
      await emit(jobId, {
        type: "job",
        status: "complete",
        progress: 100,
        message: mode === "demo" ? "Demo complete. Your Pi would now be ready." : "Your local OpenClaw agent is ready.",
      });
    } catch (error) {
      const cancelled = controller.signal.aborted || error instanceof CommandCancelledError;
      const message = cancelled ? "Setup was cancelled. You can safely resume later." : friendlyError(error);
      const currentJob = store.snapshot().jobs[jobId];
      const failedStep = currentJob?.steps?.find((step) => step.status === "running") ?? null;
      const diagnosis = cancelled ? null : diagnoseSetupFailure(error, failedStep);
      await store.update((state) => {
        const job = state.jobs[jobId];
        if (!job) return;
        job.status = cancelled ? "cancelled" : "failed";
        job.error = message;
        job.diagnosis = diagnosis;
        job.finishedAt = new Date().toISOString();
        const runningStep = job.steps.find((step) => step.status === "running");
        if (runningStep) runningStep.status = cancelled ? "cancelled" : "failed";
        state.activeJobId = null;
        state.phase = cancelled ? "ready" : "failed";
        state.installation.lastJobId = jobId;
      });
      if (diagnosis) {
        await emit(jobId, {
          type: "diagnostic",
          source: "setup",
          message: diagnosisText(diagnosis),
          diagnosis,
        });
      }
      await emit(jobId, {
        type: "job",
        status: cancelled ? "cancelled" : "failed",
        message,
      });
    } finally {
      controllers.delete(jobId);
    }
  }

  async function startInstall({ permissionProfile, model } = {}) {
    const initial = store.snapshot();
    permissionProfile ??= initial.installation.permissionProfile ?? "open";
    model ??= initial.installation.model ?? DEFAULT_MODEL_ID;
    if (!PERMISSION_PROFILES.has(permissionProfile)) {
      const error = new Error("ClawBoot v1.2 supports only the open Full Pi permission profile.");
      error.statusCode = 400;
      throw error;
    }
    if (!modelSpec(model)) {
      const error = new Error("model must be qwen3.5:2b or qwen3.5:4b.");
      error.statusCode = 400;
      throw error;
    }
    let current = initial;
    if (current.activeJobId) {
      const active = current.jobs[current.activeJobId];
      if (active && ["queued", "running", "cancelling"].includes(active.status)) {
        if (active.permissionProfile !== permissionProfile || active.model !== model) {
          const error = new Error("Another setup is already running with different choices. Wait for it to finish or cancel it first.");
          error.statusCode = 409;
          throw error;
        }
        return { job: active, reused: true, complete: false };
      }
    }

    await store.update((state) => {
      const invalidated = new Set();
      if (state.installation.model !== model) {
        state.installation.model = model;
        state.installation.modelInstalled = false;
        invalidated.add("model");
        invalidated.add("verify");
      }
      if (state.installation.permissionProfile !== permissionProfile) {
        state.installation.permissionProfile = permissionProfile;
        if (permissionProfile !== "open") state.installation.fullAccessConsentVersion = 0;
        invalidated.add("verify");
      }
      if (state.installation.securityBaseline < CURRENT_SECURITY_BASELINE) invalidated.add("verify");
      if (invalidated.size) {
        state.installation.securityBaseline = 0;
        state.installation.completedSteps = state.installation.completedSteps.filter(
          (stepId) => !invalidated.has(stepId),
        );
      }
    });

    await reconcileInstalledState(undefined, model);
    current = store.snapshot();

    const fullyInstalled =
      current.installation.model === model &&
      current.installation.permissionProfile === permissionProfile &&
      current.installation.ollamaInstalled &&
      current.installation.modelInstalled &&
      current.installation.openclawInstalled &&
      current.installation.agentConfigured &&
      current.installation.gatewayRunning &&
      current.installation.securityBaseline >= CURRENT_SECURITY_BASELINE;
    const lastJob = current.jobs[current.installation.lastJobId];
    if (fullyInstalled && lastJob?.status === "complete") {
      return { job: lastJob, reused: true, complete: true };
    }

    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    let initialEvent;
    await store.update((state) => {
      const completed = new Set(state.installation.completedSteps);
      const steps = stepDefinitions(model).map((step) => ({
        ...step,
        status: completed.has(step.id) ? "complete" : "pending",
        startedAt: null,
        finishedAt: null,
      }));
      const job = {
        id: jobId,
        model,
        permissionProfile,
        status: "queued",
        progress: Math.round((steps.filter((step) => step.status === "complete").length / steps.length) * 100),
        currentStep: null,
        steps,
        events: [],
        nextEventId: 1,
        error: null,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
      };
      initialEvent = appendJobEvent(job, {
        type: "job",
        status: "queued",
        message: "Installation queued.",
      });
      state.jobs[jobId] = job;
      state.activeJobId = jobId;
      state.phase = "installing";
      state.installation.lastJobId = jobId;
    });
    for (const listener of subscribers.get(jobId) ?? []) listener(initialEvent);

    const controller = new AbortController();
    controllers.set(jobId, controller);
    setImmediate(() => void runInstall(jobId, controller));
    return { job: store.snapshot().jobs[jobId], reused: false, complete: false };
  }

  async function cancelJob(jobId) {
    const snapshot = store.snapshot();
    const job = snapshot.jobs[jobId];
    if (!job) return null;
    if (TERMINAL_JOB_STATUSES.has(job.status)) return { job, cancelled: false };
    await store.update((state) => {
      state.jobs[jobId].status = "cancelling";
    });
    await emit(jobId, {
      type: "job",
      status: "cancelling",
      message: "Stopping after the active command exits…",
    });
    controllers.get(jobId)?.abort();
    return { job: store.snapshot().jobs[jobId], cancelled: true };
  }

  function exportLogs() {
    const state = publicState(store.snapshot());
    const sanitize = createSanitizer();
    const lines = [
      `ClawBoot logs`,
      `Service version: ${SERVICE_VERSION}`,
      `Mode: ${state.mode}`,
      `Exported: ${new Date().toISOString()}`,
      "",
    ];
    for (const job of Object.values(state.jobs).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      lines.push(`Job ${job.id} — ${job.status}`);
      for (const event of job.events ?? []) {
        const message = sanitize(event.message ?? "");
        lines.push(`${event.at} [${event.type}${event.source ? `/${event.source}` : ""}] ${message}`);
      }
      lines.push("");
    }
    return `${lines.join("\n")}\n`;
  }

  async function serveStatic(request, response, pathname) {
    if (!config.staticDir) return false;
    const root = path.resolve(config.staticDir);
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    let relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    let target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) return false;

    let contents;
    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) target = path.join(target, "index.html");
      contents = await fs.readFile(target);
    } catch {
      if (!request.headers.accept?.includes("text/html")) return false;
      target = path.join(root, "index.html");
      try {
        contents = await fs.readFile(target);
      } catch {
        return false;
      }
    }

    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(target)] ?? "application/octet-stream",
      "Content-Length": contents.length,
      "Cache-Control": path.basename(target) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
    });
    response.end(contents);
    return true;
  }

  async function handler(request, response) {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const { pathname } = url;
      if (pathname.startsWith("/api/")) assertAllowedHost(request, config.host);

      if (request.method === "GET" && pathname === "/api/v1/preflight") {
        const host = await cachedPreflight(url.searchParams.get("refresh") === "1");
        const checks =
          mode === "demo"
            ? host.checks.map((item) =>
                item.status === "fail"
                  ? {
                      ...item,
                      status: "warn",
                      detail: `${item.detail} Demo mode is safe and will not change this computer.`,
                    }
                  : item,
              )
            : host.checks;
        json(response, 200, {
          serviceVersion: SERVICE_VERSION,
          mode,
          demo: mode === "demo",
          canInstall: mode === "demo" || host.compatible,
          model: store.snapshot().installation.model,
          models: Object.values(MODEL_CATALOG),
          recommendation: "Qwen 3.5 2B is fastest on an 8 GB Pi. Qwen 3.5 4B is smarter but slower, especially while Chromium is open.",
          device: {
            platform: host.platform,
            architecture: host.architecture,
            model: host.deviceModel,
            os: host.os?.PRETTY_NAME ?? null,
            memoryBytes: host.memoryBytes,
            freeDiskBytes: host.freeDiskBytes,
          },
          checks,
        });
        return;
      }

      if (request.method === "GET" && pathname === "/api/v1/status") {
        json(response, 200, statusPayload(store.snapshot()));
        return;
      }

      if (request.method === "GET" && pathname === "/api/v1/channels") {
        json(response, 200, { channels: publicState(store.snapshot()).channels });
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/channels/telegram") {
        assertSafeMutation(request);
        const body = await readJson(request);
        const token = String(body.token ?? "").trim();
        const telegram = await configureTelegram(token);
        json(response, 200, { channel: "telegram", ...telegram });
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/channels/whatsapp/login") {
        assertSafeMutation(request);
        await readJson(request);
        const whatsapp = await startWhatsAppLogin();
        json(response, 202, { channel: "whatsapp", ...whatsapp });
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/channels/whatsapp/cancel") {
        assertSafeMutation(request);
        await readJson(request);
        channelControllers.get("whatsapp")?.abort();
        json(response, 200, { cancelled: channelControllers.has("whatsapp") });
        return;
      }

      if (request.method === "GET" && pathname === "/api/v1/channels/pairings") {
        const channel = url.searchParams.get("channel");
        if (!["telegram", "whatsapp"].includes(channel)) {
          json(response, 400, { error: "channel must be telegram or whatsapp." });
          return;
        }
        const requests = await pairingRequests(channel);
        json(response, 200, { channel, requests });
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/channels/pairings/approve") {
        assertSafeMutation(request);
        const body = await readJson(request);
        const channel = String(body.channel ?? "");
        const code = String(body.code ?? "").trim();
        if (!["telegram", "whatsapp"].includes(channel)) {
          json(response, 400, { error: "channel must be telegram or whatsapp." });
          return;
        }
        if (!/^[A-Za-z0-9-]{4,32}$/.test(code)) {
          json(response, 400, { error: "A valid pairing code is required." });
          return;
        }
        json(response, 200, await approvePairing(channel, code));
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/install") {
        assertSafeMutation(request);
        const body = await readJson(request);
        const snapshot = store.snapshot();
        const installation = snapshot.installation;
        const previousJob = snapshot.jobs[installation.lastJobId];
        const currentProfile = installation.permissionProfile ?? "open";
        const permissionProfile = body.permissionProfile ?? currentProfile;
        const selectedModel = body.model ?? installation.model ?? DEFAULT_MODEL_ID;
        if (!PERMISSION_PROFILES.has(permissionProfile)) {
          const error = new Error("ClawBoot v1.2 supports only the open Full Pi permission profile.");
          error.statusCode = 400;
          throw error;
        }
        if (!modelSpec(selectedModel)) {
          const error = new Error("model must be qwen3.5:2b or qwen3.5:4b.");
          error.statusCode = 400;
          throw error;
        }
        const continuingExistingSetup =
          installation.completedSteps.length > 0 ||
          ["failed", "interrupted", "cancelled"].includes(previousJob?.status);
        const enablingFullAccess = permissionProfile === "open" && currentProfile !== "open";
        const needsFullAccessConsent =
          permissionProfile === "open" && Number(installation.fullAccessConsentVersion ?? 0) < 1;
        if (
          mode === "pi" &&
          body.riskAccepted !== true &&
          (!continuingExistingSetup || enablingFullAccess || needsFullAccessConsent)
        ) {
          const error = new Error("You must explicitly accept the OpenClaw local-agent risk notice before installation.");
          error.statusCode = 422;
          throw error;
        }
        if (permissionProfile === "open" && body.riskAccepted === true) {
          await store.update((state) => {
            state.installation.fullAccessConsentVersion = 1;
          });
        }
        const result = await startInstall({ permissionProfile, model: selectedModel });
        json(response, result.complete ? 200 : 202, {
          jobId: result.job.id,
          status: result.job.status,
          reused: result.reused,
          complete: result.complete,
          mode,
          model: result.job.model,
          permissionProfile: result.job.permissionProfile,
          eventsUrl: `/api/v1/jobs/${result.job.id}/events`,
          cancelUrl: `/api/v1/jobs/${result.job.id}/cancel`,
        });
        return;
      }

      const eventsMatch = pathname.match(/^\/api\/v1\/jobs\/([0-9a-f-]+)\/events$/i);
      if (request.method === "GET" && eventsMatch) {
        const jobId = eventsMatch[1];
        const initial = store.snapshot().jobs[jobId];
        if (!initial) {
          json(response, 404, { error: "Job not found." });
          return;
        }
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.flushHeaders?.();
        const lastId = Number(request.headers["last-event-id"] ?? url.searchParams.get("lastEventId") ?? 0);
        let replaying = true;
        const pending = [];
        const onEvent = (event) => {
          if (replaying) {
            pending.push(event);
            return;
          }
          if (!response.writableEnded) sseWrite(response, event);
          if (event.type === "job" && TERMINAL_JOB_STATUSES.has(event.status)) {
            setTimeout(() => response.end(), 50);
          }
        };
        const unsubscribe = subscribe(jobId, onEvent);
        const replay = store.snapshot().jobs[jobId] ?? initial;
        let newestId = lastId;
        for (const event of replay.events ?? []) {
          if (event.id > lastId) {
            sseWrite(response, event);
            newestId = Math.max(newestId, event.id);
          }
        }
        replaying = false;
        for (const event of pending) {
          if (event.id > newestId) onEvent(event);
        }
        if (TERMINAL_JOB_STATUSES.has(replay.status)) {
          unsubscribe();
          response.end();
          return;
        }
        const heartbeat = setInterval(() => {
          if (!response.writableEnded) response.write(": keep-alive\n\n");
        }, 15_000);
        heartbeat.unref?.();
        request.once("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return;
      }

      const cancelMatch = pathname.match(/^\/api\/v1\/jobs\/([0-9a-f-]+)\/cancel$/i);
      if (request.method === "POST" && cancelMatch) {
        assertSafeMutation(request);
        await readJson(request);
        const result = await cancelJob(cancelMatch[1]);
        if (!result) {
          json(response, 404, { error: "Job not found." });
          return;
        }
        json(response, 200, {
          jobId: result.job.id,
          status: result.job.status,
          cancelRequested: result.cancelled,
        });
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/verify/model") {
        assertSafeMutation(request);
        await readJson(request);
        const result = await verifyModel({ exercise: true });
        if (result.ok) await markInstallation(store.snapshot().installation.lastJobId, { modelInstalled: true });
        json(response, result.ok ? 200 : 503, result);
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/verify/agent") {
        assertSafeMutation(request);
        await readJson(request);
        const result = await verifyAgent();
        if (result.ok) {
          await markInstallation(store.snapshot().installation.lastJobId, {
            agentConfigured: true,
            gatewayRunning: true,
          });
        }
        json(response, result.ok ? 200 : 503, result);
        return;
      }

      if (request.method === "GET" && pathname === "/api/v1/logs/export") {
        const body = exportLogs();
        response.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          "Content-Disposition": `attachment; filename="clawboot-${new Date().toISOString().slice(0, 10)}.log"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(body);
        return;
      }

      if (pathname.startsWith("/api/")) {
        json(response, 404, { error: "API route not found." });
        return;
      }

      if (request.method === "GET" || request.method === "HEAD") {
        if (await serveStatic(request, response, pathname)) return;
      }
      json(response, 404, { error: "Not found." });
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status = Number(error?.statusCode) || 500;
      json(response, status, {
        error: status >= 500 ? "Setup service error." : friendlyError(error),
        ...(status >= 500 ? { detail: friendlyError(error) } : {}),
      });
    }
  }

  const server = http.createServer((request, response) => void handler(request, response));
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;

  return {
    config,
    mode,
    store,
    server,
    handler,
    async listen(port = config.port, host = config.host) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return server.address();
    },
    async close() {
      for (const controller of controllers.values()) controller.abort();
      for (const controller of channelControllers.values()) controller.abort();
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
    startInstall,
    cancelJob,
    verifyModel,
    verifyAgent,
    exportLogs,
  };
}
