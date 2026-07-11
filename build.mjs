import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const output = path.join(root, "dist");
const cli = path.join(root, "node_modules", "vinext", "dist", "cli.js");

await rm(output, { recursive: true, force: true });

const result = spawnSync(process.execPath, [cli, "build"], {
  cwd: root,
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? ".wrangler/wrangler.log",
  },
  stdio: "inherit",
});

if (result.status === 0) process.exit(0);

// vinext 0.0.50 can hit a libuv teardown assertion on Windows after it has
// successfully finished static prerendering. Accept only a freshly generated,
// product-specific static output; every other non-zero exit remains a failure.
if (process.platform === "win32") {
  const index = path.join(output, "client", "index.html");
  try {
    await access(index);
    const html = await readFile(index, "utf8");
    if (html.includes("ClawBoot") && html.includes("Check your Raspberry Pi")) {
      console.warn("Validated the completed static build after a Windows vinext shutdown error.");
      process.exit(0);
    }
  } catch {
    // Fall through to the original build status.
  }
}

process.exit(result.status ?? 1);
