// Run dmSlayer on this computer: `npm run local`.
//
// 1. Creates .dev.vars (your local secrets file) on first run, with a random owner token.
// 2. Builds / updates the local database.
// 3. Starts the app at https://localhost:8787 (HTTPS because Instagram refuses to send a login
//    back to a plain http:// address).
// 4. Stands in for Cloudflare's cron: asks the app to check Instagram once a minute and to renew
//    the Instagram token once a day. Locally nothing else would trigger those.
//
// Keep this window open while you want DMs to go out. Ctrl+C stops everything.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 8787;
const ORIGIN = `https://localhost:${PORT}`;
const varsPath = path.join(root, ".dev.vars");
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");

if (!existsSync(wrangler)) {
  console.error("Dependencies are missing. Run `npm install` first.");
  process.exit(1);
}

// ---- 1. secrets file ----
if (!existsSync(varsPath)) {
  writeFileSync(
    varsPath,
    [
      "# dmSlayer local secrets. This file is gitignored — never share or commit it.",
      "",
      "# From your Meta app: Use cases -> Customize -> API setup with Instagram login.",
      "# Use the INSTAGRAM app ID / INSTAGRAM app secret (not the pair under App settings -> Basic).",
      "# Newer Meta apps (\"Unified login\"): use the App ID / App secret from App settings -> Basic",
      "# instead, and set CONFIG_ID to the configuration id from Use cases -> Customize.",
      "CONFIG_ID=",
      "APP_ID=PASTE-INSTAGRAM-APP-ID",
      "APP_SECRET=PASTE-INSTAGRAM-APP-SECRET",
      "",
      "# Password for your own dashboard. Generated for you.",
      `OWNER_TOKEN=${randomBytes(24).toString("hex")}`,
      `WEBHOOK_VERIFY_TOKEN=${randomBytes(16).toString("hex")}`,
      "",
      "# How often to check Instagram for new comments, in seconds (minimum 5).",
      "POLL_INTERVAL_SECONDS=5",
      "POLL_FLOOR_SECONDS=5",
      "",
      "# Where Instagram sends you back after login. Register this exact URL in your Meta app.",
      `REDIRECT_URI=https://lvh.me:${PORT}/auth/callback`,
      "",
    ].join("\n"),
  );
  console.log("Created .dev.vars with a fresh owner token.");
}
const vars = Object.fromEntries(
  readFileSync(varsPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^"|"$/g, "")]),
);
const metaReady = vars.APP_ID && !vars.APP_ID.startsWith("PASTE") && vars.APP_SECRET && !vars.APP_SECRET.startsWith("PASTE");

// ---- 2. database ----
const mig = spawnSync(process.execPath, [wrangler, "d1", "migrations", "apply", "dmslayer", "--local"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, CI: "1" }, // non-interactive: apply without a confirmation prompt
});
if (mig.status !== 0) {
  console.error("Database setup failed:\n" + mig.stdout + mig.stderr);
  process.exit(1);
}

// ---- 3. the app ----
const dev = spawn(
  process.execPath,
  [wrangler, "dev", "--local-protocol", "https", "--port", String(PORT), "--ip", "127.0.0.1", "--show-interactive-dev-session=false"],
  { cwd: root, stdio: ["ignore", "inherit", "inherit"] },
);
dev.on("exit", (code) => process.exit(code ?? 0));
const stop = () => dev.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// ---- 4. the stand-in cron ----
/** Fire a cron handler on the local app. The certificate is self-signed, and this only ever talks to 127.0.0.1. */
function fireCron(cron) {
  return new Promise((resolve) => {
    const req = https.get(
      { host: "127.0.0.1", port: PORT, path: `/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(cron)}`, rejectUnauthorized: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode === 200));
      },
    );
    req.setTimeout(55_000, () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

async function waitUntilUp() {
  for (let i = 0; i < 120; i++) {
    const ok = await new Promise((resolve) => {
      const req = https.get({ host: "127.0.0.1", port: PORT, path: "/health", rejectUnauthorized: false }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

if (await waitUntilUp()) {
  console.log("\n────────────────────────────────────────────────────────────");
  console.log(" dmSlayer is running.");
  console.log(` Open:  ${ORIGIN}/#token=${vars.OWNER_TOKEN}`);
  console.log(" (Your browser will warn about the certificate once — choose Advanced -> Proceed.)");
  if (!metaReady) {
    console.log("\n Instagram is NOT connected yet: put your Instagram app ID and secret");
    console.log(" in .dev.vars, then stop (Ctrl+C) and run `npm run local` again.");
  }
  console.log("────────────────────────────────────────────────────────────\n");

  // Tick often; the app itself decides whether a check is due (POLL_INTERVAL_SECONDS in .dev.vars).
  let lastRefresh = 0;
  let busy = false;
  const tick = async () => {
    if (busy) return; // the previous check is still sending
    busy = true;
    try {
      await fireCron("* * * * *");
      if (Date.now() - lastRefresh > 24 * 3600 * 1000) {
        if (await fireCron("0 3 * * *")) lastRefresh = Date.now();
      }
    } finally {
      busy = false;
    }
  };
  tick();
  setInterval(tick, 2_000);
} else {
  console.error("The app did not start. Check the messages above.");
  stop();
}
