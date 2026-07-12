import dns from "node:dns/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const GIB = 1024 ** 3;

async function readText(file) {
  try {
    return (await fs.readFile(file, "utf8")).replace(/\0/g, "").trim();
  } catch {
    return "";
  }
}

function parseOsRelease(raw) {
  const values = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  return values;
}

async function freeBytesFor(target) {
  let current = target;
  while (current && current !== path.dirname(current)) {
    try {
      const stats = await fs.statfs(current);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      current = path.dirname(current);
    }
  }
  try {
    const stats = await fs.statfs("/");
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function check(id, label, status, detail, value = null) {
  return { id, label, status, detail, value };
}

export async function inspectHost({ stateDir, skipNetwork = false } = {}) {
  const platform = process.platform;
  const architecture = os.arch();
  const deviceModel = await readText("/proc/device-tree/model");
  const osRelease = parseOsRelease(await readText("/etc/os-release"));
  const memoryBytes = os.totalmem();
  const freeDiskBytes = await freeBytesFor(stateDir ?? "/var/lib/clawboot");
  const pi5 = /Raspberry Pi 5/i.test(deviceModel);
  const arm64 = architecture === "arm64" || architecture === "aarch64";
  let online = null;

  if (!skipNetwork) {
    try {
      await Promise.race([
        dns.lookup("ollama.com"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("DNS timeout")), 3_000)),
      ]);
      online = true;
    } catch {
      online = false;
    }
  }

  const checks = [
    check(
      "device",
      "Raspberry Pi 5",
      pi5 ? "pass" : "fail",
      pi5 ? deviceModel : "This installer is intended for a Raspberry Pi 5.",
      deviceModel || "Unknown device",
    ),
    check(
      "architecture",
      "64-bit ARM OS",
      arm64 ? "pass" : "fail",
      arm64 ? `${architecture} architecture detected.` : `Expected arm64, found ${architecture}.`,
      architecture,
    ),
    check(
      "operating-system",
      "Linux operating system",
      platform === "linux" ? "pass" : "fail",
      platform === "linux"
        ? `${osRelease.PRETTY_NAME ?? "Linux"} detected.`
        : `Expected Linux, found ${platform}.`,
      osRelease.PRETTY_NAME ?? platform,
    ),
    check(
      "memory",
      "Memory",
      memoryBytes >= 7 * GIB ? (memoryBytes >= 14 * GIB ? "pass" : "warn") : "fail",
      memoryBytes >= 14 * GIB
        ? "Plenty of memory for the local model and OpenClaw."
        : memoryBytes >= 7 * GIB
          ? "8 GB is enough for the selected 2B model and OpenClaw."
          : "At least 8 GB RAM is required for the supported local setup.",
      memoryBytes,
    ),
    check(
      "disk",
      "Free storage",
      freeDiskBytes == null ? "warn" : freeDiskBytes >= 12 * GIB ? "pass" : "fail",
      freeDiskBytes == null
        ? "Free storage could not be measured."
        : freeDiskBytes >= 12 * GIB
          ? "At least 12 GB is available for Ollama, Qwen, OpenClaw, and working data."
          : "At least 12 GB of free storage is required; an SSD is strongly recommended.",
      freeDiskBytes,
    ),
    check(
      "network",
      "Internet connection",
      online == null ? "warn" : online ? "pass" : "fail",
      online == null
        ? "Network check skipped."
        : online
          ? "Download hosts resolve successfully."
          : "Could not resolve ollama.com. Check Ethernet, Wi-Fi, and DNS.",
      online,
    ),
  ];

  return {
    platform,
    architecture,
    deviceModel: deviceModel || null,
    pi5,
    arm64,
    os: osRelease,
    memoryBytes,
    freeDiskBytes,
    online,
    checks,
    compatible: pi5 && arm64 && platform === "linux" && memoryBytes >= 7 * GIB && (freeDiskBytes == null || freeDiskBytes >= 12 * GIB),
  };
}

export function runtimeMode(host, forceDemo = null) {
  if (forceDemo === true) return "demo";
  if (forceDemo === false) return "pi";
  return host.pi5 && host.arm64 && host.platform === "linux" ? "pi" : "demo";
}
