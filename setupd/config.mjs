import os from "node:os";
import path from "node:path";

export const SERVICE_VERSION = "1.1.1";
export const MODEL_ID = "qwen3.5:2b";
export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const GATEWAY_PORT = 18789;

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
    openclawInstaller:
      overrides.openclawInstaller ??
      path.join(stateDir, "downloads", "openclaw-install.sh"),
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
