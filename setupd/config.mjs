import os from "node:os";
import path from "node:path";

export const SERVICE_VERSION = "1.2.0";
export const OPENCLAW_VERSION = "2026.6.11";
export const DEFAULT_MODEL_ID = "qwen3.5:2b";
export const MODEL_ID = DEFAULT_MODEL_ID;
export const MODEL_CATALOG = Object.freeze({
  "qwen3.5:2b": Object.freeze({
    id: "qwen3.5:2b",
    label: "Qwen 3.5 2B",
    downloadGb: 2.7,
    totalDownloadGb: 4.2,
    params: Object.freeze({ thinking: false, num_ctx: 4096, keep_alive: "10m" }),
  }),
  "qwen3.5:4b": Object.freeze({
    id: "qwen3.5:4b",
    label: "Qwen 3.5 4B",
    downloadGb: 3.4,
    totalDownloadGb: 4.9,
    params: Object.freeze({ thinking: false, num_ctx: 4096, keep_alive: "5m" }),
  }),
});
export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const GATEWAY_PORT = 18789;
export const QR_DATA_URL_MAX_LENGTH = 128 * 1024;

export function modelSpec(modelId = DEFAULT_MODEL_ID) {
  return Object.hasOwn(MODEL_CATALOG, modelId) ? MODEL_CATALOG[modelId] : null;
}

export function makeConfig(overrides = {}) {
  const env = overrides.env ?? process.env;
  const home = overrides.home ?? env.HOME ?? os.homedir();
  const stateDir =
    overrides.stateDir ??
    env.OPENCLAW_SETUP_STATE_DIR ??
    (process.platform === "linux"
      ? "/var/lib/clawboot"
      : path.join(os.tmpdir(), "clawboot"));

  return {
    host: overrides.host ?? env.OPENCLAW_SETUP_HOST ?? "127.0.0.1",
    port: Number(overrides.port ?? env.OPENCLAW_SETUP_PORT ?? 3210),
    stateDir,
    stateFile: overrides.stateFile ?? path.join(stateDir, "state.json"),
    downloadsDir: overrides.downloadsDir ?? path.join(stateDir, "downloads"),
    staticDir: overrides.staticDir ?? env.OPENCLAW_SETUP_STATIC_DIR ?? null,
    helperPath:
      overrides.helperPath ??
      env.OPENCLAW_SETUP_HELPER ??
      "/usr/local/libexec/clawboot-helper",
    home,
    npmPrefix: overrides.npmPrefix ?? path.join(home, ".npm-global"),
    runtimeBin: overrides.runtimeBin ?? env.CLAWBOOT_RUNTIME_BIN ?? "/opt/clawboot/runtime/bin",
    demoDelayMs: Number(overrides.demoDelayMs ?? env.OPENCLAW_SETUP_DEMO_DELAY_MS ?? 350),
    forceDemo:
      overrides.forceDemo ??
      (env.OPENCLAW_SETUP_DEMO === "1"
        ? true
        : env.OPENCLAW_SETUP_DEMO === "0"
          ? false
          : null),
  };
}
