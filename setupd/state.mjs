import fs from "node:fs/promises";
import path from "node:path";
import { MODEL_ID } from "./config.mjs";

const MAX_EVENTS_PER_JOB = 600;

export function initialState(mode = "demo") {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    mode,
    phase: "ready",
    activeJobId: null,
    installation: {
      model: MODEL_ID,
      permissionProfile: "guarded",
      completedSteps: [],
      ollamaInstalled: false,
      modelInstalled: false,
      openclawInstalled: false,
      agentConfigured: false,
      gatewayRunning: false,
      securityBaseline: 0,
      completedAt: null,
    },
    channels: {
      telegram: {
        status: "not_configured",
        bot: null,
        error: null,
      },
      whatsapp: {
        status: "not_configured",
        account: null,
        qrLines: [],
        error: null,
      },
    },
    jobs: {},
    secrets: {},
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeState(value, mode) {
  const base = initialState(mode);
  if (!value || value.schemaVersion !== 1 || typeof value !== "object") return base;

  return {
    ...base,
    ...value,
    mode,
    installation: { ...base.installation, ...(value.installation ?? {}) },
    channels: {
      telegram: { ...base.channels.telegram, ...(value.channels?.telegram ?? {}) },
      whatsapp: { ...base.channels.whatsapp, ...(value.channels?.whatsapp ?? {}) },
    },
    jobs: value.jobs && typeof value.jobs === "object" ? value.jobs : {},
    secrets: value.secrets && typeof value.secrets === "object" ? value.secrets : {},
  };
}

export class StateStore {
  constructor({ file, mode = "demo", persist = mode === "pi" }) {
    this.file = file;
    this.mode = mode;
    this.persist = persist;
    this.data = initialState(mode);
    this.writeChain = Promise.resolve();
  }

  async init() {
    if (!this.persist) return this.data;

    try {
      const raw = await fs.readFile(this.file, "utf8");
      this.data = normalizeState(JSON.parse(raw), this.mode);
      if (this.data.activeJobId) {
        const job = this.data.jobs[this.data.activeJobId];
        if (job && ["queued", "running", "cancelling"].includes(job.status)) {
          job.status = "interrupted";
          job.error = "Setup was interrupted by a service restart. Start installation again to resume.";
          job.finishedAt = new Date().toISOString();
        }
        this.data.activeJobId = null;
        if (this.data.phase === "installing") this.data.phase = "ready";
        await this.save();
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        if (!(error instanceof SyntaxError)) throw error;
        const corrupt = `${this.file}.corrupt-${Date.now()}`;
        await fs.rename(this.file, corrupt).catch(() => {});
        this.data = initialState(this.mode);
      }
      await this.save();
    }
    return this.data;
  }

  snapshot() {
    return structuredClone(this.data);
  }

  async update(mutator) {
    let result;
    this.writeChain = this.writeChain.then(async () => {
      result = await mutator(this.data);
      this.data.updatedAt = new Date().toISOString();
      if (this.persist) await this.#writeAtomic();
    });
    await this.writeChain;
    return result;
  }

  async save() {
    this.data.updatedAt = new Date().toISOString();
    if (this.persist) await this.#writeAtomic();
  }

  async #writeAtomic() {
    const directory = path.dirname(this.file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, this.file);
    await fs.chmod(this.file, 0o600).catch(() => {});
  }
}

export function appendJobEvent(job, event) {
  job.events ??= [];
  job.nextEventId = Number(job.nextEventId ?? 1);
  const entry = {
    id: job.nextEventId++,
    at: new Date().toISOString(),
    ...event,
  };
  job.events.push(entry);
  if (job.events.length > MAX_EVENTS_PER_JOB) {
    job.events.splice(0, job.events.length - MAX_EVENTS_PER_JOB);
  }
  return entry;
}
