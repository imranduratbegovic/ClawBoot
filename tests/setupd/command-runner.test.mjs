import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CommandRunner } from "../../setupd/command-runner.mjs";
import { makeConfig } from "../../setupd/config.mjs";

function fakeSpawner(calls, output = "ok\n") {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end(output);
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  };
}

test("runner uses fixed argv with shell disabled and rejects unknown actions", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runner-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  const config = makeConfig({
    stateDir: directory,
    home: directory,
    downloadsDir: path.join(directory, "downloads"),
    npmPrefix: path.join(directory, "npm"),
  });
  const runner = new CommandRunner({ config, spawnImpl: fakeSpawner(calls) });
  await runner.prepare();
  await runner.run("ollamaVersion");

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["--version"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.stdio[0], "ignore");
  await assert.rejects(() => runner.run("totally-arbitrary-shell"), /not allowlisted/);
  assert.equal(calls.length, 1);
});

test("fixed install actions validate 2B and 4B models and configure the computer assistant", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-actions-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  const config = makeConfig({
    stateDir: directory,
    home: directory,
    downloadsDir: path.join(directory, "downloads"),
    npmPrefix: path.join(directory, "npm"),
  });
  const runner = new CommandRunner({ config, spawnImpl: fakeSpawner(calls) });
  await runner.prepare();

  await runner.run("pullModel", { model: "qwen3.5:2b" });
  await runner.run("pullModel", { model: "qwen3.5:4b" });
  await runner.run("installOpenClaw");
  await runner.run("configurePrimaryModel", { model: "qwen3.5:4b" });
  await runner.run("configureLocalModelDefaults", { model: "qwen3.5:4b" });
  await runner.run("configureWebSearch");
  await runner.run("configureWebFetch");
  await runner.run("configureBrowser");
  await runner.run("permissionFilesystemFull");
  await runner.run("permissionApplyPatchFull");
  await runner.run("permissionExecYolo");
  await runner.run("verifyAgentRoot");
  await runner.run("setToolsDeny", { tools: [] });

  assert.deepEqual(calls[0].args, ["pull", "qwen3.5:2b"]);
  assert.deepEqual(calls[1].args, ["pull", "qwen3.5:4b"]);
  assert.deepEqual(calls[2].args, [
    "install",
    "--global",
    "--prefix",
    config.npmPrefix,
    "--no-audit",
    "--no-fund",
    "--loglevel=warn",
    "openclaw@2026.6.11",
  ]);
  assert.deepEqual(calls[3].args, ["config", "set", "agents.defaults.model.primary", '"ollama/qwen3.5:4b"', "--strict-json"]);
  assert.deepEqual(calls[4].args, [
    "config",
    "set",
    "agents.defaults.models",
    '{"ollama/qwen3.5:4b":{"params":{"thinking":false,"num_ctx":4096,"keep_alive":"5m"}}}',
    "--strict-json",
    "--merge",
  ]);
  assert.deepEqual(calls[5].args.slice(0, 3), ["config", "set", "tools.web.search"]);
  assert.match(calls[5].args[3], /"provider":"duckduckgo"/);
  assert.deepEqual(calls[7].args.slice(0, 3), ["config", "set", "browser"]);
  assert.match(calls[7].args[3], /"executablePath":"\/usr\/local\/bin\/clawboot-chromium"/);
  assert.match(calls[7].args[3], /"noSandbox":false/);
  assert.deepEqual(calls[8].args, ["config", "set", "tools.fs.workspaceOnly", "false", "--strict-json"]);
  assert.deepEqual(calls[9].args, ["config", "set", "tools.exec.applyPatch.workspaceOnly", "false", "--strict-json"]);
  assert.deepEqual(calls[10].args, ["exec-policy", "preset", "yolo"]);
  assert.deepEqual(calls[11].args, ["-n", "/usr/bin/true"]);
  assert.deepEqual(calls[12].args, ["config", "set", "tools.deny", "[]", "--strict-json"]);
  assert.equal(calls.every((call) => call.options.shell === false), true);

  const count = calls.length;
  await assert.rejects(() => runner.run("pullModel", { model: "anything:latest" }), /not supported/);
  assert.equal(calls.length, count);
});

test("WhatsApp login uses bounded gateway RPC JSON and never emits the QR credential", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawboot-whatsapp-rpc-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const gatewayToken = "gateway-token-for-whatsapp-rpc-123456";
  const qr = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const calls = [];
  const lines = [];
  const config = makeConfig({ stateDir: directory, home: directory, downloadsDir: path.join(directory, "downloads"), npmPrefix: path.join(directory, "npm") });
  const runner = new CommandRunner({ config, spawnImpl: fakeSpawner(calls, `${JSON.stringify({ qrDataUrl: qr })}\n`) });
  await runner.prepare();

  const start = await runner.run("whatsappLoginStart", { gatewayToken, onLine: ({ line }) => lines.push(line) });
  await runner.run("whatsappLoginWait", { gatewayToken, currentQrDataUrl: qr, onLine: ({ line }) => lines.push(line) });

  assert.deepEqual(calls[0].args.slice(0, 4), ["gateway", "call", "web.login.start", "--params"]);
  assert.equal(calls[0].args.includes("ws://127.0.0.1:18789"), true);
  assert.equal(calls[0].args.includes(gatewayToken), true);
  assert.deepEqual(calls[1].args.slice(0, 4), ["gateway", "call", "web.login.wait", "--params"]);
  assert.match(calls[1].args[4], /currentQrDataUrl/);
  assert.equal(start.stdout.includes(qr), true);
  assert.deepEqual(lines, []);
  await assert.rejects(
    () => runner.run("whatsappLoginWait", { gatewayToken, currentQrDataUrl: "data:text/html;base64,AAAA" }),
    /invalid/,
  );
});

test("full access and plugin policy actions use fixed validated config arguments", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawboot-full-policy-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  const config = makeConfig({ stateDir: directory, home: directory, downloadsDir: path.join(directory, "downloads"), npmPrefix: path.join(directory, "npm") });
  const runner = new CommandRunner({ config, spawnImpl: fakeSpawner(calls, "{}\n") });
  await runner.prepare();

  await runner.run("permissionOpen");
  await runner.run("readPluginsAllow");
  await runner.run("readPluginsDeny");
  await runner.run("setPluginsAllow", { tools: ["telegram", "duckduckgo", "browser"] });
  await runner.run("setPluginsDeny", { tools: [] });

  assert.deepEqual(calls[0].args, ["config", "set", "tools.profile", "full"]);
  assert.deepEqual(calls[1].args, ["config", "get", "plugins.allow", "--json"]);
  assert.deepEqual(calls[2].args, ["config", "get", "plugins.deny", "--json"]);
  assert.deepEqual(calls[3].args, ["config", "set", "plugins.allow", '["telegram","duckduckgo","browser"]', "--strict-json"]);
  assert.deepEqual(calls[4].args, ["config", "set", "plugins.deny", "[]", "--strict-json"]);
  const count = calls.length;
  await assert.rejects(() => runner.run("setPluginsAllow", { tools: ["bad plugin id"] }), /invalid tool list/);
  assert.equal(calls.length, count);
});

test("gateway checks use the generated token without exposing it", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-token-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const token = "gateway-token-that-must-never-leak-456";
  const calls = [];
  const lines = [];
  const config = makeConfig({
    stateDir: directory,
    home: directory,
    downloadsDir: path.join(directory, "downloads"),
    npmPrefix: path.join(directory, "npm"),
  });
  const runner = new CommandRunner({ config, spawnImpl: fakeSpawner(calls, `token=${token}\n`) });
  await runner.prepare();

  for (const action of ["openclawGatewayProbe", "openclawSecurityDeep"]) {
    await runner.run(action, { gatewayToken: token, onLine: ({ line }) => lines.push(line) });
  }

  assert.deepEqual(calls[0].args.slice(-2), ["--token", token]);
  assert.deepEqual(calls[1].args.slice(-2), ["--token", token]);
  assert.doesNotMatch(lines.join("\n"), new RegExp(token));
  assert.match(lines.join("\n"), /\[REDACTED\]/);
});

test("runner strips generated gateway tokens before emitting command output", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-redact-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const token = "gateway-token-that-must-never-leak-123";
  const calls = [];
  const config = makeConfig({
    stateDir: directory,
    home: directory,
    downloadsDir: path.join(directory, "downloads"),
    npmPrefix: path.join(directory, "npm"),
  });
  const lines = [];
  const runner = new CommandRunner({ config, spawnImpl: fakeSpawner(calls, `saved token=${token}\n`) });
  await runner.prepare();
  await runner.run("onboardOpenClaw", {
    gatewayToken: token,
    secrets: [token],
    onLine: ({ line }) => lines.push(line),
  });

  assert.equal(lines.join("\n").includes(token), false);
  assert.match(lines.join("\n"), /\[REDACTED\]/);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].args.includes("--non-interactive"), true);
  assert.equal(calls[0].args.includes("--skip-skills"), true);
  assert.equal(calls[0].args.includes("--skip-hooks"), true);
  assert.deepEqual(
    calls[0].args.slice(calls[0].args.indexOf("--custom-model-id"), calls[0].args.indexOf("--custom-model-id") + 2),
    ["--custom-model-id", "qwen3.5:2b"],
  );
  assert.deepEqual(
    calls[0].args.slice(calls[0].args.indexOf("--gateway-bind"), calls[0].args.indexOf("--gateway-bind") + 2),
    ["--gateway-bind", "loopback"],
  );
});

test("channel actions use fixed argv and redact Telegram credentials", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawboot-channels-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const token = "123456789:abcdefghijklmnopqrstuvwxyz_ABCDE";
  const calls = [];
  const lines = [];
  const config = makeConfig({ stateDir: directory, home: directory, downloadsDir: path.join(directory, "downloads"), npmPrefix: path.join(directory, "npm") });
  const runner = new CommandRunner({ config, spawnImpl: fakeSpawner(calls, `configured ${token}\n`) });
  await runner.prepare();

  await runner.run("telegramAdd", { token, secrets: [token], onLine: ({ line }) => lines.push(line) });
  await runner.run("channelStatus", { channel: "telegram" });
  await runner.run("pairingApprove", { channel: "telegram", code: "ABCD-1234" });
  await runner.run("whatsappPluginInstall");
  await runner.run("whatsappPluginEnable");

  assert.deepEqual(calls[0].args, ["channels", "add", "--channel", "telegram", "--token", token]);
  assert.deepEqual(calls[1].args, ["channels", "status", "--channel", "telegram", "--probe", "--json"]);
  assert.deepEqual(calls[2].args, ["pairing", "approve", "telegram", "ABCD-1234", "--notify"]);
  assert.deepEqual(calls[3].args, ["plugins", "install", "clawhub:@openclaw/whatsapp@2026.6.11", "--force"]);
  assert.deepEqual(calls[4].args, ["plugins", "enable", "whatsapp"]);
  assert.equal(calls.every((call) => call.options.shell === false), true);
  assert.doesNotMatch(lines.join("\n"), new RegExp(token));
});
