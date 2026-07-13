import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initialState, StateStore } from "../../setupd/state.mjs";

test("Pi state is persisted and an in-flight job becomes resumable after restart", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");

  const first = new StateStore({ file, mode: "pi", persist: true });
  await first.init();
  await first.update((state) => {
    state.phase = "installing";
    state.activeJobId = "job-1";
    state.installation.model = "qwen3.5:4b";
    state.installation.permissionProfile = "open";
    state.installation.completedSteps.push("preflight", "system");
    state.jobs["job-1"] = {
      id: "job-1",
      status: "running",
      events: [],
    };
  });

  const second = new StateStore({ file, mode: "pi", persist: true });
  await second.init();
  const restored = second.snapshot();
  assert.equal(restored.installation.model, "qwen3.5:4b");
  assert.equal(restored.installation.permissionProfile, "open");
  assert.deepEqual(restored.installation.completedSteps, ["preflight", "system"]);
  assert.equal(restored.jobs["job-1"].status, "interrupted");
  assert.equal(restored.activeJobId, null);
  assert.equal(restored.phase, "ready");

  const stats = await fs.stat(file);
  assert.equal(stats.isFile(), true);
});

test("schema-1 state migrates legacy WhatsApp qrLines without losing valid v1.2 choices", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawboot-state-legacy-qr-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  const legacy = initialState("pi");
  legacy.installation.model = "qwen3.5:4b";
  legacy.installation.permissionProfile = "chat";
  legacy.channels.whatsapp = {
    status: "linking",
    account: null,
    qrLines: [" ▄▄▄ ", " █ █ "],
    error: null,
  };
  await fs.writeFile(file, `${JSON.stringify(legacy, null, 2)}\n`);

  const store = new StateStore({ file, mode: "pi", persist: true });
  await store.init();
  const migrated = store.snapshot();
  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.installation.model, "qwen3.5:4b");
  assert.equal(migrated.installation.permissionProfile, "open");
  assert.equal(migrated.channels.whatsapp.qrDataUrl, null);
  assert.equal(Object.hasOwn(migrated.channels.whatsapp, "qrLines"), false);
});

test("schema-1 normalization rejects unknown models, profiles, and unsafe QR payloads", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawboot-state-normalize-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  const unsafe = initialState("pi");
  unsafe.installation.model = "unknown:70b";
  unsafe.installation.permissionProfile = "root-shell";
  unsafe.channels.whatsapp.qrDataUrl = "data:image/svg+xml;base64,PHN2Zz4=";
  await fs.writeFile(file, `${JSON.stringify(unsafe, null, 2)}\n`);

  const store = new StateStore({ file, mode: "pi", persist: true });
  await store.init();
  const normalized = store.snapshot();
  assert.equal(normalized.installation.model, "qwen3.5:2b");
  assert.equal(normalized.installation.permissionProfile, "open");
  assert.equal(normalized.channels.whatsapp.qrDataUrl, null);
});
