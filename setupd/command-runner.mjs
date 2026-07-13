import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { GATEWAY_PORT, MODEL_ID, OLLAMA_BASE_URL, OPENCLAW_VERSION, QR_DATA_URL_MAX_LENGTH, modelSpec } from "./config.mjs";
import { createSanitizer } from "./security.mjs";

const MAX_CAPTURE_BYTES = 512 * 1024;

export class CommandCancelledError extends Error {
  constructor(message = "The setup job was cancelled.") {
    super(message);
    this.name = "CommandCancelledError";
    this.code = "SETUP_CANCELLED";
  }
}

async function executable(candidates) {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next fixed location.
    }
  }
  return candidates[0];
}

async function openclawExecutable(config) {
  return executable([
    path.join(config.npmPrefix, "bin", "openclaw"),
    "/usr/local/bin/openclaw",
    "/usr/bin/openclaw",
    path.join(config.home, ".local", "bin", "openclaw"),
  ]);
}

function selectedModel(context) {
  const selected = modelSpec(context.model ?? MODEL_ID);
  if (!selected) throw new Error("The selected local model is not supported by ClawBoot.");
  return selected;
}

function validatedToolList(value) {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some((entry) => typeof entry !== "string" || !/^[A-Za-z0-9_*:./-]{1,80}$/.test(entry))
  ) {
    throw new Error("The OpenClaw tool policy contains an invalid tool list.");
  }
  return JSON.stringify([...new Set(value)]);
}

function validQrDataUrl(value) {
  return (
    typeof value === "string" &&
    value.length <= QR_DATA_URL_MAX_LENGTH &&
    /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value)
  );
}

function baseEnvironment(config) {
  return {
    HOME: config.home,
    USER: process.env.USER ?? "openclaw",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "openclaw",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    PATH: `${config.runtimeBin}:${path.join(config.npmPrefix, "bin")}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    NPM_CONFIG_PREFIX: config.npmPrefix,
    OPENCLAW_NO_PROMPT: "1",
    OPENCLAW_NO_ONBOARD: "1",
    OLLAMA_HOST: OLLAMA_BASE_URL,
  };
}

async function actionSpec(action, config, context) {
  const env = baseEnvironment(config);
  const sudo = await executable(["/usr/bin/sudo", "/bin/sudo"]);
  const helper = config.helperPath;
  const channel = ["telegram", "whatsapp"].includes(context.channel) ? context.channel : null;
  const gatewayToken =
    typeof context.gatewayToken === "string" && context.gatewayToken.length >= 24
      ? context.gatewayToken
      : null;
  const gatewaySecrets = gatewayToken ? [gatewayToken] : [];
  const model = selectedModel(context);

  switch (action) {
    case "prepareSystem":
      return {
        command: sudo,
        args: ["-n", helper, "prepare-system"],
        env,
        timeoutMs: 15 * 60_000,
      };
    case "installOllamaArm64":
      return {
        command: sudo,
        args: ["-n", helper, "install-ollama-arm64"],
        env,
        timeoutMs: 3 * 60 * 60_000,
      };
    case "ensureOllamaRuntime":
      return {
        command: sudo,
        args: ["-n", helper, "ensure-ollama-runtime"],
        env,
        timeoutMs: 3 * 60 * 60_000,
      };
    case "configureOllamaLoopback":
      return {
        command: sudo,
        args: ["-n", helper, "configure-ollama-loopback"],
        env,
        timeoutMs: 2 * 60_000,
      };
    case "restartOllama":
      return {
        command: sudo,
        args: ["-n", helper, "restart-ollama"],
        env,
        timeoutMs: 2 * 60_000,
      };
    case "ollamaVersion":
      return {
        command: await executable(["/usr/bin/ollama", "/usr/local/bin/ollama"]),
        args: ["--version"],
        env,
        timeoutMs: 15_000,
      };
    case "pullModel":
      return {
        command: await executable(["/usr/bin/ollama", "/usr/local/bin/ollama"]),
        args: ["pull", model.id],
        env,
        timeoutMs: 90 * 60_000,
      };
    case "installOpenClaw":
      return {
        command: await executable([path.join(config.runtimeBin, "npm")]),
        args: [
          "install",
          "--global",
          "--prefix",
          config.npmPrefix,
          "--no-audit",
          "--no-fund",
          "--loglevel=warn",
          `openclaw@${OPENCLAW_VERSION}`,
        ],
        env,
        timeoutMs: 30 * 60_000,
      };
    case "openclawVersion":
      return {
        command: await openclawExecutable(config),
        args: ["--version"],
        env,
        timeoutMs: 20_000,
      };
    case "ollamaRuntimeStatus":
      return {
        command: "/usr/bin/test",
        args: ["-x", "/usr/lib/ollama/llama-server"],
        env,
        timeoutMs: 20_000,
      };
    case "onboardOpenClaw": {
      if (typeof context.gatewayToken !== "string" || context.gatewayToken.length < 24) {
        throw new Error("A generated gateway token is required for onboarding.");
      }
      return {
        command: await openclawExecutable(config),
        args: [
          "onboard",
          "--non-interactive",
          "--accept-risk",
          "--mode",
          "local",
          "--auth-choice",
          "ollama",
          "--custom-base-url",
          OLLAMA_BASE_URL,
          "--custom-model-id",
          model.id,
          "--gateway-port",
          "18789",
          "--gateway-bind",
          "loopback",
          "--gateway-auth",
          "token",
          "--gateway-token",
          context.gatewayToken,
          "--install-daemon",
          "--daemon-runtime",
          "node",
          "--skip-channels",
          "--skip-search",
          "--skip-skills",
          "--skip-hooks",
          "--skip-ui",
          "--suppress-gateway-token-output",
          "--json",
        ],
        env,
        timeoutMs: 15 * 60_000,
        secrets: [context.gatewayToken],
      };
    }
    case "openclawGatewayProbe":
      return {
        command: await openclawExecutable(config),
        args: [
          "gateway",
          "probe",
          "--port",
          String(GATEWAY_PORT),
          "--json",
          ...(gatewayToken ? ["--token", gatewayToken] : []),
        ],
        env,
        timeoutMs: 45_000,
        secrets: gatewaySecrets,
      };
    case "disableCloudMemorySearch":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "agents.defaults.memorySearch.enabled", "false", "--strict-json"],
        env,
        timeoutMs: 30_000,
      };
    case "configurePrimaryModel":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "agents.defaults.model.primary", JSON.stringify(`ollama/${model.id}`), "--strict-json"],
        env,
        timeoutMs: 30_000,
      };
    case "configureLocalModelDefaults":
      return {
        command: await openclawExecutable(config),
        args: [
          "config",
          "set",
          "agents.defaults.models",
          JSON.stringify({
            [`ollama/${model.id}`]: {
              params: model.params,
            },
          }),
          "--strict-json",
          "--merge",
        ],
        env,
        timeoutMs: 30_000,
      };
    case "readToolsAllow":
      return {
        command: await openclawExecutable(config),
        args: ["config", "get", "tools.allow", "--json"],
        env,
        timeoutMs: 30_000,
        sensitiveOutput: true,
      };
    case "readToolsAlsoAllow":
      return {
        command: await openclawExecutable(config),
        args: ["config", "get", "tools.alsoAllow", "--json"],
        env,
        timeoutMs: 30_000,
        sensitiveOutput: true,
      };
    case "readToolsDeny":
      return {
        command: await openclawExecutable(config),
        args: ["config", "get", "tools.deny", "--json"],
        env,
        timeoutMs: 30_000,
        sensitiveOutput: true,
      };
    case "readPluginsAllow":
      return {
        command: await openclawExecutable(config),
        args: ["config", "get", "plugins.allow", "--json"],
        env,
        timeoutMs: 30_000,
        sensitiveOutput: true,
      };
    case "readPluginsDeny":
      return {
        command: await openclawExecutable(config),
        args: ["config", "get", "plugins.deny", "--json"],
        env,
        timeoutMs: 30_000,
        sensitiveOutput: true,
      };
    case "setPluginsAllow":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "plugins.allow", validatedToolList(context.tools), "--strict-json"],
        env,
        timeoutMs: 30_000,
      };
    case "setPluginsDeny":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "plugins.deny", validatedToolList(context.tools), "--strict-json"],
        env,
        timeoutMs: 30_000,
      };
    case "setToolsAllow":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "tools.allow", validatedToolList(context.tools), "--strict-json"],
        env,
        timeoutMs: 30_000,
      };
    case "unsetToolsAllow":
      return {
        command: await openclawExecutable(config),
        args: ["config", "unset", "tools.allow"],
        env,
        timeoutMs: 30_000,
      };
    case "setToolsAlsoAllow":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "tools.alsoAllow", validatedToolList(context.tools), "--strict-json"],
        env,
        timeoutMs: 30_000,
      };
    case "unsetToolsAlsoAllow":
      return {
        command: await openclawExecutable(config),
        args: ["config", "unset", "tools.alsoAllow"],
        env,
        timeoutMs: 30_000,
      };
    case "setToolsDeny":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "tools.deny", validatedToolList(context.tools), "--strict-json"],
        env,
        timeoutMs: 30_000,
      };
    case "enableDuckDuckGo":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "plugins.entries.duckduckgo.enabled", "true", "--strict-json"],
        env,
        timeoutMs: 30_000,
      };
    case "configureWebSearch":
      return {
        command: await openclawExecutable(config),
        args: [
          "config",
          "set",
          "tools.web.search",
          JSON.stringify({ enabled: true, provider: "duckduckgo", maxResults: 5, timeoutSeconds: 30, cacheTtlMinutes: 15 }),
          "--strict-json",
        ],
        env,
        timeoutMs: 30_000,
      };
    case "configureWebFetch":
      return {
        command: await openclawExecutable(config),
        args: [
          "config",
          "set",
          "tools.web.fetch",
          JSON.stringify({
            enabled: true,
            maxChars: 8000,
            maxCharsCap: 8000,
            maxResponseBytes: 750000,
            timeoutSeconds: 30,
            cacheTtlMinutes: 15,
            maxRedirects: 3,
            readability: true,
          }),
          "--strict-json",
        ],
        env,
        timeoutMs: 30_000,
      };
    case "ensureChromium":
      return {
        command: sudo,
        args: ["-n", helper, "ensure-chromium"],
        env,
        timeoutMs: 30 * 60_000,
      };
    case "enableBrowserPlugin":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "plugins.entries.browser.enabled", "true", "--strict-json"],
        env,
        timeoutMs: 30_000,
      };
    case "configureBrowser":
      return {
        command: await openclawExecutable(config),
        args: [
          "config",
          "set",
          "browser",
          JSON.stringify({
            enabled: true,
            defaultProfile: "openclaw",
            headless: true,
            noSandbox: false,
            evaluateEnabled: false,
            ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
            executablePath: "/usr/local/bin/clawboot-chromium",
            localLaunchTimeoutMs: 30000,
            localCdpReadyTimeoutMs: 20000,
            actionTimeoutMs: 90000,
          }),
          "--strict-json",
        ],
        env,
        timeoutMs: 30_000,
      };
    case "disableBrowser":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "browser.enabled", "false", "--strict-json"],
        env,
        timeoutMs: 30_000,
      };
    case "disableElevatedTools":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "tools.elevated.enabled", "false", "--strict-json"],
        env,
        timeoutMs: 30_000,
      };
    case "validateOpenClawConfig":
      return {
        command: await openclawExecutable(config),
        args: ["config", "validate", "--json"],
        env,
        timeoutMs: 30_000,
      };
    case "openclawDoctorFix":
      return {
        command: await openclawExecutable(config),
        args: ["doctor", "--fix", "--non-interactive"],
        env,
        timeoutMs: 5 * 60_000,
      };
    case "openclawSecurityFix":
      return {
        command: await openclawExecutable(config),
        args: ["security", "audit", "--fix", "--json"],
        env,
        timeoutMs: 5 * 60_000,
      };
    case "openclawSecurityDeep":
      return {
        command: await openclawExecutable(config),
        args: [
          "security",
          "audit",
          "--deep",
          "--json",
          ...(gatewayToken ? ["--token", gatewayToken] : []),
        ],
        env,
        timeoutMs: 5 * 60_000,
        secrets: gatewaySecrets,
      };
    case "permissionChat":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "tools.profile", "messaging"],
        env,
        timeoutMs: 30_000,
      };
    case "permissionGuardedProfile":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "tools.profile", "coding"],
        env,
        timeoutMs: 30_000,
      };
    case "permissionOpen":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "tools.profile", "full"],
        env,
        timeoutMs: 30_000,
      };
    case "permissionFilesystemRestricted":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "tools.fs.workspaceOnly", "true", "--strict-json"],
        env,
        timeoutMs: 30_000,
      };
    case "permissionFilesystemFull":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "tools.fs.workspaceOnly", "false", "--strict-json"],
        env,
        timeoutMs: 30_000,
      };
    case "permissionApplyPatchRestricted":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "tools.exec.applyPatch.workspaceOnly", "true", "--strict-json"],
        env,
        timeoutMs: 30_000,
      };
    case "permissionApplyPatchFull":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "tools.exec.applyPatch.workspaceOnly", "false", "--strict-json"],
        env,
        timeoutMs: 30_000,
      };
    case "permissionSandboxOff":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "agents.defaults.sandbox.mode", "off"],
        env,
        timeoutMs: 30_000,
      };
    case "permissionExecDeny":
      return {
        command: await openclawExecutable(config),
        args: ["exec-policy", "preset", "deny-all"],
        env,
        timeoutMs: 30_000,
      };
    case "permissionExecCautious":
      return {
        command: await openclawExecutable(config),
        args: ["exec-policy", "preset", "cautious"],
        env,
        timeoutMs: 30_000,
      };
    case "permissionExecYolo":
      return {
        command: await openclawExecutable(config),
        args: ["exec-policy", "preset", "yolo"],
        env,
        timeoutMs: 30_000,
      };
    case "verifyAgentRoot":
      return {
        command: sudo,
        args: ["-n", "/usr/bin/true"],
        env,
        timeoutMs: 30_000,
      };
    case "telegramAdd":
      if (typeof context.token !== "string" || !/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(context.token)) {
        throw new Error("A valid Telegram bot token is required.");
      }
      return {
        command: await openclawExecutable(config),
        args: ["channels", "add", "--channel", "telegram", "--token", context.token],
        env,
        timeoutMs: 2 * 60_000,
        secrets: [context.token],
      };
    case "telegramDmPairing":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "channels.telegram.dmPolicy", "pairing"],
        env,
        timeoutMs: 30_000,
      };
    case "telegramGroupsDisabled":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "channels.telegram.groupPolicy", "disabled"],
        env,
        timeoutMs: 30_000,
      };
    case "whatsappPluginInstall":
      return {
        command: await openclawExecutable(config),
        args: ["plugins", "install", `clawhub:@openclaw/whatsapp@${OPENCLAW_VERSION}`, "--force"],
        env,
        timeoutMs: 10 * 60_000,
      };
    case "whatsappPluginEnable":
      return {
        command: await openclawExecutable(config),
        args: ["plugins", "enable", "whatsapp"],
        env,
        timeoutMs: 2 * 60_000,
      };
    case "pluginList":
      return {
        command: await openclawExecutable(config),
        args: ["plugins", "list", "--json"],
        env,
        timeoutMs: 30_000,
      };
    case "whatsappDmPairing":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "channels.whatsapp.dmPolicy", "pairing"],
        env,
        timeoutMs: 30_000,
      };
    case "whatsappGroupsDisabled":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "channels.whatsapp.groupPolicy", "disabled"],
        env,
        timeoutMs: 30_000,
      };
    case "whatsappLoginStart": {
      if (!gatewayToken) throw new Error("A gateway token is required to start WhatsApp linking.");
      return {
        command: await openclawExecutable(config),
        args: [
          "gateway",
          "call",
          "web.login.start",
          "--params",
          JSON.stringify({ timeoutMs: 30000 }),
          "--url",
          `ws://127.0.0.1:${GATEWAY_PORT}`,
          "--token",
          gatewayToken,
          "--timeout",
          "45000",
          "--json",
        ],
        env,
        timeoutMs: 50_000,
        secrets: gatewaySecrets,
        sensitiveOutput: true,
      };
    }
    case "whatsappLoginWait": {
      if (!gatewayToken) throw new Error("A gateway token is required while WhatsApp is linking.");
      if (!validQrDataUrl(context.currentQrDataUrl)) {
        throw new Error("The current WhatsApp QR image is invalid.");
      }
      return {
        command: await openclawExecutable(config),
        args: [
          "gateway",
          "call",
          "web.login.wait",
          "--params",
          JSON.stringify({ timeoutMs: 20000, currentQrDataUrl: context.currentQrDataUrl }),
          "--url",
          `ws://127.0.0.1:${GATEWAY_PORT}`,
          "--token",
          gatewayToken,
          "--timeout",
          "30000",
          "--json",
        ],
        env,
        timeoutMs: 35_000,
        secrets: [...gatewaySecrets, context.currentQrDataUrl],
        sensitiveOutput: true,
      };
    }
    case "gatewayRestart":
      return {
        command: await openclawExecutable(config),
        args: ["gateway", "restart"],
        env,
        timeoutMs: 2 * 60_000,
      };
    case "channelStatus":
      if (!channel) throw new Error("channel must be telegram or whatsapp.");
      return {
        command: await openclawExecutable(config),
        args: ["channels", "status", "--channel", channel, "--probe", "--json"],
        env,
        timeoutMs: 45_000,
      };
    case "pairingList":
      if (!channel) throw new Error("channel must be telegram or whatsapp.");
      return {
        command: await openclawExecutable(config),
        args: ["pairing", "list", channel, "--json"],
        env,
        timeoutMs: 30_000,
      };
    case "pairingApprove":
      if (!channel) throw new Error("channel must be telegram or whatsapp.");
      if (typeof context.code !== "string" || !/^[A-Za-z0-9-]{4,32}$/.test(context.code)) {
        throw new Error("A valid pairing code is required.");
      }
      return {
        command: await openclawExecutable(config),
        args: ["pairing", "approve", channel, context.code, "--notify"],
        env,
        timeoutMs: 30_000,
      };
    default:
      throw new Error(`Command action is not allowlisted: ${action}`);
  }
}

export class CommandRunner {
  constructor({ config, spawnImpl = spawn }) {
    this.config = config;
    this.spawnImpl = spawnImpl;
  }

  async prepare() {
    await fs.mkdir(this.config.downloadsDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.config.npmPrefix, { recursive: true, mode: 0o700 });
  }

  async run(action, context = {}) {
    const spec = await actionSpec(action, this.config, context);
    const sanitize = createSanitizer([...(context.secrets ?? []), ...(spec.secrets ?? [])]);

    if (context.signal?.aborted) throw new CommandCancelledError();

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const child = this.spawnImpl(spec.command, spec.args, {
        cwd: this.config.home,
        env: spec.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const buffers = { stdout: "", stderr: "" };
      const emitChunk = (source, chunk) => {
        const raw = chunk.toString("utf8");
        if (source === "stdout") stdout = (stdout + raw).slice(-MAX_CAPTURE_BYTES);
        else stderr = (stderr + raw).slice(-MAX_CAPTURE_BYTES);

        if (spec.sensitiveOutput) return;

        buffers[source] += raw;
        const lines = buffers[source].split(/[\r\n]+/);
        buffers[source] = lines.pop() ?? "";
        for (const line of lines) {
          const clean = sanitize(context.preserveWhitespace ? line.replace(/\s+$/, "") : line.trim());
          if (clean) context.onLine?.({ source, line: clean });
        }
      };

      child.stdout?.on("data", (chunk) => emitChunk("stdout", chunk));
      child.stderr?.on("data", (chunk) => emitChunk("stderr", chunk));

      let killTimer;
      const abort = () => {
        if (settled) return;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        killTimer.unref?.();
      };
      context.signal?.addEventListener("abort", abort, { once: true });

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        if (!settled) {
          settled = true;
          killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
          killTimer.unref?.();
          const error = new Error(`Allowlisted action timed out: ${action}`);
          error.code = "COMMAND_TIMEOUT";
          error.action = action;
          reject(error);
        }
      }, spec.timeoutMs);
      timeout.unref?.();

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(killTimer);
        context.signal?.removeEventListener("abort", abort);
        reject(error);
      });

      child.once("close", (code, signal) => {
        if (!spec.sensitiveOutput) {
          for (const source of ["stdout", "stderr"]) {
            const clean = sanitize(
              context.preserveWhitespace ? buffers[source].replace(/\s+$/, "") : buffers[source].trim(),
            );
            if (clean) context.onLine?.({ source, line: clean });
          }
        }
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(killTimer);
        context.signal?.removeEventListener("abort", abort);

        if (context.signal?.aborted) {
          reject(new CommandCancelledError());
          return;
        }
        if (code !== 0) {
          const detail = spec.sensitiveOutput ? "" : sanitize(stderr || stdout).trim().slice(-2_000);
          const error = new Error(
            `Allowlisted action ${action} failed (${signal ? `signal ${signal}` : `exit ${code}`})${detail ? `: ${detail}` : ""}`,
          );
          error.code = "COMMAND_FAILED";
          error.exitCode = code;
          error.action = action;
          reject(error);
          return;
        }
        resolve({
          code,
          stdout: spec.sensitiveOutput ? stdout : sanitize(stdout),
          stderr: spec.sensitiveOutput ? "" : sanitize(stderr),
        });
      });
    });
  }
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CommandCancelledError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new CommandCancelledError());
      },
      { once: true },
    );
  });
}

const DEMO_QR_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const DEMO_LINES = {
  prepareSystem: ["Checking Raspberry Pi OS packages", "System prerequisites are ready"],
  installOllamaArm64: [
    "Downloading Ollama for Linux arm64",
    "CLAWBOOT_DOWNLOAD ollama 0 1556004266",
    "CLAWBOOT_DOWNLOAD ollama 389001066 1556004266",
    "CLAWBOOT_DOWNLOAD ollama 1058082890 1556004266",
    "CLAWBOOT_DOWNLOAD ollama 1556004266 1556004266",
    "Ollama installed",
  ],
  ensureOllamaRuntime: ["Ollama runtime and llama-server are complete"],
  configureOllamaLoopback: ["Ollama enabled on 127.0.0.1:11434"],
  restartOllama: ["Ollama restarted and is ready on 127.0.0.1:11434"],
  ensureChromium: ["Chromium is ready at /usr/local/bin/clawboot-chromium"],
  ollamaVersion: ["ollama version 0.11.0"],
  ollamaRuntimeStatus: ["Ollama llama-server runtime is present"],
  pullModel: [
    `pulling manifest for ${MODEL_ID}`,
    "downloading model layers 24%",
    "downloading model layers 67%",
    "downloading model layers 100%",
    "verifying sha256 digest",
    "success",
  ],
  installOpenClaw: ["Installing OpenClaw without terminal onboarding", "OpenClaw installed"],
  openclawVersion: ["OpenClaw 2026.6.11"],
  onboardOpenClaw: [
    "Configured Ollama provider at http://127.0.0.1:11434",
    `Selected ollama/${MODEL_ID}`,
    "Gateway bound to loopback with token authentication",
    "OpenClaw service installed",
  ],
  openclawGatewayProbe: ['{"ok":true,"degraded":false,"capability":"read_only"}'],
  disableCloudMemorySearch: ["Disabled cloud-backed memory search"],
  configurePrimaryModel: [`Selected ollama/${MODEL_ID} as the primary model`],
  configureLocalModelDefaults: [`Disabled hidden thinking and capped context for ollama/${MODEL_ID}`],
  readToolsAllow: ["[]"],
  readToolsAlsoAllow: ["[]"],
  readToolsDeny: ['["group:web","browser"]'],
  readPluginsAllow: ['["telegram"]'],
  readPluginsDeny: ['["duckduckgo","browser","unrelated-plugin"]'],
  setPluginsAllow: ["Preserved existing plugins and enabled required assistant plugins"],
  setPluginsDeny: ["Removed required assistant plugins from the plugin deny list"],
  setToolsAllow: ["Updated the OpenClaw tool allowlist"],
  unsetToolsAllow: ["Removed the explicit OpenClaw tool allowlist"],
  setToolsAlsoAllow: ["Added the selected assistant tools"],
  unsetToolsAlsoAllow: ["Removed the additive OpenClaw tool list"],
  setToolsDeny: ["Updated the OpenClaw tool deny list"],
  enableDuckDuckGo: ["Enabled key-free DuckDuckGo web search"],
  configureWebSearch: ["Configured web search"],
  configureWebFetch: ["Configured web page reading"],
  enableBrowserPlugin: ["Enabled the OpenClaw browser plugin"],
  configureBrowser: ["Configured isolated Chromium automation"],
  disableBrowser: ["Disabled Chromium automation"],
  disableElevatedTools: ["Disabled elevated tools"],
  validateOpenClawConfig: ['{"valid":true}'],
  openclawDoctorFix: ["OpenClaw doctor applied safe noninteractive repairs"],
  openclawSecurityFix: ['{"fix":{"ok":true},"report":{"summary":{"critical":0}}}'],
  openclawSecurityDeep: ['{"summary":{"critical":1,"warning":1,"info":2},"findings":[{"checkId":"models.small_params","severity":"critical"}]}'],
  permissionChat: ["Applied chat-only messaging tool profile"],
  permissionGuardedProfile: ["Applied guarded coding tool profile"],
  permissionOpen: ["Applied the full Pi assistant tool profile"],
  permissionFilesystemRestricted: ["Restricted filesystem tools to the agent workspace"],
  permissionFilesystemFull: ["Enabled host-wide filesystem tools"],
  permissionApplyPatchRestricted: ["Restricted patching to the agent workspace"],
  permissionApplyPatchFull: ["Enabled patching outside the agent workspace"],
  permissionSandboxOff: ["Configured commands to run on the Raspberry Pi host"],
  permissionExecDeny: ["Disabled command execution"],
  permissionExecCautious: ["Configured command approvals"],
  permissionExecYolo: ["Configured no-prompt host command execution"],
  verifyAgentRoot: ["Verified passwordless sudo for the Full Pi assistant"],
  telegramAdd: ["Telegram bot configured"],
  telegramDmPairing: ["Telegram direct messages require pairing"],
  telegramGroupsDisabled: ["Telegram groups disabled by default"],
  whatsappPluginInstall: ["Installed the official OpenClaw WhatsApp plugin"],
  whatsappPluginEnable: ["Enabled the official OpenClaw WhatsApp plugin"],
  pluginList: ['{"plugins":[]}'],
  whatsappDmPairing: ["WhatsApp direct messages require pairing"],
  whatsappGroupsDisabled: ["WhatsApp groups disabled by default"],
  gatewayRestart: ["OpenClaw gateway restarted"],
  channelStatus: ['{"configured":true,"running":true,"probe":{"works":true}}'],
  pairingList: ['{"requests":[]}'],
  pairingApprove: ["Pairing approved and requester notified"],
};

export class DemoCommandRunner {
  constructor({ config }) {
    this.config = config;
    this.whatsappWaits = 0;
  }

  async prepare() {}

  async run(action, context = {}) {
    const model = selectedModel(context);
    let lines = DEMO_LINES[action];
    if (action === "pullModel") lines = [`pulling manifest for ${model.id}`, ...DEMO_LINES.pullModel.slice(1)];
    if (action === "onboardOpenClaw") {
      lines = [DEMO_LINES.onboardOpenClaw[0], `Selected ollama/${model.id}`, ...DEMO_LINES.onboardOpenClaw.slice(2)];
    }
    if (action === "configurePrimaryModel") lines = [`Selected ollama/${model.id} as the primary model`];
    if (action === "configureLocalModelDefaults") {
      lines = [`Disabled hidden thinking and capped context for ollama/${model.id}`];
    }
    if (action === "whatsappLoginStart") {
      lines = [JSON.stringify({ qrDataUrl: DEMO_QR_DATA_URL, message: "Scan this QR in WhatsApp linked devices." })];
    }
    if (action === "whatsappLoginWait") {
      this.whatsappWaits += 1;
      lines = [JSON.stringify({ connected: true, message: "WhatsApp is linked." })];
    }
    if (!lines) throw new Error(`Command action is not allowlisted: ${action}`);
    for (const line of lines) {
      await wait(this.config.demoDelayMs, context.signal);
      context.onLine?.({ source: "stdout", line });
    }
    return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  }
}
