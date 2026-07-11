#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createSetupService } from "./service.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultStatic = path.resolve(here, "..", "dist", "client");
const staticDir = argument("--static") ?? process.env.OPENCLAW_SETUP_STATIC_DIR ?? defaultStatic;
const port = Number(argument("--port") ?? process.env.OPENCLAW_SETUP_PORT ?? 3210);
const host = argument("--host") ?? process.env.OPENCLAW_SETUP_HOST ?? "127.0.0.1";

const service = await createSetupService({ config: { staticDir, port, host } });
await service.listen();

const address = service.server.address();
const shownHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
console.log(`ClawBoot is running in ${service.mode} mode at http://${shownHost}:${address.port}`);

async function shutdown(signal) {
  console.log(`Received ${signal}; stopping setup service.`);
  await service.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
