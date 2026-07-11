import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore } from "../../setupd/state.mjs";

test("Pi state is persisted and an in-flight job becomes resumable after restart", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");

  const first = new StateStore({ file, mode: "pi", persist: true });
  await first.init();
  await first.update((state) => {
    state.phase = "installing";
    state.activeJobId = "job-1";
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
  assert.deepEqual(restored.installation.completedSteps, ["preflight", "system"]);
  assert.equal(restored.jobs["job-1"].status, "interrupted");
  assert.equal(restored.activeJobId, null);
  assert.equal(restored.phase, "ready");

  const stats = await fs.stat(file);
  assert.equal(stats.isFile(), true);
});

