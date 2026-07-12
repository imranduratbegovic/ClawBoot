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

test("fixed install actions use the requested Gemma tag and noninteractive OpenClaw flags", async (t) => {
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

  await runner.run("pullModel");
  await runner.run("installOpenClaw");
  await runner.run("openclawDoctorFix");
  await runner.run("openclawSecurityFix");
  await runner.run("openclawSecurityDeep");
  await runner.run("openclawGatewayStatus");
  await runner.run("disableCloudMemorySearch");
  await runner.run("denySmallModelWebTools");
  await runner.run("disableElevatedTools");
  await runner.run("validateOpenClawConfig");

  assert.deepEqual(calls[0].args, ["pull", "gemma4:e2b-it-qat"]);
  assert.deepEqual(calls[1].args.slice(-3), ["--no-prompt", "--no-onboard", "--verify"]);
  assert.deepEqual(calls[2].args, ["doctor", "--fix", "--non-interactive"]);
  assert.deepEqual(calls[3].args, ["security", "audit", "--fix", "--json"]);
  assert.deepEqual(calls[4].args, ["security", "audit", "--deep", "--json"]);
  assert.deepEqual(calls[5].args, ["gateway", "status", "--require-rpc", "--json"]);
  assert.deepEqual(calls[6].args, ["config", "set", "agents.defaults.memorySearch.enabled", "false", "--strict-json"]);
  assert.deepEqual(calls[7].args, ["config", "set", "tools.deny", '["group:web","browser"]', "--strict-json"]);
  assert.deepEqual(calls[8].args, ["config", "set", "tools.elevated.enabled", "false", "--strict-json"]);
  assert.deepEqual(calls[9].args, ["config", "validate", "--json"]);
  assert.equal(calls.every((call) => call.options.shell === false), true);
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

  for (const action of ["openclawGatewayStatus", "openclawSecurityDeep"]) {
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
    ["--custom-model-id", "gemma4:e2b-it-qat"],
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

  assert.deepEqual(calls[0].args, ["channels", "add", "--channel", "telegram", "--token", token]);
  assert.deepEqual(calls[1].args, ["channels", "status", "--channel", "telegram", "--probe", "--json"]);
  assert.deepEqual(calls[2].args, ["pairing", "approve", "telegram", "ABCD-1234", "--notify"]);
  assert.equal(calls.every((call) => call.options.shell === false), true);
  assert.doesNotMatch(lines.join("\n"), new RegExp(token));
});
