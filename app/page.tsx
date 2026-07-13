"use client";
/* eslint-disable @next/next/no-img-element -- WhatsApp supplies a short-lived data URI QR image. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type PermissionProfile = "open";
type ModelId = "qwen3.5:2b" | "qwen3.5:4b";
type CheckStatus = "pass" | "warn" | "fail";
type StepStatus = "pending" | "running" | "complete" | "failed";
type ChannelName = "telegram" | "whatsapp";
type ChannelPanel = "list" | ChannelName;

type CheckItem = { id: string; label: string; value: string; detail: string; status: CheckStatus };
type InstallStep = { id: string; label: string; status: StepStatus };
type ChannelState = {
  telegram: { status: string; bot: { id: string; name: string; username: string } | null; error: string | null };
  whatsapp: { status: string; account: string | null; qrDataUrl: string | null; error: string | null };
};
type PairingRequest = { code: string; name: string; sender: string; expiresAt?: string | null };
type DownloadState = {
  stepId: string;
  label: string;
  percent: number;
  downloadedBytes?: number;
  totalBytes?: number;
  resumable: boolean;
  paused?: boolean;
};
type FailureDiagnosis = {
  code: string;
  step: string;
  problem: string;
  reason: string;
  nextAction: string;
  retryable: boolean;
};

const DEFAULT_MODEL_ID: ModelId = "qwen3.5:2b";
const QR_DATA_URL_MAX_LENGTH = 128 * 1024;
const APP_NAME = "ClawBoot";
const APP_VERSION = "1.2.0";
const WIZARD_STEPS = ["System", "Model", "Access", "Review", "Install", "Messaging", "Done"];
const EMPTY_CHANNELS: ChannelState = {
  telegram: { status: "not_configured", bot: null, error: null },
  whatsapp: { status: "not_configured", account: null, qrDataUrl: null, error: null },
};
const MODELS: Array<{
  id: ModelId;
  title: string;
  detail: string;
  download: string;
  totalDownload: string;
  memory: string;
  badge: string;
}> = [
  {
    id: "qwen3.5:2b",
    title: "Qwen 3.5 2B",
    detail: "Fastest option for an 8 GB Pi 5",
    download: "2.7 GB",
    totalDownload: "About 4.2 GB",
    memory: "4K context on 8 GB · 8K on 16 GB",
    badge: "RECOMMENDED",
  },
  {
    id: "qwen3.5:4b",
    title: "Qwen 3.5 4B",
    detail: "Smarter answers, but slower and uses more memory",
    download: "3.4 GB",
    totalDownload: "About 4.9 GB",
    memory: "4K context · 8 GB Pi minimum",
    badge: "SMARTER",
  },
];
const PERMISSIONS = [
  { id: "open" as const, title: "Full Pi assistant", description: "Runs commands without approval, uses sudo for system administration, accesses files across this Pi, searches and fetches the web, and controls an isolated Chromium browser." },
];

function isModelId(value: unknown): value is ModelId {
  return MODELS.some((item) => item.id === value);
}

function isPermissionProfile(value: unknown): value is PermissionProfile {
  return value === "open";
}

function modelDetails(model: ModelId) {
  return MODELS.find((item) => item.id === model) ?? MODELS[0];
}

function installStepsFor(model: ModelId): InstallStep[] {
  const selected = modelDetails(model);
  return [
    { id: "preflight", label: "Check system requirements", status: "pending" },
    { id: "system", label: "Prepare service account", status: "pending" },
    { id: "ollama", label: "Install Ollama runtime", status: "pending" },
    { id: "model", label: `Download ${selected.title}`, status: "pending" },
    { id: "openclaw", label: "Install OpenClaw", status: "pending" },
    { id: "onboard", label: "Configure local agent", status: "pending" },
    { id: "verify", label: "Start and test services", status: "pending" },
  ];
}

function validQrDataUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > QR_DATA_URL_MAX_LENGTH) return null;
  return /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value) ? value : null;
}

function formatBytes(value: unknown) {
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes > 0 ? `${Math.round(bytes / 1024 ** 3)} GB` : "Unknown";
}

function formatTransferBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0 MB";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)} GB`;
  return `${Math.round(value / 1_000_000)} MB`;
}

function normalizeStatus(value: unknown): CheckStatus {
  const status = String(value ?? "pass").toLowerCase();
  if (["fail", "error", "blocked"].includes(status)) return "fail";
  if (["warn", "warning", "notice"].includes(status)) return "warn";
  return "pass";
}

function normalizeChecks(payload: Record<string, unknown>): CheckItem[] {
  const raw = Array.isArray(payload.checks) ? payload.checks as Array<Record<string, unknown>> : [];
  const byId = new Map(raw.map((item) => [String(item.id), item]));
  const device = payload.device as Record<string, unknown> | undefined;
  const rows = [
    { id: "device", label: "Raspberry Pi", value: String(device?.model ?? byId.get("device")?.value ?? "Unknown device"), item: byId.get("device") },
    { id: "operating-system", label: "Operating system", value: String(device?.os ?? device?.architecture ?? byId.get("operating-system")?.value ?? "Unknown OS"), item: byId.get("operating-system") ?? byId.get("architecture") },
    { id: "memory", label: "Memory", value: formatBytes(device?.memoryBytes ?? byId.get("memory")?.value), item: byId.get("memory") },
    { id: "disk", label: "Available storage", value: `${formatBytes(device?.freeDiskBytes ?? byId.get("disk")?.value)} free`, item: byId.get("disk") },
    { id: "network", label: "Internet connection", value: byId.get("network")?.value === false ? "Unavailable" : "Available", item: byId.get("network") },
  ];
  return rows.map((row) => ({ id: row.id, label: row.label, value: row.value, detail: String(row.item?.detail ?? "Check complete."), status: normalizeStatus(row.item?.status) }));
}

function mapJobSteps(value: unknown, model: ModelId): InstallStep[] {
  const defaults = installStepsFor(model);
  if (!Array.isArray(value)) return defaults;
  return defaults.map((base) => {
    const source = value.find((item) => String((item as Record<string, unknown>).id) === base.id) as Record<string, unknown> | undefined;
    const status = String(source?.status ?? base.status);
    return { ...base, status: status === "complete" ? "complete" : status === "running" ? "running" : status === "failed" ? "failed" : "pending" };
  });
}

function StatusMark({ status }: { status: CheckStatus | StepStatus }) {
  const label = status === "pass" || status === "complete" ? "PASS" : status === "warn" ? "NOTICE" : status === "running" ? "WORKING" : status === "failed" || status === "fail" ? "BLOCKED" : "WAITING";
  return <span className={`status status--${status}`}><i aria-hidden="true" />{label}</span>;
}

function ChannelBadge({ status }: { status: string }) {
  const good = status === "connected";
  const busy = status === "configuring" || status === "installing" || status === "linking";
  return <span className={`channel-status ${good ? "is-good" : busy ? "is-busy" : status === "failed" ? "is-bad" : ""}`}>{good ? "CONNECTED" : busy ? "SETTING UP" : status === "failed" ? "NEEDS ATTENTION" : "NOT SET UP"}</span>;
}

export default function Home() {
  const [step, setStep] = useState(0);
  const [highestStep, setHighestStep] = useState(0);
  const [checks, setChecks] = useState<CheckItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(true);
  const [demoMode, setDemoMode] = useState(false);
  const [serviceVersion, setServiceVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<ModelId>(DEFAULT_MODEL_ID);
  const [permission, setPermission] = useState<PermissionProfile>("open");
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [installSteps, setInstallSteps] = useState<InstallStep[]>(() => installStepsFor(DEFAULT_MODEL_ID));
  const [installProgress, setInstallProgress] = useState(0);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [installState, setInstallState] = useState<"idle" | "running" | "failed" | "complete">("idle");
  const [download, setDownload] = useState<DownloadState | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [diagnosis, setDiagnosis] = useState<FailureDiagnosis | null>(null);
  const [benchmark, setBenchmark] = useState<{ speed: string; firstToken: string } | null>(null);
  const [benchmarking, setBenchmarking] = useState(false);
  const [channels, setChannels] = useState<ChannelState>(EMPTY_CHANNELS);
  const [channelPanel, setChannelPanel] = useState<ChannelPanel>("list");
  const [channelBusy, setChannelBusy] = useState(false);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [telegramToken, setTelegramToken] = useState("");
  const [pairings, setPairings] = useState<PairingRequest[]>([]);
  const [pairingsLoaded, setPairingsLoaded] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  const goTo = useCallback((next: number) => {
    setStep(next);
    setHighestStep((current) => Math.max(current, next));
    setError(null);
  }, []);

  const loadChannels = useCallback(async () => {
    const response = await fetch("/api/v1/channels", { headers: { Accept: "application/json" } });
    const payload = await response.json() as { channels?: ChannelState; error?: string; detail?: string };
    if (!response.ok || !payload.channels) throw new Error(payload.detail ?? payload.error ?? "Messaging status is unavailable.");
    setChannels(payload.channels);
    setChannelError(null);
    return payload.channels;
  }, []);

  const applyEvent = useCallback((event: Record<string, unknown>) => {
    const type = String(event.type ?? "");
    const status = String(event.status ?? "");
    const message = event.message ? String(event.message) : "";
    const progress = Number(event.progress ?? NaN);
    if (message && type === "log") setLogs((current) => [...current.slice(-199), message]);
    if (type === "diagnostic") {
      if (message) setLogs((current) => [...current.slice(-199), message]);
      if (event.diagnosis && typeof event.diagnosis === "object") setDiagnosis(event.diagnosis as FailureDiagnosis);
      setDetailsOpen(true);
    }
    if (Number.isFinite(progress)) setInstallProgress(Math.max(0, Math.min(100, progress)));
    if (type === "download") {
      const percent = Math.max(0, Math.min(100, Number(event.percent ?? 0)));
      setDownload({
        stepId: String(event.stepId ?? ""),
        label: String(event.label ?? "Download"),
        percent: Number.isFinite(percent) ? percent : 0,
        downloadedBytes: Number.isFinite(Number(event.downloadedBytes)) ? Number(event.downloadedBytes) : undefined,
        totalBytes: Number.isFinite(Number(event.totalBytes)) ? Number(event.totalBytes) : undefined,
        resumable: event.resumable === true,
      });
    }
    if (type === "step") {
      const stepId = String(event.stepId ?? "");
      setInstallSteps((current) => current.map((item) => item.id === stepId ? { ...item, status: status === "complete" ? "complete" : status === "failed" ? "failed" : "running" } : item));
      if (status === "complete" && ["ollama", "model"].includes(stepId)) setDownload(null);
    }
    if (type === "job" && status === "complete") {
      eventSourceRef.current?.close();
      setInstallProgress(100);
      setDownload(null);
      setInstallState("complete");
      setInstallSteps((current) => current.map((item) => ({ ...item, status: "complete" })));
      goTo(5);
      void loadChannels();
    }
    if (type === "job" && ["failed", "cancelled", "interrupted"].includes(status)) {
      eventSourceRef.current?.close();
      setInstallState("failed");
      setDownload((current) => current ? { ...current, paused: true } : null);
      setError(message || "Installation stopped. Completed work has been preserved.");
    }
  }, [goTo, loadChannels]);

  const connectToJob = useCallback((jobId: string) => {
    eventSourceRef.current?.close();
    setActiveJobId(jobId);
    setInstallState("running");
    const source = new EventSource(`/api/v1/jobs/${encodeURIComponent(jobId)}/events`);
    eventSourceRef.current = source;
    source.onmessage = (message) => {
      try { applyEvent(JSON.parse(message.data) as Record<string, unknown>); } catch { /* Keep the Pi job running. */ }
    };
    source.onerror = () => {
      source.close();
      setError("The progress connection was interrupted. Reopen ClawBoot to reconnect; installation continues in the background.");
    };
  }, [applyEvent]);

  const loadState = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const [preflightResponse, statusResponse] = await Promise.all([
        fetch("/api/v1/preflight?refresh=1", { headers: { Accept: "application/json" } }),
        fetch("/api/v1/status", { headers: { Accept: "application/json" } }),
      ]);
      if (!preflightResponse.ok || !statusResponse.ok) throw new Error("ClawBoot service is not responding.");
      const preflight = await preflightResponse.json() as Record<string, unknown>;
      const status = await statusResponse.json() as Record<string, unknown>;
      const preflightVersion = String(preflight.serviceVersion ?? "");
      const statusVersion = String(status.serviceVersion ?? "");
      setServiceVersion(statusVersion || preflightVersion || null);
      if (preflightVersion !== APP_VERSION || statusVersion !== APP_VERSION) {
        setConnected(false);
        setChecks([]);
        setStep(0);
        setError(`The ClawBoot app is ${APP_VERSION}, but its background service is ${statusVersion || preflightVersion || "unknown"}. Close and reopen ClawBoot to run the graphical service repair.`);
        return;
      }
      const activeJob = status.activeJob as Record<string, unknown> | null;
      const lastJob = status.lastJob as Record<string, unknown> | null;
      const installation = status.installation as Record<string, unknown> | undefined;
      const persistedModel = isModelId(installation?.model) ? installation.model : DEFAULT_MODEL_ID;
      const persistedPermission = isPermissionProfile(installation?.permissionProfile) ? installation.permissionProfile : "open";
      setModel(persistedModel);
      setPermission(persistedPermission);
      setChecks(normalizeChecks(preflight));
      setDemoMode(preflight.demo === true);
      setConnected(true);
      if (status.channels) setChannels(status.channels as ChannelState);
      if (activeJob && status.activeJobId) {
        setInstallSteps(mapJobSteps(activeJob.steps, persistedModel));
        setInstallProgress(Number(activeJob.progress ?? 0));
        goTo(4);
        connectToJob(String(status.activeJobId));
      } else if (installation?.gatewayRunning === true && Number(installation?.securityBaseline ?? 0) < 10 && Number(installation?.fullAccessConsentVersion ?? 0) < 1) {
        setRiskAccepted(false);
        goTo(2);
        setError("ClawBoot v1.2 is root-equivalent. Installing the package granted Full Pi access; review and acknowledge the warning before ClawBoot configures the upgraded agent. OpenClaw, Ollama, and the downloaded model are kept.");
      } else if (lastJob?.status === "failed") {
        setInstallState("failed");
        setInstallProgress(Number(lastJob.progress ?? 0));
        setInstallSteps(lastJob.steps ? mapJobSteps(lastJob.steps, persistedModel) : installStepsFor(persistedModel));
        setDiagnosis(lastJob.diagnosis && typeof lastJob.diagnosis === "object" ? lastJob.diagnosis as FailureDiagnosis : null);
        goTo(4);
        setError(String(lastJob.error ?? "Installation stopped. Completed work has been preserved."));
      } else if (installation?.gatewayRunning === true && Number(installation?.securityBaseline ?? 0) < 10) {
        setInstallState("failed");
        setInstallProgress(Number(lastJob?.progress ?? 86));
        setInstallSteps(lastJob?.steps ? mapJobSteps(lastJob.steps, persistedModel) : installStepsFor(persistedModel));
        goTo(4);
        setError("ClawBoot needs to apply the latest model, web, browser, and Full Pi configuration. Press Retry; OpenClaw, Ollama, and the downloaded model are kept.");
      } else if (lastJob?.status === "complete" || installation?.gatewayRunning === true) {
        setInstallState("complete");
        setInstallProgress(100);
        setInstallSteps(installStepsFor(persistedModel).map((item) => ({ ...item, status: "complete" })));
        goTo(5);
      }
    } catch (cause) {
      setConnected(false);
      setChecks([]);
      setError(cause instanceof Error ? cause.message : "ClawBoot service is not responding.");
    } finally { setChecking(false); }
  }, [connectToJob, goTo]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadState(), 0);
    return () => { window.clearTimeout(timer); eventSourceRef.current?.close(); };
  }, [loadState]);

  useEffect(() => {
    if (step !== 5 || !["installing", "linking"].includes(channels.whatsapp.status)) return;
    const timer = window.setInterval(() => void loadChannels().catch((cause) => setChannelError(cause instanceof Error ? cause.message : "Could not refresh WhatsApp.")), 900);
    return () => window.clearInterval(timer);
  }, [channels.whatsapp.status, loadChannels, step]);

  const blockingChecks = useMemo(() => checks.filter((item) => item.status === "fail").length, [checks]);

  const startInstall = useCallback(async () => {
    setError(null); setDiagnosis(null); setDetailsOpen(false); setInstallState("running"); setInstallProgress(0); setInstallSteps(installStepsFor(model)); setDownload(null); setLogs([]); goTo(4);
    try {
      const response = await fetch("/api/v1/install", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ riskAccepted, permissionProfile: permission, model }) });
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(String(payload.detail ?? payload.error ?? "Installation could not start."));
      if (payload.complete === true) {
        setInstallState("complete");
        setInstallProgress(100);
        setInstallSteps(installStepsFor(model).map((item) => ({ ...item, status: "complete" })));
        goTo(5);
        return;
      }
      if (!payload.jobId) throw new Error("The ClawBoot service did not return an installation job.");
      connectToJob(String(payload.jobId));
    } catch (cause) { setInstallState("failed"); setError(cause instanceof Error ? cause.message : "Installation could not start."); }
  }, [connectToJob, goTo, model, permission, riskAccepted]);

  const cancelInstall = useCallback(async () => {
    if (!activeJobId) return;
    try { await fetch(`/api/v1/jobs/${encodeURIComponent(activeJobId)}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); }
    finally { eventSourceRef.current?.close(); setInstallState("failed"); setError("Installation cancelled. Completed work has been preserved."); }
  }, [activeJobId]);

  const setupTelegram = useCallback(async () => {
    setChannelBusy(true); setChannelError(null); setPairings([]); setPairingsLoaded(false);
    try {
      const response = await fetch("/api/v1/channels/telegram", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ token: telegramToken.trim() }) });
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(String(payload.detail ?? payload.error ?? "Telegram setup failed."));
      setTelegramToken("");
      await loadChannels();
    } catch (cause) { setChannelError(cause instanceof Error ? cause.message : "Telegram setup failed."); }
    finally { setChannelBusy(false); }
  }, [loadChannels, telegramToken]);

  const setupWhatsApp = useCallback(async () => {
    setChannelBusy(true); setChannelError(null); setPairings([]); setPairingsLoaded(false);
    try {
      const response = await fetch("/api/v1/channels/whatsapp/login", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "{}" });
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(String(payload.detail ?? payload.error ?? "WhatsApp linking could not start."));
      await loadChannels();
    } catch (cause) { setChannelError(cause instanceof Error ? cause.message : "WhatsApp linking could not start."); }
    finally { setChannelBusy(false); }
  }, [loadChannels]);

  const cancelWhatsApp = useCallback(async () => {
    setChannelBusy(true);
    setChannelError(null);
    try {
      const response = await fetch("/api/v1/channels/whatsapp/cancel", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "{}" });
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(String(payload.detail ?? payload.error ?? "WhatsApp linking could not be cancelled."));
      await loadChannels();
    } catch (cause) {
      setChannelError(cause instanceof Error ? cause.message : "WhatsApp linking could not be cancelled.");
    } finally {
      setChannelBusy(false);
    }
  }, [loadChannels]);

  const loadPairings = useCallback(async (channel: ChannelName) => {
    setChannelBusy(true); setChannelError(null);
    try {
      const response = await fetch(`/api/v1/channels/pairings?channel=${channel}`, { headers: { Accept: "application/json" } });
      const payload = await response.json() as { requests?: PairingRequest[]; error?: string; detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? payload.error ?? "Pairing requests could not be loaded.");
      setPairings(payload.requests ?? []); setPairingsLoaded(true);
    } catch (cause) { setChannelError(cause instanceof Error ? cause.message : "Pairing requests could not be loaded."); }
    finally { setChannelBusy(false); }
  }, []);

  const approvePairing = useCallback(async (channel: ChannelName, code: string) => {
    setChannelBusy(true); setChannelError(null);
    try {
      const response = await fetch("/api/v1/channels/pairings/approve", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ channel, code }) });
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(String(payload.detail ?? payload.error ?? "Pairing approval failed."));
      await loadPairings(channel);
    } catch (cause) { setChannelError(cause instanceof Error ? cause.message : "Pairing approval failed."); setChannelBusy(false); }
  }, [loadPairings]);

  const runBenchmark = useCallback(async () => {
    setBenchmarking(true); setError(null);
    try {
      const response = await fetch("/api/v1/verify/model", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(String(result.detail ?? result.error ?? "Model test failed."));
      setBenchmark({ speed: result.tokensPerSecond ? `${Number(result.tokensPerSecond).toFixed(1)} tokens/s` : "Completed", firstToken: result.firstTokenSeconds ? `${Number(result.firstTokenSeconds).toFixed(1)} s` : `${Number(result.latencyMs ?? 0) / 1000} s` });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Model test failed."); }
    finally { setBenchmarking(false); }
  }, []);

  const openChannel = (channel: ChannelName) => { setChannelPanel(channel); setChannelError(null); setPairings([]); setPairingsLoaded(false); };
  const selectedModel = modelDetails(model);
  const whatsappQrDataUrl = validQrDataUrl(channels.whatsapp.qrDataUrl);
  const chromiumEnabled = true;
  const nextDisabled = step === 0 ? !connected || checking || blockingChecks > 0 : step === 2 ? !riskAccepted : false;
  const continueAction = () => { if (step < 3) goTo(step + 1); else if (step === 3) void startInstall(); };
  return (
    <main className="imager-app">
      <div className="wizard-body">
        <aside className="step-rail" aria-label="Setup steps">
          <h2>Setup steps</h2>
          <nav>{WIZARD_STEPS.map((label, index) => {
            const available = index <= highestStep || index <= step || installState === "complete";
            return <button key={label} className={index === step ? "is-active" : ""} disabled={!available || index === 4 && installState === "running"} onClick={() => available && goTo(index)} aria-current={index === step ? "step" : undefined}>{label}{index < step && <span aria-label="complete">✓</span>}</button>;
          })}</nav>
          <div className="rail-version">{APP_NAME}<br />Version {APP_VERSION}<br />Service {serviceVersion ?? "checking"}</div>
        </aside>

        <section className="step-content" aria-live="polite">
          {step === 0 && <div className="page"><header><h1>Check your Raspberry Pi</h1><p>ClawBoot checks this Pi before any changes are made.</p></header>
            {!connected && !checking && <div className="message message--error"><strong>ClawBoot service unavailable</strong><span>{error}</span><button onClick={() => void loadState()}>TRY AGAIN</button></div>}
            {checking && <div className="message"><strong>Checking system...</strong><span>Reading device, memory, storage, and network information.</span></div>}
            {connected && <>{demoMode && <div className="message message--notice"><strong>Preview mode</strong><span>This computer is not a Raspberry Pi 5. The wizard is safe to explore and simulates installation.</span></div>}<div className="selection-list system-list">{checks.map((item) => <div className="selection-row" key={item.id}><span className="row-glyph" aria-hidden="true">{item.status === "pass" ? "✓" : item.status === "warn" ? "!" : "×"}</span><span className="row-copy"><strong>{item.label}</strong><small>{item.value} — {item.detail}</small></span><StatusMark status={item.status} /></div>)}</div></>}
          </div>}

          {step === 1 && <div className="page">
            <header><h1>Choose your local model</h1><p>Both models run entirely on this Raspberry Pi through Ollama.</p></header>
            <div className="selection-list">{MODELS.map((choice) => <label className={`selection-row model-row ${model === choice.id ? "is-selected" : ""}`} key={choice.id}>
              <input type="radio" name="model" value={choice.id} checked={model === choice.id} onChange={() => setModel(choice.id)} />
              <span className="radio-mark" aria-hidden="true">{model === choice.id && <i />}</span>
              <span className="row-copy"><strong>{choice.title}</strong><small>{choice.detail} · {choice.download} model download · local</small></span>
              <span className="recommended">{choice.badge}</span>
            </label>)}</div>
            <div className="info-table"><div><span>Model ID</span><strong>{model}</strong></div><div><span>Runtime</span><strong>Ollama for ARM64 · 1.5 GB</strong></div><div><span>First setup download</span><strong>{selectedModel.totalDownload} total</strong></div><div><span>Memory profile</span><strong>{selectedModel.memory}</strong></div><div><span>Cloud fallback</span><strong>Disabled</strong></div></div>
            <p className="footnote">The 4B model gives stronger answers but is slower, especially while Chromium is open. ClawBoot saves partial downloads and resumes them after interruptions or Retry.</p>
          </div>}

          {step === 2 && <div className="page">
            <header><h1>Acknowledge Full Pi access</h1><p>Installing ClawBoot already grants its service account root-equivalent permission. This screen makes that power explicit before the agent is configured.</p></header>
            {error && <div className="message message--notice"><strong>Review the v1.2 access upgrade</strong><span>{error}</span></div>}
            <div className="selection-list">{PERMISSIONS.map((profile) => <label className={`selection-row permission-row ${permission === profile.id ? "is-selected" : ""}`} key={profile.id}>
              <input type="radio" name="permission" value={profile.id} checked={permission === profile.id} onChange={() => { setPermission(profile.id); setRiskAccepted(false); }} />
              <span className="radio-mark" aria-hidden="true">{permission === profile.id && <i />}</span>
              <span className="row-copy"><strong>{profile.title}</strong><small>{profile.description}</small></span>
              <span className="recommended">REQUIRED</span>
            </label>)}</div>
            <label className="consent-row strong-warning">
              <input type="checkbox" checked={riskAccepted} onChange={(event) => setRiskAccepted(event.target.checked)} />
              <span>I understand that installing ClawBoot grants Full Pi assistant passwordless sudo. It can run commands without asking, read, change, or delete files across this Pi, browse the web, and control Chromium. A mistaken or malicious instruction could damage the system or expose my data.</span>
            </label>
          </div>}

          {step === 3 && <div className="page">
            <header><h1>Review setup</h1><p>Confirm the settings below, then let ClawBoot prepare the Pi.</p></header>
            <div className="review-table"><div><span>Runtime</span><strong>Ollama for Linux ARM64 (1.5 GB)</strong></div><div><span>Local model</span><strong>{selectedModel.title} ({selectedModel.download})</strong></div><div><span>Total download</span><strong>{selectedModel.totalDownload} · resumable</strong></div><div><span>Agent</span><strong>OpenClaw 2026.6.11 stable (tested)</strong></div><div><span>Access</span><strong>Full Pi assistant</strong></div><div><span>Web search and fetch</span><strong>Enabled</strong></div><div><span>Isolated Chromium</span><strong>Enabled</strong></div><div><span>Command approval</span><strong>Not required</strong></div><div><span>Messaging</span><strong>Telegram or WhatsApp after installation</strong></div><div><span>Starts at boot</span><strong>Yes</strong></div></div>
            <div className="message message--error"><strong>Full computer access will be enabled</strong><span>The assistant will be able to run commands without approval, administer the system with sudo, and access files across this Raspberry Pi. Only connect messaging accounts you trust.</span></div>
          </div>}

          {step === 4 && <div className="page install-page"><header><h1>{installState === "failed" ? "Installation stopped" : "Installing OpenClaw"}</h1><p>{installState === "failed" ? "Completed work and partial downloads have been preserved. You can retry safely." : "ClawBoot can be closed while installation continues. Interrupted downloads resume instead of restarting."}</p></header><div className="progress-heading"><strong>{installState === "failed" ? "ATTENTION REQUIRED" : "INSTALLING"}</strong><span>{Math.round(installProgress)}%</span></div><div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(installProgress)}><span style={{ width: `${installProgress}%` }} /></div>{download && <div className={`download-progress ${download.paused ? "is-paused" : ""}`}><div><strong>{download.label}</strong><span>{Math.round(download.percent)}%</span></div><div className="download-track" role="progressbar" aria-label={`${download.label} download`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(download.percent)}><span style={{ width: `${download.percent}%` }} /></div><small>{download.downloadedBytes != null && download.totalBytes != null ? `${formatTransferBytes(download.downloadedBytes)} of ${formatTransferBytes(download.totalBytes)}` : `${Math.round(download.percent)}% downloaded`} · {download.paused ? "Saved — Retry continues from here." : "Safe to close — progress is saved."}</small></div>}{error && <div className="message message--error"><strong>Installation did not finish</strong><span>{error}</span></div>}<div className="task-list">{installSteps.map((item) => <div key={item.id}><span className="task-mark">{item.status === "complete" ? "✓" : item.status === "running" ? ">" : item.status === "failed" ? "×" : ""}</span><span>{item.label}</span><StatusMark status={item.status} /></div>)}</div><button className="details-button" onClick={() => setDetailsOpen((open) => !open)}>{detailsOpen ? "HIDE" : "SHOW"} TECHNICAL DETAILS</button>{detailsOpen && <>{diagnosis && <div className="failure-diagnosis"><strong>FAILURE DIAGNOSIS</strong><dl><div><dt>Failed step</dt><dd>{diagnosis.step}</dd></div><div><dt>Problem</dt><dd>{diagnosis.problem}</dd></div><div><dt>Why</dt><dd>{diagnosis.reason}</dd></div><div><dt>What to do</dt><dd>{diagnosis.nextAction}</dd></div><div><dt>Error code</dt><dd><code>{diagnosis.code}</code></dd></div></dl></div>}<pre className="log-view">{logs.length ? logs.join("\n") : "Waiting for installer output..."}</pre></>}</div>}

          {step === 5 && <div className="page messaging-page">
            {channelPanel === "list" && <><header><h1>Connect your agent</h1><p>Choose where you want to message it. You can set up both or skip this for now.</p></header><div className="channel-list"><button onClick={() => openChannel("telegram")}><span className="channel-icon">TG</span><span className="row-copy"><strong>Telegram</strong><small>Create a bot with BotFather, paste its token, then approve your account.</small></span><ChannelBadge status={channels.telegram.status} /><span className="chevron">›</span></button><button onClick={() => openChannel("whatsapp")}><span className="channel-icon">WA</span><span className="row-copy"><strong>WhatsApp</strong><small>Link a WhatsApp account by scanning a QR code, then approve your number.</small></span><ChannelBadge status={channels.whatsapp.status} /><span className="chevron">›</span></button></div><div className="message message--error"><strong>Approved chats can control this Pi as root</strong><span>Unknown people must request pairing and groups are disabled, but every account you approve can ask the assistant to run root-level actions. Approve only your own accounts.</span></div></>}

            {channelPanel === "telegram" && <><header><h1>Set up Telegram</h1><p>Create a Telegram bot, then connect it securely to this Pi.</p></header>{channels.telegram.status === "connected" ? <><div className="connected-card"><span className="done-check">✓</span><div><strong>@{channels.telegram.bot?.username}</strong><small>Telegram is connected. Send this bot a message from the account you want to approve.</small></div></div><PairingSection channel="telegram" pairings={pairings} loaded={pairingsLoaded} busy={channelBusy} onRefresh={loadPairings} onApprove={approvePairing} /></> : <><ol className="setup-instructions"><li>Open the official <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> account in Telegram.</li><li>Send <code>/newbot</code> and follow its instructions.</li><li>Copy the bot token BotFather gives you and paste it below.</li></ol><label className="field-label token-field"><span>Bot token</span><input type="password" autoComplete="off" spellCheck={false} value={telegramToken} onChange={(event) => setTelegramToken(event.target.value)} placeholder="123456789:AA..." /></label><button className="button button--primary inline-action" disabled={channelBusy || telegramToken.trim().length < 20} onClick={() => void setupTelegram()}>{channelBusy ? "CONNECTING..." : "CONNECT TELEGRAM"}</button></>}{(channelError || channels.telegram.error) && <div className="message message--error"><strong>Telegram needs attention</strong><span>{channelError ?? channels.telegram.error}</span></div>}</>}

            {channelPanel === "whatsapp" && <><header><h1>Set up WhatsApp</h1><p>Link WhatsApp to the OpenClaw gateway running on this Pi.</p></header><div className="message message--notice"><strong>A separate number is recommended</strong><span>A personal number works, but a dedicated SIM or eSIM prevents normal personal chats from becoming agent input.</span></div>{channels.whatsapp.status === "connected" ? <><div className="connected-card"><span className="done-check">✓</span><div><strong>WhatsApp is linked</strong><small>Send the linked account a message from the phone number you want to approve.</small></div></div><PairingSection channel="whatsapp" pairings={pairings} loaded={pairingsLoaded} busy={channelBusy} onRefresh={loadPairings} onApprove={approvePairing} /></> : ["installing", "linking"].includes(channels.whatsapp.status) ? <div className="qr-stage"><strong>{whatsappQrDataUrl ? "Scan this QR code" : "Preparing a secure QR code..."}</strong><p>On your phone, open WhatsApp → Linked devices → Link a device.</p>{whatsappQrDataUrl && <img className="qr-image" src={whatsappQrDataUrl} alt="WhatsApp linking QR code" />}<small>Keep this screen open. The code refreshes automatically and disappears once linked.</small><button className="button button--outline inline-action" disabled={channelBusy} onClick={() => void cancelWhatsApp()}>{channelBusy ? "CANCELLING..." : "CANCEL LINKING"}</button></div> : <div className="whatsapp-start"><div className="channel-icon channel-icon--large">WA</div><div><strong>Have the WhatsApp phone ready</strong><p>ClawBoot installs the official OpenClaw WhatsApp plugin and shows the live linking code here.</p></div><button className="button button--primary" disabled={channelBusy} onClick={() => void setupWhatsApp()}>{channelBusy ? "STARTING..." : channels.whatsapp.status === "failed" ? "TRY AGAIN" : "SHOW QR CODE"}</button></div>}{(channelError || channels.whatsapp.error) && <div className="message message--error"><strong>WhatsApp needs attention</strong><span>{channelError ?? channels.whatsapp.error}</span></div>}</>}
          </div>}

          {step === 6 && <div className="page done-page"><header><h1>Setup complete</h1><p>OpenClaw and {selectedModel.title} are installed and running on this Raspberry Pi.</p></header><div className="done-summary"><span className="done-check" aria-hidden="true">✓</span><div><strong>Your local OpenClaw agent is ready</strong><small>Local model: {model}<br />Access: {PERMISSIONS.find((item) => item.id === permission)?.title}<br />Gateway: http://127.0.0.1:18789</small></div></div><div className="service-table"><div><span>OpenClaw gateway</span><strong className="ok-text">RUNNING</strong></div><div><span>{selectedModel.title}</span><strong className="ok-text">READY</strong></div><div><span>Web search and fetch</span><strong className="ok-text">ENABLED</strong></div><div><span>Isolated Chromium</span><strong className={chromiumEnabled ? "ok-text" : ""}>{chromiumEnabled ? "ENABLED" : "DISABLED"}</strong></div><div><span>Telegram</span><strong className={channels.telegram.status === "connected" ? "ok-text" : ""}>{channels.telegram.status === "connected" ? "CONNECTED" : "NOT SET UP"}</strong></div><div><span>WhatsApp</span><strong className={channels.whatsapp.status === "connected" ? "ok-text" : ""}>{channels.whatsapp.status === "connected" ? "CONNECTED" : "NOT SET UP"}</strong></div></div>{benchmark && <div className="benchmark-result"><span>Generation speed: <strong>{benchmark.speed}</strong></span><span>First response: <strong>{benchmark.firstToken}</strong></span></div>}{error && <div className="message message--error"><strong>Test failed</strong><span>{error}</span></div>}</div>}
        </section>
      </div>

      <footer className="action-bar"><div>{step === 0 && <button className="button button--outline" onClick={() => void loadState()} disabled={checking}>REFRESH</button>}{step === 4 && <button className="button button--outline" onClick={() => setDetailsOpen(true)}>VIEW LOG</button>}{step === 5 && channelPanel !== "list" && <button className="button button--outline" onClick={() => { setChannelPanel("list"); setChannelError(null); }}>ALL CHANNELS</button>}{step === 6 && <a className="button button--outline" href="/api/v1/logs/export">SAVE REPORT</a>}</div><div>{step > 0 && step < 4 && <button className="button" onClick={() => goTo(step - 1)}>BACK</button>}{step === 4 && installState === "running" && <button className="button" onClick={() => void cancelInstall()}>CANCEL</button>}{step === 4 && installState === "failed" && <button className="button button--primary" onClick={() => void startInstall()}>RETRY</button>}{step < 3 && <button className="button button--primary" disabled={nextDisabled} onClick={continueAction}>NEXT</button>}{step === 3 && <button className="button button--primary" onClick={continueAction}>START SETUP</button>}{step === 5 && <button className="button button--primary" onClick={() => goTo(6)}>FINISH</button>}{step === 6 && <button className="button" onClick={() => { setChannelPanel("list"); goTo(5); }}>MANAGE MESSAGING</button>}{step === 6 && <button className="button" onClick={() => void runBenchmark()} disabled={benchmarking}>{benchmarking ? "TESTING..." : "TEST MODEL"}</button>}{step === 6 && <a className="button button--primary" href="http://127.0.0.1:18789" target="_blank" rel="noreferrer">OPEN CONTROL PANEL</a>}</div></footer>
    </main>
  );
}

function PairingSection({ channel, pairings, loaded, busy, onRefresh, onApprove }: { channel: ChannelName; pairings: PairingRequest[]; loaded: boolean; busy: boolean; onRefresh: (channel: ChannelName) => Promise<void>; onApprove: (channel: ChannelName, code: string) => Promise<void> }) {
  return <div className="pairing-box"><div className="pairing-heading"><div><strong>Approve your account</strong><small>Send the bot or linked number a message, then refresh.</small></div><button className="button button--outline" disabled={busy} onClick={() => void onRefresh(channel)}>{busy ? "CHECKING..." : "REFRESH REQUESTS"}</button></div>{loaded && pairings.length === 0 && <p className="empty-state">No pending requests yet. Send a message from your phone and try again.</p>}{pairings.map((request) => <div className="pairing-request" key={request.code}><div><strong>{request.name}</strong><small>{request.sender}</small></div><code>{request.code}</code><button className="button button--primary" disabled={busy} onClick={() => void onApprove(channel, request.code)}>APPROVE</button></div>)}</div>;
}
