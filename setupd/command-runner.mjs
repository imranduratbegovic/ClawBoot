import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { MODEL_ID, OLLAMA_BASE_URL } from "./config.mjs";
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
        args: ["pull", MODEL_ID],
        env,
        timeoutMs: 90 * 60_000,
      };
    case "downloadOpenClawInstaller":
      return {
        command: await executable(["/usr/bin/curl", "/usr/local/bin/curl"]),
        args: [
          "--fail",
          "--show-error",
          "--location",
          "--proto",
          "=https",
          "--tlsv1.2",
          "--output",
          config.openclawInstaller,
          "https://openclaw.ai/install.sh",
        ],
        env,
        timeoutMs: 2 * 60_000,
      };
    case "installOpenClaw":
      return {
        command: "/bin/bash",
        args: [config.openclawInstaller, "--no-prompt", "--no-onboard", "--verify"],
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
          MODEL_ID,
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
    case "openclawGatewayStatus":
      return {
        command: await openclawExecutable(config),
        args: [
          "gateway",
          "status",
          "--require-rpc",
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
    case "denySmallModelWebTools":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "tools.deny", '["group:web","browser"]', "--strict-json"],
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
    case "permissionGuardedFilesystem":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "tools.fs.workspaceOnly", "true"],
        env,
        timeoutMs: 30_000,
      };
    case "permissionGuardedExecAsk":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "tools.exec.ask", "always"],
        env,
        timeoutMs: 30_000,
      };
    case "permissionGuardedExecSecurity":
      return {
        command: await openclawExecutable(config),
        args: ["config", "set", "tools.exec.security", "allowlist"],
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
        args: ["plugins", "install", "clawhub:@openclaw/whatsapp"],
        env,
        timeoutMs: 10 * 60_000,
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
    case "whatsappLogin":
      return {
        command: await openclawExecutable(config),
        args: ["channels", "login", "--channel", "whatsapp"],
        env: { ...env, TERM: "xterm-256color" },
        timeoutMs: 5 * 60_000,
      };
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
        for (const source of ["stdout", "stderr"]) {
          const clean = sanitize(
            context.preserveWhitespace ? buffers[source].replace(/\s+$/, "") : buffers[source].trim(),
          );
          if (clean) context.onLine?.({ source, line: clean });
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
          const detail = sanitize(stderr || stdout).trim().slice(-2_000);
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
          stdout: sanitize(stdout),
          stderr: sanitize(stderr),
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
  configureOllamaLoopback: ["Ollama enabled on 127.0.0.1:11434"],
  restartOllama: ["Ollama restarted and is ready on 127.0.0.1:11434"],
  ollamaVersion: ["ollama version 0.11.0"],
  pullModel: [
    `pulling manifest for ${MODEL_ID}`,
    "downloading model layers 24%",
    "downloading model layers 67%",
    "downloading model layers 100%",
    "verifying sha256 digest",
    "success",
  ],
  downloadOpenClawInstaller: ["Downloaded the official OpenClaw installer"],
  installOpenClaw: ["Installing OpenClaw without terminal onboarding", "OpenClaw installed"],
  openclawVersion: ["OpenClaw 2026.7.0"],
  onboardOpenClaw: [
    "Configured Ollama provider at http://127.0.0.1:11434",
    `Selected ollama/${MODEL_ID}`,
    "Gateway bound to loopback with token authentication",
    "OpenClaw service installed",
  ],
  openclawGatewayStatus: ['{"service":{"running":true},"rpc":{"ok":true}}'],
  disableCloudMemorySearch: ["Disabled cloud-backed memory search"],
  denySmallModelWebTools: ["Denied web and browser tools for the local small model"],
  disableElevatedTools: ["Disabled elevated tools"],
  validateOpenClawConfig: ['{"valid":true}'],
  openclawDoctorFix: ["OpenClaw doctor applied safe noninteractive repairs"],
  openclawSecurityFix: ['{"fix":{"ok":true},"report":{"summary":{"critical":0}}}'],
  openclawSecurityDeep: ['{"summary":{"critical":0,"warning":1,"info":2}}'],
  permissionChat: ["Applied chat-only messaging tool profile"],
  permissionGuardedProfile: ["Applied guarded coding tool profile"],
  permissionGuardedFilesystem: ["Restricted filesystem tools to the agent workspace"],
  permissionGuardedExecAsk: ["Configured command approval for every execution"],
  permissionGuardedExecSecurity: ["Restricted command execution to the allowlist"],
  permissionOpen: ["Applied unrestricted tool profile"],
  telegramAdd: ["Telegram bot configured"],
  telegramDmPairing: ["Telegram direct messages require pairing"],
  telegramGroupsDisabled: ["Telegram groups disabled by default"],
  whatsappPluginInstall: ["Installed the official OpenClaw WhatsApp plugin"],
  pluginList: ['{"plugins":[]}'],
  whatsappDmPairing: ["WhatsApp direct messages require pairing"],
  whatsappGroupsDisabled: ["WhatsApp groups disabled by default"],
  whatsappLogin: [
    "██████████████████████",
    "██ ▄▄▄▄▄ █▀█ ▄▄▄▄▄ ██",
    "██ █   █ █▄█ █   █ ██",
    "██ █▄▄▄█ ▄▀▄ █▄▄▄█ ██",
    "██▄▄▄▄▄▄▄█▄█▄▄▄▄▄▄▄██",
    "WhatsApp account linked",
  ],
  gatewayRestart: ["OpenClaw gateway restarted"],
  channelStatus: ['{"configured":true,"running":true,"probe":{"works":true}}'],
  pairingList: ['{"requests":[]}'],
  pairingApprove: ["Pairing approved and requester notified"],
};

export class DemoCommandRunner {
  constructor({ config }) {
    this.config = config;
  }

  async prepare() {}

  async run(action, context = {}) {
    const lines = DEMO_LINES[action];
    if (!lines) throw new Error(`Command action is not allowlisted: ${action}`);
    for (const line of lines) {
      await wait(this.config.demoDelayMs, context.signal);
      context.onLine?.({ source: "stdout", line });
    }
    return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  }
}
