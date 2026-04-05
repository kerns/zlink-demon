#!/usr/bin/env node
// zlink-demon — monitors a workspace for new links and generates traffic
// Single-file daemon with logUpdate UI (same pattern as hitmaker)

import readline from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import logUpdate from "log-update";
import chalk from "chalk";
// ---------------------------------------------------------------------------
// Hitmaker – treated as an external dependency (not bundled).
// We dynamically import its modules so we can show a friendly install message
// instead of crashing if it isn't installed.
// ---------------------------------------------------------------------------

let TrafficSimulator;
let getHitmakerConfig;
let HITMAKER_CLI;

async function loadHitmaker() {
  try {
    const simMod = await import("hitmaker/simulator");
    const cfgMod = await import("hitmaker/config");
    TrafficSimulator = simMod.TrafficSimulator;
    getHitmakerConfig = cfgMod.getConfig;

    const require = createRequire(import.meta.url);
    HITMAKER_CLI = require.resolve("hitmaker");
    return true;
  } catch {
    return false;
  }
}

function printHitmakerMissing() {
  console.error("");
  console.error(chalk.red.bold("  hitmaker is not installed"));
  console.error("");
  console.error(chalk.white("  zlink-demon requires hitmaker to generate traffic."));
  console.error(chalk.white("  Install it with one of the following commands:"));
  console.error("");
  console.error(chalk.cyan("    npm install -g hitmaker"));
  console.error(chalk.cyan("    pnpm add -g hitmaker"));
  console.error(chalk.cyan("    bun add -g hitmaker"));
  console.error("");
  console.error(chalk.dim("  Or install locally in this project:"));
  console.error("");
  console.error(chalk.cyan("    npm install hitmaker"));
  console.error(chalk.cyan("    pnpm add hitmaker"));
  console.error(chalk.cyan("    bun add hitmaker"));
  console.error("");
  process.exit(1);
}

// ============================================================================
// Config & Storage
// ============================================================================

const DATA_DIR = join(homedir(), ".zlink-demon");
const KEYS_FILE = join(DATA_DIR, "keys.json");

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
}

function loadKeys() {
  try {
    return JSON.parse(readFileSync(KEYS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveKeys(keys) {
  ensureDataDir();
  writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
}

function pad(str, width) {
  const s = String(str);
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

// ============================================================================
// API helpers
// ============================================================================

async function apiRequest(apiUrl, path, apiKey, workspaceSlug = null) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (workspaceSlug) headers["X-Workspace"] = workspaceSlug;
  const res = await fetch(`${apiUrl}${path}`, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

const API_ENVIRONMENTS = [
  { name: "dev", url: "https://dev-api.zeblink.io/api" },
  { name: "prod", url: "https://api.zeblink.io/api" },
];

// ============================================================================
// Traffic Pool
// ============================================================================

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPool() {
  const simulators = new Map();
  let isRunning = false;
  let totalHits = 0;
  let totalErrors = 0;
  let phase = "waiting"; // waiting | active | idle
  let phaseRate = 0;
  let phaseEnd = 0;

  async function addUrl(shortLink) {
    if (simulators.has(shortLink)) return;
    const sim = new TrafficSimulator(shortLink, getHitmakerConfig());
    await sim.proxyPool.init();
    simulators.set(shortLink, sim);
  }

  async function start() {
    isRunning = true;

    while (isRunning) {
      // Re-read config each phase so hitmaker config changes take effect
      const cfg = getHitmakerConfig();
      for (const sim of simulators.values()) {
        sim.config = { ...sim.config, ...cfg };
      }

      if (simulators.size === 0) {
        phase = "waiting";
        await sleep(1000);
        continue;
      }

      const rate = randInt(cfg.MIN_PER_MIN, cfg.MAX_PER_MIN);
      const activeMinutes = randInt(cfg.MIN_ACTIVE, cfg.MAX_ACTIVE);
      phaseEnd = Date.now() + activeMinutes * 60_000;
      phase = "active";
      phaseRate = rate;

      while (Date.now() < phaseEnd && isRunning) {
        if (simulators.size === 0) { await sleep(1000); continue; }
        const entries = Array.from(simulators.values());
        const sim = entries[Math.floor(Math.random() * entries.length)];
        const hitStart = Date.now();
        try {
          const result = await sim.doHit(1);
          totalHits++;
          if (!result.success) totalErrors++;
        } catch { totalErrors++; }
        // Subtract the time doHit took so we maintain the target rate
        const hitDuration = Date.now() - hitStart;
        const intervalMs = 60_000 / rate;
        const jitter = intervalMs * (Math.random() * 0.2 - 0.1);
        const remaining = intervalMs + jitter - hitDuration;
        await sleep(Math.max(50, remaining));
      }

      if (Math.random() < cfg.IDLE_ODDS && isRunning) {
        const idleMinutes = randInt(cfg.MIN_IDLE, cfg.MAX_IDLE);
        phaseEnd = Date.now() + idleMinutes * 60_000;
        phase = "idle";
        phaseRate = 0;
        while (Date.now() < phaseEnd && isRunning) await sleep(1000);
      }
    }
  }

  function stop() { isRunning = false; }

  function getStats() {
    const perUrl = {};
    for (const [url, sim] of simulators) {
      const s = sim.getStats();
      perUrl[url] = { hits: s.hitCounter, uniqueIps: s.uniqueIps };
    }
    const phaseRemaining = Math.max(0, Math.ceil((phaseEnd - Date.now()) / 60_000));
    return { totalHits, totalErrors, urlCount: simulators.size, perUrl, phase, phaseRate, phaseRemaining };
  }

  return { addUrl, start, stop, getStats };
}

// ============================================================================
// Poller
// ============================================================================

function createPoller(apiUrl, apiKey, workspaceSlugs) {
  const seenIds = new Set();
  const timestamps = {};
  for (const slug of workspaceSlugs) timestamps[slug] = new Date().toISOString();

  async function poll() {
    const newLinks = [];
    for (const slug of workspaceSlugs) {
      try {
        const params = new URLSearchParams({
          createdAfter: timestamps[slug], sortBy: "createdAt", sortOrder: "asc", limit: "100",
        });
        const body = await apiRequest(apiUrl, `/links?${params}`, apiKey, slug);
        const links = body.data || [];
        for (const link of links) {
          if (seenIds.has(link.id)) continue;
          seenIds.add(link.id);
          newLinks.push({ id: link.id, shortLink: link.shortLink, workspace: slug });
        }
        if (links.length > 0) timestamps[slug] = links[links.length - 1].createdAt;
      } catch {}
    }
    return newLinks;
  }

  return { poll, getSeenCount: () => seenIds.size };
}

// ============================================================================
// UI State Machine
// ============================================================================

// States: key_select, key_input, key_validating, key_label, workspace_select, mode_select, duration_select, running
let state = "key_select";
let textInput = "";
let cursor = 0;
let statusMessage = "";
let errorMessage = "";

// Config
let apiUrl = null;
let apiKey = null;
let userInfo = null;
let selectedWorkspaces = [];
let includeExisting = false;
let timeoutMinutes = 0;

// Key selection
let pendingKeyEntry = null; // holds key entry during label step
let pendingDelete = false; // true when waiting for D confirmation
const savedKeys = loadKeys();
const keyChoices = () => [
  ...savedKeys.map((k) => ({ label: k.label, env: k.env, value: k })),
  { label: "+ Add new API key", env: "", value: null },
];

// Workspace selection
let workspaceChoices = [];
let wsSelected = new Set();

// Mode
const MODES = [
  { label: "New links only", value: false },
  { label: "All links (existing + new)", value: true },
];

// Duration
const DURATIONS = [
  { label: "5 minutes", value: 5 },
  { label: "15 minutes", value: 15 },
  { label: "30 minutes", value: 30 },
  { label: "1 hour", value: 60 },
  { label: "3 hours", value: 180 },
  { label: "6 hours", value: 360 },
  { label: "24 hours", value: 1440 },
  { label: "Indefinitely", value: 0 },
];

// Running state
let pool = null;
let poller = null;
let logs = [];
let startTime = null;
let timeoutTimer = null;
let renderIntervalId = null;

function addLog(msg) {
  logs.push(msg);
  if (logs.length > 50) logs.shift();
}

// ============================================================================
// Hitmaker update + config editor
// ============================================================================

// Resolve the zlink-demon package directory for running pnpm commands
const DEMON_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

let hitmakerConfigOpen = false;

/**
 * Update hitmaker to the latest version. Detects whether hitmaker was
 * installed locally (in this project) or globally, and runs the
 * appropriate update command. Re-execs the daemon afterward so the
 * new code is loaded (Node caches modules in memory).
 */
function updateHitmaker() {
  if (hitmakerConfigOpen) return;
  hitmakerConfigOpen = true;

  if (renderIntervalId) clearInterval(renderIntervalId);
  logUpdate.clear();

  process.stdin.removeListener("keypress", handleKeypress);
  process.stdin.setRawMode(false);
  process.stdin.pause();

  // Detect if hitmaker is installed locally or globally
  const localHitmaker = existsSync(join(DEMON_DIR, "node_modules", "hitmaker"));
  const updateArgs = localHitmaker
    ? ["update", "hitmaker"]
    : ["add", "-g", "hitmaker@latest"];
  const updateCwd = localHitmaker ? DEMON_DIR : undefined;

  console.log(chalk.cyan(`\n  Updating hitmaker (${localHitmaker ? "local" : "global"})...\n`));

  const child = spawn("pnpm", updateArgs, {
    cwd: updateCwd,
    stdio: "inherit",
  });

  child.on("close", (code) => {
    if (code === 0) {
      console.log(chalk.green("\n  Updated. Restarting...\n"));
      // Re-exec this process with the same arguments so the new code loads
      setTimeout(() => {
        process.stdin.setRawMode(false);
        spawn(process.execPath, process.argv.slice(1), {
          cwd: process.cwd(),
          stdio: "inherit",
          detached: false,
        }).on("close", (c) => process.exit(c));
      }, 500);
    } else {
      console.log(chalk.red(`\n  Update failed (exit ${code})\n`));
      hitmakerConfigOpen = false;
      process.stdin.resume();
      process.stdin.setRawMode(true);
      process.stdin.on("keypress", handleKeypress);
      if (state === "running") {
        renderIntervalId = setInterval(render, 1000);
      }
      render();
    }
  });

  child.on("error", (err) => {
    console.log(chalk.red(`\n  Update error: ${err.message}\n`));
    hitmakerConfigOpen = false;
    process.stdin.resume();
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", handleKeypress);
    if (state === "running") {
      renderIntervalId = setInterval(render, 1000);
    }
    render();
  });
}

/**
 * Fully suspend the demon's TUI and hand the terminal to hitmaker's config
 * editor. We must: stop the render interval (prevents logUpdate writes),
 * pause stdin (stops the parent's readline from consuming keystrokes that
 * belong to the child), and drop raw mode so the child can set it up fresh.
 * On exit, everything is restored and the demon resumes.
 */
function openHitmakerConfig() {
  if (hitmakerConfigOpen) return;
  hitmakerConfigOpen = true;

  // Stop our render loop so logUpdate doesn't fight the child's output
  if (renderIntervalId) clearInterval(renderIntervalId);
  logUpdate.clear();

  // Detach our keypress listener and pause stdin so the child process
  // gets exclusive access to the terminal input
  process.stdin.removeListener("keypress", handleKeypress);
  process.stdin.setRawMode(false);
  process.stdin.pause();

  const child = spawn(process.execPath, [HITMAKER_CLI, "--config"], {
    stdio: "inherit",
  });

  function restore() {
    hitmakerConfigOpen = false;
    process.stdin.resume();
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", handleKeypress);
    if (state === "running") {
      renderIntervalId = setInterval(render, 1000);
    }
    render();
  }

  child.on("close", restore);
  child.on("error", (err) => {
    addLog(`Config editor error: ${err.message}`);
    restore();
  });
}

// ============================================================================
// Renderers
// ============================================================================

function renderHeader() {
  return chalk.bgMagenta.white.bold(" 😈 ZLINK-DEMON ") + chalk.dim("  v0.1.0");
}

function renderKeySelect() {
  const lines = ["", renderHeader(), ""];
  const choices = keyChoices();

  lines.push(chalk.bold("  Select an API key"));
  lines.push("");

  choices.forEach((c, i) => {
    const prefix = i === cursor ? chalk.cyan("  ❯ ") : "    ";
    const envTag = c.env ? chalk.dim(` (${c.env})`) : "";
    if (i === cursor) {
      lines.push(prefix + chalk.white(c.label) + envTag);
    } else {
      lines.push(prefix + chalk.gray(c.label) + envTag);
    }
  });

  lines.push("");
  if (pendingDelete && statusMessage) lines.push(chalk.yellow(`  ${statusMessage}`));
  else if (errorMessage) lines.push(chalk.red(`  ${errorMessage}`));
  lines.push("");
  lines.push("  " + chalk.white("↑/↓") + chalk.gray(" Navigate") + "  " + chalk.white("Enter") + chalk.gray(" Select") + "  " + chalk.white("D") + chalk.gray(" Remove"));
  lines.push("  " + chalk.white("C") + chalk.gray(" Config") + "  " + chalk.white("U") + chalk.gray(" Update Hitmaker") + "  " + chalk.white("Q") + chalk.gray(" Quit"));
  lines.push("");
  return lines.join("\n");
}

function renderKeyInput() {
  const lines = ["", renderHeader(), ""];
  lines.push(chalk.bold("  Paste an API key"));
  lines.push("");
  lines.push("  " + chalk.bgGray.white(` ${textInput || " "}_ `));
  lines.push("");
  if (statusMessage) lines.push(chalk.dim(`  ${statusMessage}`));
  if (errorMessage) lines.push(chalk.red(`  ${errorMessage}`));
  lines.push("");
  lines.push("  " + chalk.white("Enter") + chalk.gray(" Validate") + "  " + chalk.white("Esc") + chalk.gray(" Back"));
  lines.push("");
  return lines.join("\n");
}

function renderValidating() {
  const lines = ["", renderHeader(), ""];
  lines.push("");
  lines.push(chalk.dim(`  ${statusMessage || "Validating..."}`));
  lines.push("");
  return lines.join("\n");
}

function renderKeyLabel() {
  const lines = ["", renderHeader(), ""];
  lines.push(chalk.green("  ✓ Key validated") + chalk.dim(` — ${pendingKeyEntry?.label || ""}`));
  lines.push("");
  lines.push(chalk.bold("  Add a label or note?") + chalk.dim(" (optional)"));
  lines.push("");
  lines.push("  " + chalk.bgGray.white(` ${textInput || " "}_ `));
  lines.push("");
  lines.push("  " + chalk.white("Enter") + chalk.gray(" Save") + "  " + chalk.white("Esc") + chalk.gray(" Skip (use default)"));
  lines.push("");
  return lines.join("\n");
}

function renderWorkspaceSelect() {
  const lines = ["", renderHeader(), ""];
  lines.push(chalk.bold("  Select workspace(s)"));
  lines.push("");

  workspaceChoices.forEach((ws, i) => {
    const prefix = i === cursor ? chalk.cyan("  ❯ ") : "    ";
    const check = wsSelected.has(i) ? chalk.green("✓") : chalk.dim("○");
    if (i === cursor) {
      lines.push(prefix + check + " " + chalk.white(ws.name) + chalk.dim(` (${ws.slug})`));
    } else {
      lines.push(prefix + check + " " + chalk.gray(ws.name) + chalk.dim(` (${ws.slug})`));
    }
  });

  lines.push("");
  lines.push("  " + chalk.white("↑/↓") + chalk.gray(" Navigate") + "  " + chalk.white("Space") + chalk.gray(" Toggle") + "  " + chalk.white("Enter") + chalk.gray(" Confirm") + "  " + chalk.white("A") + chalk.gray(" All"));
  lines.push("");
  return lines.join("\n");
}

function renderModeSelect() {
  const lines = ["", renderHeader(), ""];
  lines.push(chalk.bold("  Include existing links?"));
  lines.push("");

  MODES.forEach((m, i) => {
    const prefix = i === cursor ? chalk.cyan("  ❯ ") : "    ";
    if (i === cursor) {
      lines.push(prefix + chalk.white(m.label));
    } else {
      lines.push(prefix + chalk.gray(m.label));
    }
  });

  lines.push("");
  lines.push("  " + chalk.white("↑/↓") + chalk.gray(" Navigate") + "  " + chalk.white("Enter") + chalk.gray(" Select"));
  lines.push("");
  return lines.join("\n");
}

function renderDurationSelect() {
  const lines = ["", renderHeader(), ""];
  lines.push(chalk.bold("  How long should it run?"));
  lines.push("");

  DURATIONS.forEach((d, i) => {
    const prefix = i === cursor ? chalk.cyan("  ❯ ") : "    ";
    if (i === cursor) {
      lines.push(prefix + chalk.white(d.label));
    } else {
      lines.push(prefix + chalk.gray(d.label));
    }
  });

  lines.push("");
  lines.push("  " + chalk.white("↑/↓") + chalk.gray(" Navigate") + "  " + chalk.white("Enter") + chalk.gray(" Select"));
  lines.push("");
  return lines.join("\n");
}

function renderRunning() {
  const stats = pool ? pool.getStats() : { totalHits: 0, totalErrors: 0, urlCount: 0, perUrl: {}, phase: "starting", phaseRate: 0, phaseRemaining: 0 };
  const lines = ["", renderHeader()];

  // Status bar
  const elapsed = startTime ? Math.floor((Date.now() - startTime) / 60_000) : 0;
  const remaining = timeoutMinutes > 0 ? Math.max(0, timeoutMinutes - elapsed) : null;
  const timeLabel = remaining !== null ? `${remaining}min left` : `${elapsed}min elapsed`;

  const modeLabel = includeExisting ? chalk.magenta("all") : chalk.dim("new");
  const phaseIcon = stats.phase === "active" ? chalk.green("●") : stats.phase === "idle" ? chalk.yellow("○") : chalk.gray("◌");
  const phaseLabel = stats.phase === "active"
    ? chalk.green(`Active ~${stats.phaseRate}/min (${stats.phaseRemaining}min)`)
    : stats.phase === "idle"
      ? chalk.yellow(`Idle (${stats.phaseRemaining}min)`)
      : chalk.gray("Waiting for links...");

  lines.push(
    chalk.gray(`  ${phaseIcon} ${phaseLabel}`) +
    chalk.gray(` │ Mode: `) + modeLabel +
    chalk.gray(` │ URLs: ${stats.urlCount}`) +
    chalk.gray(` │ Hits: ${stats.totalHits}`) +
    (stats.totalErrors > 0 ? chalk.red(` │ Err: ${stats.totalErrors}`) : "") +
    chalk.gray(` │ ${timeLabel}`),
  );

  // Per-URL table
  lines.push("");
  if (stats.urlCount > 0) {
    lines.push(
      chalk.gray("  ") +
      chalk.gray(pad("URL", 35)) +
      chalk.gray(pad("HITS", 8)) +
      chalk.gray("IPs"),
    );
    lines.push(chalk.gray("  " + "─".repeat(55)));

    for (const [url, s] of Object.entries(stats.perUrl)) {
      const shortUrl = url.replace(/^https?:\/\//, "").slice(0, 33);
      lines.push(
        "  " +
        chalk.blue(pad(shortUrl, 35)) +
        chalk.yellow(pad(s.hits, 8)) +
        chalk.gray(s.uniqueIps),
      );
    }
  } else {
    lines.push(chalk.gray("  Waiting for new links to appear..."));
  }

  // Recent logs
  lines.push("");
  lines.push(chalk.gray("  " + "─".repeat(55)));
  const recentLogs = logs.slice(-4);
  for (const log of recentLogs) {
    lines.push(chalk.gray(`  ${log.slice(0, 70)}`));
  }
  if (recentLogs.length === 0) {
    lines.push(chalk.gray("  Polling for new links every 5s..."));
  }

  // Active hitmaker config summary
  const hmConfig = getHitmakerConfig();
  lines.push(chalk.gray("  " + "─".repeat(55)));
  const proxyLabel = { none: "off", free: "free", url: "list", service: "paid" }[hmConfig.PROXY_MODE] || hmConfig.PROXY_MODE;
  lines.push(
    chalk.gray("  ") + chalk.dim("Config: ") +
    chalk.dim(`${hmConfig.MIN_PER_MIN}–${hmConfig.MAX_PER_MIN}/min`) +
    chalk.dim(` │ active ${hmConfig.MIN_ACTIVE}–${hmConfig.MAX_ACTIVE}m`) +
    chalk.dim(` │ idle ${hmConfig.MIN_IDLE}–${hmConfig.MAX_IDLE}m @${(hmConfig.IDLE_ODDS * 100).toFixed(0)}%`) +
    chalk.dim(` │ proxy: ${proxyLabel}`),
  );

  lines.push("");
  lines.push("  " + chalk.white("C") + chalk.gray(" Config") + "  " + chalk.white("Q") + chalk.gray(" Quit"));
  lines.push("");
  return lines.join("\n");
}

function render() {
  switch (state) {
    case "key_select": logUpdate(renderKeySelect()); break;
    case "key_input": logUpdate(renderKeyInput()); break;
    case "key_validating": logUpdate(renderValidating()); break;
    case "key_label": logUpdate(renderKeyLabel()); break;
    case "workspace_select": logUpdate(renderWorkspaceSelect()); break;
    case "mode_select": logUpdate(renderModeSelect()); break;
    case "duration_select": logUpdate(renderDurationSelect()); break;
    case "running": logUpdate(renderRunning()); break;
  }
}

// ============================================================================
// State transitions
// ============================================================================

async function validateAndProceed(key) {
  state = "key_validating";
  errorMessage = "";

  for (const env of API_ENVIRONMENTS) {
    statusMessage = `Trying ${env.name}...`;
    render();

    try {
      userInfo = await apiRequest(env.url, "/me", key);
      apiUrl = env.url;
      apiKey = key;

      // Prepare entry and prompt for optional label
      const userName = userInfo.name || userInfo.email.split("@")[0];
      const defaultLabel = `${userName} (${env.name})`;
      pendingKeyEntry = { label: defaultLabel, key, email: userInfo.email, env: env.name, apiUrl };
      textInput = "";
      state = "key_label";
      render();
      return;
    } catch {
      // Try next env
    }
  }

  errorMessage = "Key not valid on dev or prod";
  state = "key_input";
  render();
}

function savePendingKey() {
  if (!pendingKeyEntry) return;
  // If user typed a custom label, use it; otherwise keep the default
  if (textInput.trim()) {
    pendingKeyEntry.label = textInput.trim();
  }
  const keys = loadKeys();
  const existing = keys.findIndex((k) => k.key === pendingKeyEntry.key);
  if (existing >= 0) keys[existing] = pendingKeyEntry;
  else keys.push(pendingKeyEntry);
  saveKeys(keys);

  // Reload savedKeys
  savedKeys.length = 0;
  savedKeys.push(...loadKeys());
  pendingKeyEntry = null;
  textInput = "";
}

async function validateStoredKey(stored) {
  state = "key_validating";
  statusMessage = `Validating on ${stored.env}...`;
  errorMessage = "";
  render();

  try {
    userInfo = await apiRequest(stored.apiUrl, "/me", stored.key);
    apiUrl = stored.apiUrl;
    apiKey = stored.key;
    transitionToWorkspaceSelect();
  } catch {
    errorMessage = "Key expired or invalid. Delete it and add a new one.";
    state = "key_select";
    render();
  }
}

function transitionToWorkspaceSelect() {
  workspaceChoices = userInfo.workspaces || [];
  wsSelected.clear();

  if (workspaceChoices.length === 0) {
    errorMessage = "No workspaces found";
    state = "key_select";
    render();
    return;
  }

  if (workspaceChoices.length === 1) {
    // Auto-select single workspace
    wsSelected.add(0);
    selectedWorkspaces = [workspaceChoices[0]];
    cursor = 0;
    state = "mode_select";
    render();
    return;
  }

  cursor = 0;
  state = "workspace_select";
  render();
}

function startDaemon() {
  const workspaceSlugs = selectedWorkspaces.map((ws) => ws.slug);

  logUpdate.clear();
  state = "running";
  startTime = Date.now();

  poller = createPoller(apiUrl, apiKey, workspaceSlugs);
  pool = createPool();

  // Suppress doHit console output (we show stats in our dashboard instead)
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args) => {
    const msg = args.join(" ");
    // Capture simulator output as logs but don't print
    if (msg.includes("W1 ") || msg.includes("[pool]")) {
      addLog(msg.slice(0, 100));
      return;
    }
    origLog(...args);
  };
  console.warn = (...args) => {
    addLog(args.join(" ").slice(0, 100));
  };

  // Seed pool with existing links if requested
  if (includeExisting) {
    (async () => {
      for (const ws of selectedWorkspaces) {
        try {
          addLog(`Fetching existing links for ${ws.slug}...`);
          const params = new URLSearchParams({ sortBy: "createdAt", sortOrder: "desc", limit: "100" });
          const body = await apiRequest(apiUrl, `/links?${params}`, apiKey, ws.slug);
          const links = body.data || [];
          for (const link of links) {
            let url = link.shortLink;
            if (apiUrl === API_ENVIRONMENTS[0].url && url.startsWith("https://")) {
              url = url.replace("https://", "http://");
            }
            await pool.addUrl(url);
          }
          addLog(`Loaded ${links.length} existing links from ${ws.slug}`);
        } catch (err) {
          addLog(`Failed to fetch existing links for ${ws.slug}: ${err.message}`);
        }
      }
    })();
  }

  pool.start().catch((err) => addLog(`Pool error: ${err.message}`));

  // Timeout
  if (timeoutMinutes > 0) {
    timeoutTimer = setTimeout(() => {
      addLog("Timeout reached");
      shutdown();
    }, timeoutMinutes * 60_000);
  }

  // Poll loop
  async function pollLoop() {
    while (state === "running") {
      try {
        const newLinks = await poller.poll();
        for (const link of newLinks) {
          let url = link.shortLink;
          // Dev environment doesn't run HTTPS — downgrade short links
          if (apiUrl === API_ENVIRONMENTS[0].url && url.startsWith("https://")) {
            url = url.replace("https://", "http://");
          }
          addLog(`NEW: ${url} (${link.workspace})`);
          await pool.addUrl(url);
        }
      } catch (err) {
        addLog(`Poll error: ${err.message}`);
      }
      await sleep(5000);
    }
  }
  pollLoop();

  // Render loop
  renderIntervalId = setInterval(render, 1000);
  render();
}

function shutdown() {
  if (pool) pool.stop();
  if (timeoutTimer) clearTimeout(timeoutTimer);

  logUpdate.clear();
  const stats = pool ? pool.getStats() : { totalHits: 0, totalErrors: 0, urlCount: 0, perUrl: {} };
  const elapsed = startTime ? Math.floor((Date.now() - startTime) / 60_000) : 0;

  console.log();
  console.log(chalk.bold("  Summary") + chalk.dim(` (${elapsed} min)`));
  console.log(`  Total hits:   ${stats.totalHits}`);
  console.log(`  Total errors: ${stats.totalErrors}`);
  console.log(`  URLs tracked: ${stats.urlCount}`);
  console.log(`  Links seen:   ${poller ? poller.getSeenCount() : 0}`);

  if (Object.keys(stats.perUrl).length > 0) {
    console.log();
    for (const [url, s] of Object.entries(stats.perUrl)) {
      const shortUrl = url.replace(/^https?:\/\//, "");
      console.log(chalk.dim(`  ${shortUrl}`) + ` — ${s.hits} hits, ${s.uniqueIps} unique IPs`);
    }
  }
  console.log();
  process.exit(0);
}

// ============================================================================
// Keyboard handler (one handler, state-based routing)
// ============================================================================

function handleKeypress(str, key) {
  if (key.name === "c" && key.ctrl) {
    if (state === "running") shutdown();
    else process.exit(0);
  }

  switch (state) {
    case "key_select": {
      const choices = keyChoices();
      if (key.name === "up") {
        cursor = (cursor - 1 + choices.length) % choices.length;
        pendingDelete = false;
      } else if (key.name === "down") {
        cursor = (cursor + 1) % choices.length;
        pendingDelete = false;
      } else if (key.name === "return") {
        pendingDelete = false;
        const choice = choices[cursor];
        if (choice.value === null) {
          // Add new key
          textInput = "";
          errorMessage = "";
          state = "key_input";
        } else {
          validateStoredKey(choice.value);
          return; // async — will render when done
        }
      } else if (str === "d" || str === "D") {
        const choice = choices[cursor];
        if (choice.value) {
          if (!pendingDelete) {
            // First press — ask for confirmation
            pendingDelete = true;
            statusMessage = `Press D again to remove "${choice.label}"`;
          } else {
            // Second press — delete
            pendingDelete = false;
            statusMessage = "";
            const keys = loadKeys();
            const idx = keys.findIndex((k) => k.key === choice.value.key);
            if (idx >= 0) {
              keys.splice(idx, 1);
              saveKeys(keys);
              savedKeys.length = 0;
              savedKeys.push(...keys);
              if (cursor >= keyChoices().length) cursor = Math.max(0, keyChoices().length - 1);
            }
          }
        }
      } else if (str === "c" || str === "C") {
        pendingDelete = false;
        openHitmakerConfig();
        return;
      } else if (str === "u" || str === "U") {
        updateHitmaker();
        return;
      } else if (str === "q" || str === "Q") {
        process.exit(0);
      }
      render();
      break;
    }

    case "key_input": {
      if (key.name === "escape") {
        cursor = 0;
        state = "key_select";
        errorMessage = "";
      } else if (key.name === "return") {
        if (textInput.trim()) {
          validateAndProceed(textInput.trim());
          return; // async
        }
      } else if (key.name === "backspace") {
        textInput = textInput.slice(0, -1);
      } else if (str && !key.ctrl && !key.meta && str.length === 1) {
        textInput += str;
      }
      render();
      break;
    }

    case "key_label": {
      if (key.name === "return" || key.name === "escape") {
        // Enter saves with custom label (or default if empty); Esc skips (uses default)
        savePendingKey();
        transitionToWorkspaceSelect();
        return;
      } else if (key.name === "backspace") {
        textInput = textInput.slice(0, -1);
      } else if (str && !key.ctrl && !key.meta && str.length === 1) {
        textInput += str;
      }
      render();
      break;
    }

    case "workspace_select": {
      if (key.name === "up") {
        cursor = (cursor - 1 + workspaceChoices.length) % workspaceChoices.length;
      } else if (key.name === "down") {
        cursor = (cursor + 1) % workspaceChoices.length;
      } else if (str === " ") {
        if (wsSelected.has(cursor)) wsSelected.delete(cursor);
        else wsSelected.add(cursor);
      } else if (str === "a" || str === "A") {
        if (wsSelected.size === workspaceChoices.length) wsSelected.clear();
        else workspaceChoices.forEach((_, i) => wsSelected.add(i));
      } else if (key.name === "return") {
        if (wsSelected.size === 0) wsSelected.add(cursor);
        selectedWorkspaces = Array.from(wsSelected).map((i) => workspaceChoices[i]);
        cursor = 0;
        state = "mode_select";
      }
      render();
      break;
    }

    case "mode_select": {
      if (key.name === "up") {
        cursor = (cursor - 1 + MODES.length) % MODES.length;
      } else if (key.name === "down") {
        cursor = (cursor + 1) % MODES.length;
      } else if (key.name === "return") {
        includeExisting = MODES[cursor].value;
        cursor = 3; // default 30 min
        state = "duration_select";
      }
      render();
      break;
    }

    case "duration_select": {
      if (key.name === "up") {
        cursor = (cursor - 1 + DURATIONS.length) % DURATIONS.length;
      } else if (key.name === "down") {
        cursor = (cursor + 1) % DURATIONS.length;
      } else if (key.name === "return") {
        timeoutMinutes = DURATIONS[cursor].value;
        startDaemon();
        return;
      }
      render();
      break;
    }

    case "running": {
      if (str === "c" || str === "C") {
        openHitmakerConfig();
        return;
      } else if (str === "q" || str === "Q") {
        shutdown();
      }
      break;
    }
  }
}

// ============================================================================
// Entry point
// ============================================================================

// Boot: ensure hitmaker is available, then start the TUI
(async () => {
  const hitmakerOk = await loadHitmaker();
  if (!hitmakerOk) printHitmakerMissing();

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", handleKeypress);
  } else {
    console.error("zlink-demon requires a terminal (TTY)");
    process.exit(1);
  }

  // Handle no saved keys — go straight to key input
  if (savedKeys.length === 0) {
    state = "key_input";
    textInput = "";
  }

  render();
})();
